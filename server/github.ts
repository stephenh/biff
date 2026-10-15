import type { Commit, Conversation, DiscussionComment, DraftComment, FileViewedState, GitHubReview, PullRequest, PullRequestSummary, ReviewSubmission, ViewedFiles } from "../shared/types";
import { runCommand, type RunCommand } from "./commands";

/** GitHub operations use gh's existing credentials, never browser tokens. */
export class GitHub {
  constructor(private run: RunCommand = runCommand) {}

  /** Match the two useful review queues, ordered by most recently updated. */
  async dashboard(view: string): Promise<PullRequestSummary[]> {
    const filter = view === "requested" ? "--review-requested" : "--author";
    return JSON.parse(await this.run(["gh", "search", "prs", filter, "@me", "--state", "open", "--sort", "updated", "--order", "desc", "--limit", "100", "--json", "number,title,url,repository,author,isDraft,updatedAt"]));
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

  /** Pin diffs to SHAs so a concurrent push cannot mismatch line-comment coordinates. */
  async review(repo: string, number: string, commit: string): Promise<GitHubReview> {
    const endpoint = pullEndpoint(repo, number);
    const [pr, commits] = await Promise.all([this.get<PullRequest>(endpoint), this.pages<Commit>(`${endpoint}/commits`)]);
    if (commit !== "all" && !commits.some((entry) => entry.sha === commit)) throw new Error("That commit is not in this PR. Refresh the commit list.");
    const diffEndpoint = commit === "all" ? `repos/${repo}/compare/${pr.base.sha}...${pr.head.sha}` : `repos/${repo}/commits/${commit}`;
    const patch = await this.run(["gh", "api", diffEndpoint, "-H", "Accept: application/vnd.github.diff"]);
    return { pr, commits, patch, commit };
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
    return { oldFile: { name: oldPath, contents: oldContents }, newFile: { name: path, contents: newContents } };
  }

  /** Fetch raw text at immutable SHAs, preserving renamed paths on each side. */
  private fileContents(repo: string, sha: string, path: string) {
    return this.run(["gh", "api", `repos/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${sha}`, "-H", "Accept: application/vnd.github.raw"]);
  }

  /** Include pagination for long-running PR discussions and review threads. */
  async conversation(repo: string, number: string): Promise<Conversation> {
    const endpoint = pullEndpoint(repo, number);
    const [comments, inline, reviews] = await Promise.all([
      this.pages<DiscussionComment>(`repos/${repo}/issues/${number}/comments`),
      this.pages<DiscussionComment>(`${endpoint}/comments`),
      this.pages<DiscussionComment>(`${endpoint}/reviews`),
    ]);
    return { comments, inline, reviews };
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
  async inlineComment(repo: string, number: string, commitId: string, comment: DraftComment) {
    const endpoint = pullEndpoint(repo, number);
    const pr = await this.get<PullRequest>(endpoint);
    if (pr.head.sha !== commitId) throw new Error("The PR has new commits. Refresh and check your comment against the latest changes before submitting.");
    return this.write(`${endpoint}/comments`, { commit_id: commitId, ...comment });
  }

  private async get<T>(endpoint: string): Promise<T> { return JSON.parse(await this.run(["gh", "api", endpoint])); }
  private async pages<T>(endpoint: string): Promise<T[]> {
    const pages: T[][] = JSON.parse(await this.run(["gh", "api", `${endpoint}?per_page=100`, "--paginate", "--slurp"]));
    return pages.flat();
  }

  /** JSON stdin preserves markdown, Unicode, newlines, and numeric line coordinates. */
  private async write(endpoint: string, body: unknown) {
    return JSON.parse(await this.run(["gh", "api", endpoint, "--method", "POST", "--input", "-"], { input: JSON.stringify(body) }));
  }
}

/** Validate URL segments before they become gh endpoint arguments. */
function pullEndpoint(repo: string, number: string): string {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !/^[1-9]\d*$/.test(number)) throw new Error("Invalid GitHub repository or PR number.");
  return `repos/${repo}/pulls/${number}`;
}
