import type { Commit, Conversation, DiscussionComment, DraftComment, FileViewedState, GitHubReview, MentionUser, PullRequest, PullRequestSummary, ReviewSubmission, ViewedFiles } from "../shared/types";
import { runCommand, type RunCommand } from "./commands";
import { hideWhitespace } from "../shared/hideWhitespace";
import { stackPosition, type StackPullRequest } from "./prStack";

/** GitHub operations use gh's existing credentials, never browser tokens. */
export class GitHub {
  constructor(private run: RunCommand = runCommand) {}

  /** Match the two useful review queues, ordered by most recently updated. */
  async dashboard(view: string): Promise<PullRequestSummary[]> {
    const filter = view === "requested" ? "--review-requested" : "--author";
    return JSON.parse(await this.run(["gh", "search", "prs", filter, "@me", "--state", "open", "--sort", "updated", "--order", "desc", "--limit", "100", "--json", "number,title,url,repository,author,isDraft,updatedAt"]));
  }

  /** Search GitHub's repository-specific mention list, including users beyond collaborators. */
  async mentionUsers(repo: string, number: string, search: string): Promise<MentionUser[]> {
    pullEndpoint(repo, number);
    if (search.length > 100) throw new Error("Mention search is too long");
    const [owner, name] = repo.split("/");
    const query = `query($owner: String!, $name: String!, $search: String!) {
      repository(owner: $owner, name: $name) {
        mentionableUsers(first: 20, query: $search) { nodes { login name } }
      }
    }`;
    const result: { data: { repository: { mentionableUsers: { nodes: MentionUser[] } } | null } } = JSON.parse(await this.run([
      "gh", "api", "graphql", "-f", `query=${query}`, "-f", `owner=${owner}`, "-f", `name=${name}`, "-f", `search=${search}`,
    ]));
    if (!result.data.repository) throw new Error("Repository is unavailable");
    return result.data.repository.mentionableUsers.nodes;
  }

  /**
   * Read the authenticated user's viewed marks across all changed files.
   *
   * gh follows pageInfo using the endCursor variable, including PRs with over 100 files.
   */
  async viewedFiles(repo: string, number: string): Promise<ViewedFiles> {
    pullEndpoint(repo, number);
    const [owner, name] = repo.split("/");
    const query = `query($owner: String!, $name: String!, $number: Int!, $endCursor: String) {
      repository(owner: $owner, name: $name) {
        pullRequest(number: $number) {
          files(first: 100, after: $endCursor) {
            nodes { path viewerViewedState }
            pageInfo { hasNextPage endCursor }
          }
        }
      }
    }`;
    const pages: { data: { repository: { pullRequest: { files: { nodes: { path: string; viewerViewedState: FileViewedState }[] } } } } }[] = JSON.parse(await this.run([
      "gh", "api", "graphql", "--paginate", "--slurp", "-f", `query=${query}`,
      "-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `number=${number}`,
    ]));
    return { files: Object.fromEntries(pages.flatMap((page) => page.data.repository.pullRequest.files.nodes.map((file) => [file.path, file.viewerViewedState]))) };
  }

  /** Change GitHub's personal Viewed mark rather than publishing a review. */
  async setFileViewed(repo: string, number: string, path: string, viewed: boolean) {
    const pr = await this.get<{ node_id: string }>(pullEndpoint(repo, number));
    const action = viewed ? "markFileAsViewed" : "unmarkFileAsViewed";
    const query = `mutation($pullRequestId: ID!, $path: String!) {
      ${action}(input: { pullRequestId: $pullRequestId, path: $path }) { clientMutationId }
    }`;
    await this.run(["gh", "api", "graphql", "-f", `query=${query}`, "-f", `pullRequestId=${pr.node_id}`, "-f", `path=${path}`]);
    return { state: viewed ? "VIEWED" as const : "UNVIEWED" as const };
  }

  /** Read inline comments to recover publication receipts after an interrupted local save. */
  async inlineComments(repo: string, number: string): Promise<DiscussionComment[]> {
    return this.pages<DiscussionComment>(`${pullEndpoint(repo, number)}/comments`);
  }

  /** Read PR lifecycle state without downloading its diff. */
  async pullRequest(repo: string, number: string): Promise<PullRequest> {
    return this.get<PullRequest>(pullEndpoint(repo, number));
  }

  /** Pin diffs to SHAs so a concurrent push cannot mismatch line-comment coordinates. */
  async review(repo: string, number: string, commit: string): Promise<GitHubReview> {
    const endpoint = pullEndpoint(repo, number);
    const [pr, commits] = await Promise.all([this.get<PullRequest>(endpoint), this.pages<Commit>(`${endpoint}/commits`)]);
    if (commit !== "all" && !commits.some((entry) => entry.sha === commit)) throw new Error("That commit is not in this PR. Refresh the commit list.");
    const diffEndpoint = commit === "all" ? `repos/${repo}/compare/${pr.base.sha}...${pr.head.sha}` : `repos/${repo}/commits/${commit}`;
    const patch = await this.run(["gh", "api", diffEndpoint, "-H", "Accept: application/vnd.github.diff"]);
    return { pr, commits, patch: hideWhitespace(patch), commit };
  }

  /** Load stack metadata separately so repository-wide lookup cannot delay the diff. */
  async stack(repo: string, number: string) {
    pullEndpoint(repo, number);
    const pulls = await this.pages<StackPullRequest>(`repos/${repo}/pulls?state=open`);
    return stackPosition(pulls, Number(number));
  }

  /** Load the exact old/new files behind an immutable PR or single-commit diff. */
  async contents(repo: string, number: string, head: string, base: string, path: string, oldPath: string, single: boolean) {
    pullEndpoint(repo, number);
    if (!/^[a-f0-9]{40}$/.test(head) || !/^[a-f0-9]{40}$/.test(base)) throw new Error("Invalid commit");
    const before = single
      ? (await this.get<{ parents: { sha: string }[] }>(`repos/${repo}/commits/${head}`)).parents[0]?.sha
      : (await this.get<{ merge_base_commit: { sha: string } }>(`repos/${repo}/compare/${base}...${head}`)).merge_base_commit.sha;
    if (!before) throw new Error("No parent for this commit");
    const [oldContents, newContents] = await Promise.all([this.fileContents(repo, before, oldPath), this.fileContents(repo, head, path)]);
    // Added/deleted files exist on only one side. Require one successful read so a
    // missing file or repository-wide access failure cannot masquerade as empty source.
    if (oldContents === undefined && newContents === undefined) throw new Error("File not found on either side of this diff");
    return { oldFile: { name: oldPath, contents: oldContents ?? "" }, newFile: { name: path, contents: newContents ?? "" } };
  }

  /** Fetch raw text at immutable SHAs, preserving renamed paths on each side. */
  private async fileContents(repo: string, sha: string, path: string): Promise<string | undefined> {
    try {
      return await this.run(["gh", "api", `repos/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${sha}`, "-H", "Accept: application/vnd.github.raw"]);
    } catch (error) {
      // gh reports HTTP failures on stderr; only a missing path is an expected diff side.
      if (error instanceof Error && /\(HTTP 404\)/.test(error.message)) return undefined;
      throw error;
    }
  }

  /** Include pagination for long-running PR discussions and review threads. */
  async conversation(repo: string, number: string): Promise<Conversation> {
    const endpoint = pullEndpoint(repo, number);
    const [comments, inline, reviews, threads] = await Promise.all([
      this.pages<DiscussionComment>(`repos/${repo}/issues/${number}/comments`),
      this.pages<DiscussionComment>(`${endpoint}/comments`),
      this.pages<DiscussionComment>(`${endpoint}/reviews`),
      this.reviewThreads(repo, number),
    ]);
    return { comments, inline: inline.map((comment) => {
      const thread = threads.find((entry) => entry.comments.nodes[0]?.databaseId === (comment.in_reply_to_id ?? comment.id));
      return { ...comment, body: comment.body.replace(/\n\n<!-- biff:[a-f0-9-]+:[a-f0-9-]+ -->\s*$/, ""), ...(thread ? { reviewThread: { id: thread.id, resolved: thread.isResolved, canResolve: thread.viewerCanResolve, canReopen: thread.viewerCanUnresolve } } : {}) };
    }), reviews };
  }

  /** REST comments have no resolution state; match GraphQL threads by their first comment ID. */
  async reviewThreads(repo: string, number: string): Promise<GitHubThread[]> {
    pullEndpoint(repo, number);
    const [owner, name] = repo.split("/");
    const query = `query($owner: String!, $name: String!, $number: Int!, $endCursor: String) {
      repository(owner: $owner, name: $name) {
        pullRequest(number: $number) {
          reviewThreads(first: 100, after: $endCursor) {
            nodes { id isResolved viewerCanResolve viewerCanUnresolve comments(first: 1) { nodes { databaseId } } }
            pageInfo { hasNextPage endCursor }
          }
        }
      }
    }`;
    const pages: { data: { repository: { pullRequest: { reviewThreads: { nodes: GitHubThread[] } } } }; errors?: { message: string }[] }[] = JSON.parse(await this.run([
      "gh", "api", "graphql", "--paginate", "--slurp", "-f", `query=${query}`, "-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `number=${number}`,
    ]));
    return pages.flatMap((page) => {
      if (page.errors?.length) throw new Error(page.errors.map((error) => error.message).join("; "));
      return page.data.repository.pullRequest.reviewThreads.nodes;
    });
  }

  /** Resolve/reopen only a thread verified to belong to this PR. */
  async resolveThread(repo: string, number: string, id: string, resolved: boolean): Promise<number | undefined> {
    const thread = (await this.reviewThreads(repo, number)).find((entry) => entry.id === id);
    if (!thread) throw new Error("Thread not found in this PR");
    if (thread.isResolved === resolved) return thread.comments.nodes[0]?.databaseId;
    if (!(resolved ? thread.viewerCanResolve : thread.viewerCanUnresolve)) throw new Error("You cannot change this thread's resolution on GitHub.");
    const action = resolved ? "resolveReviewThread" : "unresolveReviewThread";
    const query = `mutation($threadId: ID!) { ${action}(input: { threadId: $threadId }) { thread { id isResolved } } }`;
    const result = JSON.parse(await this.run(["gh", "api", "graphql", "-f", `query=${query}`, "-f", `threadId=${id}`])) as { errors?: { message: string }[] };
    if (result.errors?.length) throw new Error(result.errors.map((error) => error.message).join("; "));
    return thread.comments.nodes[0]?.databaseId;
  }

  /** Submit a review against the exact head the person reviewed. */
  async submitReview(repo: string, number: string, submission: ReviewSubmission) {
    const endpoint = pullEndpoint(repo, number);
    const pr = await this.get<PullRequest>(endpoint);
    if (pr.head.sha !== submission.commitId) throw new Error("The PR has new commits. Refresh and check your draft against the latest changes before submitting.");
    return this.write(`${endpoint}/reviews`, { event: submission.event, body: submission.body, commit_id: submission.commitId, comments: submission.comments });
  }

  /** Post a general PR comment, or reply to an existing inline thread. */
  async comment(repo: string, number: string, body: string, replyTo?: number) {
    const endpoint = pullEndpoint(repo, number);
    if (replyTo !== undefined) return this.write(`${endpoint}/comments/${replyTo}/replies`, { body });
    return this.write(`repos/${repo}/issues/${number}/comments`, { body });
  }

  /** Publish one line comment against the exact head shown in the diff. */
  async inlineComment(repo: string, number: string, commitId: string, comment: DraftComment & { start_line?: number; start_side?: "LEFT" | "RIGHT" }) {
    const endpoint = pullEndpoint(repo, number);
    const pr = await this.get<PullRequest>(endpoint);
    if (pr.head.sha !== commitId) throw new Error("The PR has new commits. Refresh and check your comment against the latest changes before submitting.");
    return this.write(`${endpoint}/comments`, { commit_id: commitId, ...comment });
  }

  /** Edit or delete a comment in this PR; GitHub enforces the authenticated user's permissions. */
  async changeComment(repo: string, number: string, id: number, kind: "inline" | "general", body?: string): Promise<void> {
    const pull = pullEndpoint(repo, number);
    if (!Number.isSafeInteger(id) || id < 1) throw new Error("Invalid comment ID");
    const comments = await this.pages<DiscussionComment>(kind === "inline" ? `${pull}/comments` : `repos/${repo}/issues/${number}/comments`);
    const comment = comments.find((entry) => entry.id === id);
    if (!comment) {
      // A retry after GitHub accepted a deletion should still remove the saved local copy.
      if (body === undefined) return;
      throw new Error("Comment not found in this PR");
    }
    const endpoint = `repos/${repo}/${kind === "inline" ? "pulls" : "issues"}/comments/${id}`;
    if (body === undefined) await this.run(["gh", "api", endpoint, "--method", "DELETE"]);
    else {
      // Preserve the receipt marker so interrupted publication can still recover this message.
      const marker = comment.body.match(/\n\n<!-- biff:[a-f0-9-]+:[a-f0-9-]+ -->\s*$/)?.[0] ?? "";
      await this.run(["gh", "api", endpoint, "--method", "PATCH", "--input", "-"], { input: JSON.stringify({ body: body + marker }) });
    }
  }

  private async get<T>(endpoint: string): Promise<T> { return JSON.parse(await this.run(["gh", "api", endpoint])); }
  private async pages<T>(endpoint: string): Promise<T[]> {
    const pages: T[][] = JSON.parse(await this.run(["gh", "api", `${endpoint}${endpoint.includes("?") ? "&" : "?"}per_page=100`, "--paginate", "--slurp"]));
    return pages.flat();
  }

  /** JSON stdin preserves markdown, Unicode, newlines, and numeric line coordinates. */
  private async write(endpoint: string, body: unknown) {
    return JSON.parse(await this.run(["gh", "api", endpoint, "--method", "POST", "--input", "-"], { input: JSON.stringify(body) }));
  }
}

interface GitHubThread {
  id: string;
  isResolved: boolean;
  viewerCanResolve: boolean;
  viewerCanUnresolve: boolean;
  comments: { nodes: { databaseId: number }[] };
}

/** Validate URL segments before they become gh endpoint arguments. */
function pullEndpoint(repo: string, number: string): string {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !/^[1-9]\d*$/.test(number)) throw new Error("Invalid GitHub repository or PR number.");
  return `repos/${repo}/pulls/${number}`;
}
