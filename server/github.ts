import type { Commit, Conversation, DiscussionComment, DraftComment, FileViewedState, GitHubReview, MentionUser, PullRequest, PullRequestSummary, ReviewSubmission, ViewedFiles } from "../shared/types";
import { runCommand, type RunCommand } from "./commands";
import { hideWhitespace } from "../shared/hideWhitespace";
import { stackPosition, type StackPullRequest } from "./prStack";
import { RepositoryUsers } from "./repositoryUsers";
import type { PullActivity, TrackedPullRequest } from "../shared/inbox";
import type { Storage } from "./storage";
import { parsePatchFiles } from "@pierre/diffs";
import { conversationActivity } from "../shared/commentActivity";
import { githubAttachment } from "./githubAttachment";

interface DashboardPR extends PullRequestSummary {
  headRefOid: string;
  reviewDecision: string;
  reviewRequests: { nodes: { requestedReviewer: { login?: string } | null }[] };
  latestOpinionatedReviews: { nodes: { author: { login: string } | null; state: string }[] };
  commits: { nodes: { commit: { author: { user: { login: string } | null }; statusCheckRollup: { state: string } | null } }[] };
}

const dashboardFields = `number title url repository { nameWithOwner } author { login } isDraft updatedAt createdAt
  headRefOid reviewDecision
  reviewRequests(first: 100) { nodes { requestedReviewer { ... on User { login } } } }
  latestOpinionatedReviews(first: 100) { nodes { author { login } state } }
  commits(last: 1) { nodes { commit { author { user { login } } statusCheckRollup { state } } } }`;

/** GitHub operations use gh's existing credentials, never browser tokens. */
export class GitHub {
  private viewer?: Promise<string>;
  private commentWrites = new Map<string, Promise<DiscussionComment>>();
  private dashboardMetadata = new Map<string, Omit<PullActivity, "events">>();
  private users: RepositoryUsers;
  constructor(private run: RunCommand = runCommand, storage?: Storage) {
    this.users = new RepositoryUsers(run, storage);
  }

  /**
   * Keep dependency updates separate from human review requests, ordered by most recently updated.
   *
   * Fetch head and check status in the same query so large queues do not need one metadata request per PR.
   */
  async dashboard(view: string): Promise<PullRequestSummary[]> {
    const viewer = await this.viewerLogin();
    // Split at GitHub so bot PRs cannot consume the human queue's 100-result limit.
    const filter = view === "dependabot" ? `review-requested:${viewer} author:app/dependabot`
      : view === "requested" ? `review-requested:${viewer} -author:app/dependabot` : `author:${viewer}`;
    const query = `query($search: String!) {
      search(query: $search, type: ISSUE, first: 100) {
        nodes { ... on PullRequest { ${dashboardFields} } }
      }
    }`;
    const result = JSON.parse(await this.run(["gh", "api", "graphql", "-f", `query=${query}`, "-f", `search=is:pr is:open ${filter} sort:updated-desc`])) as {
      data: { search: { nodes: DashboardPR[] } };
      errors?: { message: string }[];
    };
    if (result.errors?.length) throw new Error(result.errors.map((error) => error.message).join("; "));
    return result.data.search.nodes.filter((pr) => Boolean(pr?.url)).map((pr) => this.rememberDashboardPR(pr, viewer));
  }

  /**
   * Refresh only known PRs, in bounded batches, without searching review history.
   *
   * Missing or inaccessible results are failures, not evidence that a PR closed.
   * I.e. p0 and p1 address two stored repository/number pairs in one GraphQL call.
   */
  async trackedPullRequests(ids: string[]): Promise<TrackedPullRequest[]> {
    const viewer = await this.viewerLogin();
    const results: TrackedPullRequest[] = [];
    for (let start = 0; start < ids.length; start += 25) {
      const batch = ids.slice(start, start + 25);
      const fields = batch.map((id, index) => {
        const [owner, repo, number] = id.split("/");
        pullEndpoint(`${owner}/${repo}`, number);
        if (id.split("/").length !== 3) throw new Error("Invalid PR");
        return `p${index}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(repo)}) { pullRequest(number: ${Number(number)}) { state closedAt mergedAt ${dashboardFields} } }`;
      });
      const result = JSON.parse(await this.run(["gh", "api", "graphql", "-f", `query=query { ${fields.join("\n")} }`])) as {
        data: Record<string, { pullRequest: DashboardPR & { state: TrackedPullRequest["state"]; closedAt: string | null; mergedAt: string | null } } | null>;
        errors?: { message: string }[];
      };
      if (result.errors?.length) throw new Error(result.errors.map((error) => error.message).join("; "));
      for (const [index, id] of batch.entries()) {
        const pr = result.data?.[`p${index}`]?.pullRequest;
        if (!pr || !["OPEN", "CLOSED", "MERGED"].includes(pr.state)) throw new Error(`Could not refresh tracked PR ${id}`);
        results.push({ pr: this.rememberDashboardPR(pr, viewer), state: pr.state, closedAt: pr.mergedAt ?? pr.closedAt, view: pr.author?.login === viewer ? "authored" : ["dependabot", "dependabot[bot]"].includes(pr.author?.login) ? "dependabot" : "requested" });
      }
    }
    return results;
  }

  /**
   * Combine the queue's batched status with its paginated discussion.
   *
   * Unchanged PRs reuse saved events; status still comes from the current queue refresh.
   */
  async dashboardActivity(repo: string, number: string, previous?: PullActivity): Promise<PullActivity> {
    pullEndpoint(repo, number);
    const metadata = this.dashboardMetadata.get(`${repo.toLowerCase()}/${number}`);
    if (!metadata) throw new Error("Load the PR queue before its activity");
    let events = previous?.events;
    // Older saved snapshots lack thread membership; reload them without resetting read markers.
    if (events?.some((event) => (event.kind === "reply" && !event.thread) || (event.kind === "review" && event.hasBody === undefined))) events = undefined;
    if (!events) {
      const endpoint = pullEndpoint(repo, number);
      const [comments, inline, reviews] = await Promise.all([
        this.pages<DiscussionComment>(`repos/${repo}/issues/${number}/comments`),
        this.pages<DiscussionComment>(`${endpoint}/comments`),
        this.pages<DiscussionComment>(`${endpoint}/reviews`),
      ]);
      events = conversationActivity({ comments, inline, reviews });
    }
    return { ...metadata, events };
  }

  /** Verify completeness and the current head before allowing destructive follow-up reconciliation. */
  async followUpSnapshot(repo: string, number: string, head: string): Promise<{ patch: string; commits: string[] }> {
    const pr = await this.pullRequest(repo, number);
    if (pr.head.sha !== head) throw new Error("PR changed while refreshing follow-ups; retrying on the next refresh");
    const raw = await this.run(["gh", "api", `repos/${repo}/compare/${pr.base.sha}...${head}`, "-H", "Accept: application/vnd.github.diff"]);
    const files = raw.trim() ? parsePatchFiles(raw, undefined, true).flatMap((entry) => entry.files) : [];
    if (pr.changed_files === undefined || files.length !== pr.changed_files) throw new Error("Incomplete diff; follow-ups were retained");
    const commits = await this.pages<Commit>(`${pullEndpoint(repo, number)}/commits`);
    if ((await this.pullRequest(repo, number)).head.sha !== head) throw new Error("PR changed while refreshing follow-ups; retrying on the next refresh");
    return { patch: hideWhitespace(raw), commits: commits.map((commit) => commit.sha) };
  }

  /** Search GitHub's repository-specific mention list, including users beyond collaborators. */
  async mentionUsers(repo: string, number: string, search: string): Promise<MentionUser[]> {
    pullEndpoint(repo, number);
    if (search.length > 100) throw new Error("Mention search is too long");
    return this.users.search(repo, search);
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

  /** Resolve the PR fork on GitHub even when the target tip has not been fetched locally. */
  async mergeBase(repo: string, base: string, head: string): Promise<string> {
    if (!/^[a-f0-9]{40}$/.test(head) || !/^[a-f0-9]{40}$/.test(base)) throw new Error("Invalid commit");
    return (await this.get<{ merge_base_commit: { sha: string } }>(`repos/${repo}/compare/${base}...${head}`)).merge_base_commit.sha;
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
    const [comments, inline, reviews, threads, viewer] = await Promise.all([
      this.pages<DiscussionComment>(`repos/${repo}/issues/${number}/comments`),
      this.pages<DiscussionComment>(`${endpoint}/comments`),
      this.pages<DiscussionComment>(`${endpoint}/reviews`),
      this.reviewThreads(repo, number),
      this.viewerLogin(),
    ]);
    return { comments: comments.map(stripPublicationMarker), inline: inline.map((comment) => {
      const thread = threads.find((entry) => entry.comments.nodes[0]?.databaseId === (comment.in_reply_to_id ?? comment.id));
      return { ...stripPublicationMarker(comment), ...(thread ? { reviewThread: { id: thread.id, resolved: thread.isResolved, canResolve: thread.viewerCanResolve, canReopen: thread.viewerCanUnresolve } } : {}) };
    }), reviews, viewer };
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
  async resolveThread(repo: string, number: string, id: string, resolved: boolean): Promise<NonNullable<DiscussionComment["reviewThread"]>> {
    const thread = (await this.reviewThreads(repo, number)).find((entry) => entry.id === id);
    if (!thread) throw new Error("Thread not found in this PR");
    if (thread.isResolved === resolved) return { id, resolved, canResolve: thread.viewerCanResolve, canReopen: thread.viewerCanUnresolve };
    if (!(resolved ? thread.viewerCanResolve : thread.viewerCanUnresolve)) throw new Error("You cannot change this thread's resolution on GitHub.");
    const action = resolved ? "resolveReviewThread" : "unresolveReviewThread";
    const query = `mutation($threadId: ID!) { ${action}(input: { threadId: $threadId }) { thread { id isResolved viewerCanResolve viewerCanUnresolve } } }`;
    const result = JSON.parse(await this.run(["gh", "api", "graphql", "-f", `query=${query}`, "-f", `threadId=${id}`])) as { errors?: { message: string }[]; data?: Record<string, { thread: GitHubThread }> };
    if (result.errors?.length) throw new Error(result.errors.map((error) => error.message).join("; "));
    const updated = result.data?.[action]?.thread;
    if (!updated) throw new Error("GitHub did not return the updated thread. Retry to confirm its state.");
    return { id: updated.id, resolved: updated.isResolved, canResolve: updated.viewerCanResolve, canReopen: updated.viewerCanUnresolve };
  }

  /** Submit a review against the exact head the person reviewed. */
  async submitReview(repo: string, number: string, submission: ReviewSubmission) {
    const endpoint = pullEndpoint(repo, number);
    const pr = await this.get<PullRequest>(endpoint);
    if (pr.head.sha !== submission.commitId) throw new Error("The PR has new commits. Refresh and check your draft against the latest changes before submitting.");
    return this.write(`${endpoint}/reviews`, { event: submission.event, body: submission.body, commit_id: submission.commitId, comments: submission.comments });
  }

  /** Load screenshots whose GitHub session cookies cannot accompany cross-site image requests. */
  attachment(id: string): Promise<Response> {
    return githubAttachment(id, this.run);
  }

  /** Post a general PR comment, or reply to an existing inline thread. */
  async comment(repo: string, number: string, body: string, replyTo?: number, requestId?: string) {
    const endpoint = pullEndpoint(repo, number);
    return this.publishComment(repo, number, replyTo === undefined ? "general" : "inline", body, requestId, (text) => replyTo !== undefined
      ? this.write(`${endpoint}/comments/${replyTo}/replies`, { body: text })
      : this.write(`repos/${repo}/issues/${number}/comments`, { body: text }));
  }

  /** Publish one line comment against the exact head shown in the diff. */
  async inlineComment(repo: string, number: string, commitId: string, comment: DraftComment & { start_line?: number; start_side?: "LEFT" | "RIGHT" }, requestId?: string) {
    const endpoint = pullEndpoint(repo, number);
    return this.publishComment(repo, number, "inline", comment.body, requestId, async (body) => {
      const pr = await this.get<PullRequest>(endpoint);
      if (pr.head.sha !== commitId) throw new Error("The PR has new commits. Refresh and check your comment against the latest changes before submitting.");
      return this.write(`${endpoint}/comments`, { commit_id: commitId, ...comment, body });
    });
  }

  /**
   * Recover a published comment before retrying an append that may already have reached GitHub.
   *
   * Reuse the existing hidden publication marker format so edits preserve the receipt and Biff
   * hides it from the discussion. Looking up the marker also recovers across server restarts.
   */
  private publishComment(repo: string, number: string, kind: "inline" | "general", body: string, requestId: string | undefined, write: (body: string) => Promise<DiscussionComment>): Promise<DiscussionComment> {
    if (requestId === undefined) return write(body);
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(requestId)) throw new Error("Invalid comment submission ID");
    const key = `${repo.toLowerCase()}/${number}:${requestId}`;
    const pending = this.commentWrites.get(key);
    if (pending) return pending;

    const marker = `<!-- biff:${requestId}:${requestId} -->`;
    const endpoint = kind === "inline" ? `${pullEndpoint(repo, number)}/comments` : `repos/${repo}/issues/${number}/comments`;
    const task = this.pages<DiscussionComment>(endpoint).then((comments) => comments.find((comment) => comment.body.trimEnd().endsWith(marker)) ?? write(`${body}\n\n${marker}`));
    this.commentWrites.set(key, task);
    void task.catch(() => this.commentWrites.delete(key));
    return task;
  }

  /** Restrict edits to the author even when GitHub grants broader repository permissions. */
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
    if (comment.user.login.toLowerCase() !== (await this.viewerLogin()).toLowerCase()) throw new Error("You can only change your own comments.");
    const endpoint = `repos/${repo}/${kind === "inline" ? "pulls" : "issues"}/comments/${id}`;
    if (body === undefined) await this.run(["gh", "api", endpoint, "--method", "DELETE"]);
    else {
      // Preserve the receipt marker so interrupted publication can still recover this message.
      const marker = comment.body.match(/\n\n<!-- biff:[a-f0-9-]+:[a-f0-9-]+ -->\s*$/)?.[0] ?? "";
      await this.run(["gh", "api", endpoint, "--method", "PATCH", "--input", "-"], { input: JSON.stringify({ body: body + marker }) });
    }
  }

  /** Share head, checks, and current approvals between discovered requests and retained reviews. */
  private rememberDashboardPR(pr: DashboardPR, viewer: string): PullRequestSummary {
    const head = pr.commits.nodes.at(-1)?.commit;
    const check = head?.statusCheckRollup?.state;
    this.dashboardMetadata.set(`${pr.repository.nameWithOwner.toLowerCase()}/${pr.number}`, {
      head: pr.headRefOid, headAuthor: head?.author.user?.login || "", viewer,
      reviewDecision: pr.reviewDecision || "REVIEW_REQUIRED",
      reviewRequested: pr.reviewRequests?.nodes.some((request) => request.requestedReviewer?.login === viewer) ?? false,
      // GitHub keeps each reviewer's current decision here, so a later
      // comment-only review does not hide an existing approval.
      approvers: pr.latestOpinionatedReviews.nodes.flatMap((review) => review.state === "APPROVED" && review.author ? [review.author.login] : []).sort((a, b) => a.localeCompare(b)),
      checks: check === "SUCCESS" ? "Passing" : check === "FAILURE" || check === "ERROR" ? "Failing" : check ? "Pending" : "No checks",
    });
    return { number: pr.number, title: pr.title, url: pr.url, repository: pr.repository, author: pr.author ?? { login: "ghost" }, isDraft: pr.isDraft, updatedAt: pr.updatedAt, createdAt: pr.createdAt };
  }

  /** Share identity lookup across both queues, retrying after authentication failures. */
  private viewerLogin(): Promise<string> {
    this.viewer ??= this.get<{ login: string }>("user").then((user) => user.login).catch((error) => { this.viewer = undefined; throw error; });
    return this.viewer;
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

/** Hide publication receipts from discussion text while leaving GitHub's stored body intact for recovery. */
function stripPublicationMarker(comment: DiscussionComment): DiscussionComment {
  return { ...comment, body: comment.body.replace(/\n\n<!-- biff:[a-f0-9-]+:[a-f0-9-]+ -->\s*$/, "") };
}

/** Validate URL segments before they become gh endpoint arguments. */
function pullEndpoint(repo: string, number: string): string {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !/^[1-9]\d*$/.test(number)) throw new Error("Invalid GitHub repository or PR number.");
  return `repos/${repo}/pulls/${number}`;
}
