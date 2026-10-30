import { reviewIdentity } from "./reviewStore";
import type { Commit, Conversation, DiscussionComment, DraftComment, FailedCheck, FileViewedState, GitHubReview, MentionUser, PullRequest, PullRequestStatus, PullRequestSummary, ReviewSubmission, ViewedFiles } from "../shared/types";
import { runCommand, type RunCommand } from "./commands";
import { hideWhitespace } from "../shared/hideWhitespace";
import { stackPosition, type StackPullRequest } from "./prStack";
import { RepositoryUsers } from "./repositoryUsers";
import type { PullActivity, TrackedPullRequest } from "../shared/inbox";
import type { Storage } from "./storage";
import { PrActivity, type ActivitySnapshot } from "./prActivity";
import { parsePatchFiles } from "@pierre/diffs";
import { conversationActivity } from "../shared/commentActivity";
import { githubAttachment } from "./githubAttachment";
import { ThreadSync } from "./threadSync";
import { viewerReviewStatus } from "../shared/pullRequestStatus";
import { prHunkProgress } from "./logicalHunks";
import { reviewChangesStatus } from "./reviewChanges";


interface StatusPR {
  reviewDecision: string;
  reviewRequests?: { nodes: { requestedReviewer: { login?: string } | null }[] };
  latestOpinionatedReviews: { nodes: { author: { login: string } | null; state: string }[] };
  commits: { nodes: { commit: { author: { user: { login: string } | null }; statusCheckRollup: { state: string } | null } }[] };
}
interface DashboardPR extends PullRequestSummary, StatusPR {
  headRefOid: string;
  baseRefOid?: string;
}
type CheckContext =
  | { __typename: "CheckRun"; name: string; conclusion: string | null; detailsUrl: string | null; url: string }
  | { __typename: "StatusContext"; context: string; state: string; targetUrl: string | null };
interface CheckPage {
  data?: { repository: { pullRequest: { commits: { nodes: { commit: { statusCheckRollup: { contexts: { nodes: (CheckContext | null)[] } } | null } }[] } } | null } | null };
  errors?: { message: string }[];
}

const statusFields = `reviewDecision
  reviewRequests(first: 100) { nodes { requestedReviewer { ... on User { login } } } }
  latestOpinionatedReviews(first: 100) { nodes { author { login } state } }
  commits(last: 1) { nodes { commit { author { user { login } } statusCheckRollup { state } } } }`;
const dashboardFields = `number title url repository { nameWithOwner } author { login } isDraft updatedAt createdAt
  headRefOid baseRefOid ${statusFields}`;

/** GitHub operations use gh's existing credentials, never browser tokens. */
export class GitHub {
  private viewer?: Promise<string>;
  private commentWrites = new Map<string, Promise<DiscussionComment>>();
  private reviewWrites = new Map<string, Promise<DiscussionComment>>();
  readonly threadSync?: ThreadSync;
  private dashboardMetadata = new Map<string, Omit<PullActivity, "events">>();
  private dashboardComparisons = new Map<string, { head: string; base: string }>();
  private users: RepositoryUsers;
  private sources = new Map<string, ReturnType<GitHub["loadContents"]>>();
  constructor(private run: RunCommand = runCommand, private storage?: Storage) {
    this.users = new RepositoryUsers(run, storage);
    if (storage) this.threadSync = new ThreadSync(storage, this);
  }

  /**
   * Discover authored PRs or all review requests, ordered by most recently updated.
   *
   * Fetch head and check status in the same query so large queues do not need one metadata request per PR.
   */
  async dashboard(view: string): Promise<PullRequestSummary[]> {
    const viewer = await this.viewerLogin();
    // Old queue links still discover review requests; author filtering belongs to the UI.
    const filter = view === "requested" || view === "dependabot" ? `review-requested:${viewer}` : `author:${viewer}`;
    const query = `query($search: String!) {
      search(query: $search, type: ISSUE, first: 100) {
        nodes { ... on PullRequest { ${dashboardFields} } }
      }
    }`;
    const result = JSON.parse(await this.read(["gh", "api", "graphql", "-f", `query=${query}`, "-f", `search=is:pr is:open ${filter} sort:updated-desc`])) as {
      data: { search: { nodes: DashboardPR[] } };
      errors?: { message: string }[];
    };
    if (result.errors?.length) throw new Error(result.errors.map((error) => error.message).join("; "));
    return result.data.search.nodes.filter((pr) => Boolean(pr?.url)).map((pr) => this.rememberDashboardPR(pr, viewer));
  }

  /** Clear only the authenticated user's outstanding request, leaving teams and past reviews intact. */
  async removeReviewRequest(repo: string, number: string): Promise<void> {
    const endpoint = pullEndpoint(repo, number);
    const viewer = await this.viewerLogin();
    const pr = await this.get<{ state: string; requested_reviewers: { login: string }[] }>(endpoint);
    if (pr.state !== "open" || !pr.requested_reviewers.some((reviewer) => reviewer.login.toLowerCase() === viewer.toLowerCase())) return;

    await this.run(["gh", "api", `${endpoint}/requested_reviewers`, "--method", "DELETE", "--input", "-"], { input: JSON.stringify({ reviewers: [viewer] }) });
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
      const result = JSON.parse(await this.read(["gh", "api", "graphql", "-f", `query=query { ${fields.join("\n")} }`])) as {
        data: Record<string, { pullRequest: DashboardPR & { state: TrackedPullRequest["state"]; closedAt: string | null; mergedAt: string | null } } | null>;
        errors?: { message: string }[];
      };
      if (result.errors?.length) throw new Error(result.errors.map((error) => error.message).join("; "));
      for (const [index, id] of batch.entries()) {
        const pr = result.data?.[`p${index}`]?.pullRequest;
        if (!pr || !["OPEN", "CLOSED", "MERGED"].includes(pr.state)) throw new Error(`Could not refresh tracked PR ${id}`);
        results.push({ pr: this.rememberDashboardPR(pr, viewer), state: pr.state, closedAt: pr.mergedAt ?? pr.closedAt, view: pr.author?.login === viewer ? "authored" : "requested" });
      }
    }
    return results;
  }

  /**
   * Combine the queue's batched status with its paginated discussion.
   *
   * Unchanged PRs reuse saved events; status still comes from the current queue refresh.
   */
  async dashboardActivity(repo: string, number: string, previous?: PullActivity): Promise<ActivitySnapshot> {
    pullEndpoint(repo, number);
    const scope = `${repo.toLowerCase()}/${number}`;
    const activities = this.storage ? new PrActivity(this.storage.db) : undefined;
    const discussionVersion = activities?.version(scope);
    const metadata = this.dashboardMetadata.get(`${repo.toLowerCase()}/${number}`);
    if (!metadata) throw new Error("Load the PR queue before its activity");
    let events = previous?.events;
    let conversation: Conversation | undefined;
    // Older saved snapshots lack thread membership; reload them without resetting read markers.
    if (events?.some((event) => (event.kind === "reply" && !event.thread) || (event.kind === "review" && event.hasBody === undefined))) events = undefined;
    if (!events) {
      const endpoint = pullEndpoint(repo, number);
      const [comments, inline, reviews] = await Promise.all([
        this.pages<DiscussionComment>(`repos/${repo}/issues/${number}/comments`),
        this.pages<DiscussionComment>(`${endpoint}/comments`),
        this.pages<DiscussionComment>(`${endpoint}/reviews`),
      ]);
      conversation = { comments, inline, reviews };
      events = conversationActivity(conversation);
      if (discussionVersion === activities?.version(scope)) await this.threadSync?.observe(repo, number, inline);
    }
    await this.threadSync?.refresh(repo, number, undefined, this.dashboardComparisons.get(`${repo.toLowerCase()}/${number}`));
    return { ...metadata, events, ...(conversation ? { conversation } : { reuseDiscussion: true }), ...(discussionVersion === undefined ? {} : { discussionVersion }) };
  }

  /** Verify completeness and the current head before allowing destructive follow-up reconciliation. */
  async followUpSnapshot(repo: string, number: string, head: string): Promise<{ patch: string; commits: string[] }> {
    const pr = await this.pullRequest(repo, number);
    if (pr.head.sha !== head) throw new Error("PR changed while refreshing follow-ups; retrying on the next refresh");
    const raw = await this.read(["gh", "api", `repos/${repo}/compare/${pr.base.sha}...${head}`, "-H", "Accept: application/vnd.github.diff"]);
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
    const pages: { data: { repository: { pullRequest: { files: { nodes: { path: string; viewerViewedState: FileViewedState }[] } } } } }[] = JSON.parse(await this.read([
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
    const patch = await this.read(["gh", "api", diffEndpoint, "-H", "Accept: application/vnd.github.diff"]);
    return { pr, commits, patch: hideWhitespace(patch), commit };
  }

  /** Fetch immutable full-PR comparisons for hunk anchors without re-reading mutable metadata. */
  async patch(repo: string, base: string, head: string): Promise<string> {
    pullEndpoint(repo, "1");
    if (!/^[a-f0-9]{40}$/.test(base) || !/^[a-f0-9]{40}$/.test(head)) throw new Error("Invalid comparison");
    return hideWhitespace(await this.read(["gh", "api", `repos/${repo}/compare/${base}...${head}`, "-H", "Accept: application/vnd.github.diff"]));
  }

  /** Inbox polling updates attachments only when a recorded comparison changes. */
  async syncThreads(repo: string, number: string, review?: GitHubReview): Promise<void> { await this.threadSync?.refresh(repo, number, review); }

  /** Load stack metadata separately so repository-wide lookup cannot delay the diff. */
  async stack(repo: string, number: string) {
    pullEndpoint(repo, number);
    const pulls = await this.pages<StackPullRequest>(`repos/${repo}/pulls?state=open`);
    const stack = stackPosition(pulls, Number(number));
    if (!stack || !this.storage) return stack;

    // The list already includes both SHAs. Never download a diff just to fill a stack badge.
    for (const pr of stack.pulls) {
      const source = pulls.find((entry) => entry.number === pr.number)!;
      if (!source.head.sha || !source.base.sha) continue;
      const progress = prHunkProgress(this.storage.db, `${repo.toLowerCase()}/${pr.number}`, source.head.sha, source.base.sha);
      if (progress) pr.progress = progress;
    }
    return stack;
  }

  /** Load live review and CI status independently so status failures cannot block the diff. */
  async status(repo: string, number: string): Promise<PullRequestStatus> {
    pullEndpoint(repo, number);
    const [owner, name] = repo.split("/");
    const query = `query($owner: String!, $name: String!, $number: Int!) {
      repository(owner: $owner, name: $name) { pullRequest(number: $number) { ${statusFields} } }
    }`;
    const [viewer, raw] = await Promise.all([this.viewerLogin(), this.read([
      "gh", "api", "graphql", "-f", `query=${query}`, "-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `number=${number}`,
    ])]);
    const result = JSON.parse(raw) as { data?: { repository: { pullRequest: StatusPR | null } | null }; errors?: { message: string }[] };
    if (result.errors?.length) throw new Error(result.errors.map((error) => error.message).join("; "));
    const pr = result.data?.repository?.pullRequest;
    if (!pr) throw new Error("Could not load PR status");
    const status = reviewStatus(pr, viewer);
    return { ...status, ...viewerReviewStatus(status, viewer), ...(this.storage ? reviewChangesStatus(this.storage.db, `${repo.toLowerCase()}/${number}`, viewer) : {}) };
  }

  /**
   * Resolve failed head checks to their provider's job/build links only when requested.
   *
   * Paginate both GitHub check runs and legacy commit statuses without adding one
   * CI-detail query per PR to every queue refresh.
   */
  async failedChecks(repo: string, number: string): Promise<FailedCheck[]> {
    pullEndpoint(repo, number);
    const [owner, name] = repo.split("/");
    const query = `query($owner: String!, $name: String!, $number: Int!, $endCursor: String) {
      repository(owner: $owner, name: $name) { pullRequest(number: $number) {
        commits(last: 1) { nodes { commit { statusCheckRollup {
          contexts(first: 100, after: $endCursor) {
            nodes { __typename
              ... on CheckRun { name conclusion detailsUrl url }
              ... on StatusContext { context state targetUrl }
            }
            pageInfo { hasNextPage endCursor }
          }
        } } } }
      } }
    }`;
    const pages = JSON.parse(await this.read([
      "gh", "api", "graphql", "--paginate", "--slurp", "-f", `query=${query}`,
      "-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `number=${number}`,
    ])) as CheckPage[];
    const checks: FailedCheck[] = [];
    for (const page of pages) {
      if (page.errors?.length) throw new Error(page.errors.map((error) => error.message).join("; "));
      const pr = page.data?.repository?.pullRequest;
      if (!pr) throw new Error("Could not load CI checks");
      for (const context of pr.commits.nodes.at(-1)?.commit.statusCheckRollup?.contexts.nodes ?? []) {
        const check = failedCheck(context, `https://github.com/${repo}/pull/${number}/checks`);
        if (check) checks.push(check);
      }
    }
    return checks;
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
    // Reconciliation and the browser request the same immutable source. Share both
    // in-flight requests and results, with a bounded cache for long-running daemons.
    const key = JSON.stringify([repo.toLowerCase(), head, base, path, oldPath, single]);
    let source = this.sources.get(key);
    if (!source) {
      source = this.loadContents(repo, head, base, path, oldPath, single);
      this.sources.set(key, source);
      if (this.sources.size > 128) this.sources.delete(this.sources.keys().next().value!);
      void source.catch(() => { if (this.sources.get(key) === source) this.sources.delete(key); });
    }
    return source;
  }

  /** Resolve the old side against the same immutable comparison used by the diff. */
  private async loadContents(repo: string, head: string, base: string, path: string, oldPath: string, single: boolean) {
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
      return await this.read(["gh", "api", `repos/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${sha}`, "-H", "Accept: application/vnd.github.raw"]);
    } catch (error) {
      // gh reports HTTP failures on stderr; only a missing path is an expected diff side.
      if (error instanceof Error && /\(HTTP 404\)/.test(error.message)) return undefined;
      throw error;
    }
  }

  /** Include pagination for long-running PR discussions and review threads. */
  async conversation(repo: string, number: string): Promise<Conversation> {
    const endpoint = pullEndpoint(repo, number);
    const scope = `${repo.toLowerCase()}/${number}`;
    const activities = this.storage ? new PrActivity(this.storage.db) : undefined;
    const version = activities?.version(scope);
    const [comments, inline, reviews, threads, viewer] = await Promise.all([
      this.pages<DiscussionComment>(`repos/${repo}/issues/${number}/comments`),
      this.pages<DiscussionComment>(`${endpoint}/comments`),
      this.pages<DiscussionComment>(`${endpoint}/reviews`),
      this.reviewThreads(repo, number),
      this.viewerLogin(),
    ]);
    if (version === activities?.version(scope)) await this.threadSync?.observe(repo, number, inline);
    if (this.storage && activities && version === activities.version(scope)) {
      if (!this.storage.db.query("SELECT id FROM prs WHERE id=?").get(scope)) {
        const [tracked] = await this.trackedPullRequests([scope]);
        activities.summary(tracked.pr);
      }
      await reviewIdentity(this.storage, scope);
      if (version === activities.version(scope)) activities.conversation(scope, { comments, inline, reviews });
    }
    const attached = this.threadSync ? await this.threadSync.attach(repo, number, inline) : inline;
    return { comments: comments.map(stripPublicationMarker), inline: attached.map((comment) => {
      const thread = threads.find((entry) => entry.comments.nodes[0]?.databaseId === (comment.in_reply_to_id ?? comment.id));
      return { ...stripPublicationMarker(comment), ...(thread ? { reviewThread: { id: thread.id, resolved: thread.isResolved, canResolve: thread.viewerCanResolve, canReopen: thread.viewerCanUnresolve } } : {}) };
    }), reviews: reviews.map(stripPublicationMarker), viewer };
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
    const pages: { data: { repository: { pullRequest: { reviewThreads: { nodes: GitHubThread[] } } } }; errors?: { message: string }[] }[] = JSON.parse(await this.read([
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
  async submitReview(repo: string, number: string, submission: ReviewSubmission, requestId?: string): Promise<DiscussionComment> {
    if (requestId !== undefined) {
      if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(requestId)) throw new Error("Invalid review submission ID");
      const key = `${repo.toLowerCase()}/${number}:${requestId}`;
      const existing = this.reviewWrites.get(key);
      if (existing) return existing;
      const task = this.publishReview(repo, number, submission, requestId);
      this.reviewWrites.set(key, task);
      void task.catch(() => this.reviewWrites.delete(key));
      return task;
    }
    return this.writeReview(repo, number, submission);
  }

  /** Resolve a retry before validating anchors: an already-published hunk may have changed since success. */
  async submittedReview(repo: string, number: string, requestId: string, submission?: ReviewSubmission): Promise<DiscussionComment | undefined> {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(requestId)) throw new Error("Invalid review submission ID");
    const pending = this.reviewWrites.get(`${repo.toLowerCase()}/${number}:${requestId}`);
    if (pending) return pending;
    return this.reviewReceipt(repo, number, requestId, submission);
  }

  /** Recover an interrupted write by its receipt, never by blindly sending the review again. */
  private async publishReview(repo: string, number: string, submission: ReviewSubmission, requestId: string): Promise<DiscussionComment> {
    try {
      const receipt = await this.reviewReceipt(repo, number, requestId, submission);
      if (receipt) return receipt;
      const marker = `<!-- biff:${requestId}:${requestId} -->`;
      return await this.writeReview(repo, number, { ...submission, body: `${submission.body}\n\n${marker}` }, true);
    } catch (cause) {
      if (!isConnectionError(cause)) throw cause;
      try {
        const receipt = await this.reviewReceipt(repo, number, requestId, submission);
        if (receipt) return receipt;
      } catch { /* No receipt means unconfirmed, not rejected or safe to resend automatically. */ }
      throw new Error("GitHub connection was interrupted. Your review is saved in Biff, but publication is unconfirmed. Retry will check GitHub before resubmitting.");
    }
  }

  /**
   * Find the exact receipt, or a later acknowledged review that fulfilled the same message intent.
   *
   * Adding a summary after a failed attempt must not leave the older attempt able to repost its identical comments.
   */
  private async reviewReceipt(repo: string, number: string, requestId: string, submission?: ReviewSubmission): Promise<DiscussionComment | undefined> {
    const reviews = await this.pages<DiscussionComment>(`${pullEndpoint(repo, number)}/reviews`);
    const marker = `<!-- biff:${requestId}:${requestId} -->`;
    const exact = reviews.find((review) => review.body?.trimEnd().endsWith(marker));
    if (exact || !submission?.comments.length || submission.comments.some((comment) => !comment.id)) return exact;
    const comments = await this.pages<DiscussionComment>(`${pullEndpoint(repo, number)}/comments`);
    const roots = submission.comments.map((comment) => comments.find((entry) => !entry.in_reply_to_id && entry.body?.trimEnd().endsWith(`<!-- biff:${comment.id}:${comment.id} -->`) && stripPublicationMarker(entry).body === comment.body));
    const reviewId = roots[0]?.pull_request_review_id;
    if (!reviewId || roots.some((root) => root?.pull_request_review_id !== reviewId)) return;
    const receipt = reviews.find((review) => review.id === reviewId);
    if (!receipt || receipt.state === "PENDING") return;
    if (submission.event === "APPROVE" && receipt.state !== "APPROVED" || submission.event === "REQUEST_CHANGES" && receipt.state !== "CHANGES_REQUESTED") return;
    return !submission.body.trim() || stripPublicationMarker(receipt).body === submission.body ? receipt : undefined;
  }

  /** GitHub sees only its coordinate contract; Biff identities stay in hidden retry receipts. */
  private async writeReview(repo: string, number: string, submission: ReviewSubmission, marked = false): Promise<DiscussionComment> {
    const endpoint = pullEndpoint(repo, number);
    const pr = await this.get<PullRequest>(endpoint);
    if (pr.head.sha !== submission.commitId) throw new Error("The PR has new commits. Your comments are still saved in Biff. Refresh to follow unchanged hunks before submitting.");
    const comments = submission.comments.map((comment) => ({ path: comment.path, side: comment.side, line: comment.line, body: marked && comment.id ? `${comment.body}\n\n<!-- biff:${comment.id}:${comment.id} -->` : comment.body }));
    return this.write(`${endpoint}/reviews`, { event: submission.event, body: submission.body, commit_id: submission.commitId, comments });
  }

  /** Load screenshots whose GitHub session cookies cannot accompany cross-site image requests. */
  attachment(id: string): Promise<Response> {
    return githubAttachment(id, this.run);
  }

  /** Post a general PR comment, or reply to an existing inline thread. */
  async comment(repo: string, number: string, body: string, replyTo?: number, requestId?: string) {
    const endpoint = pullEndpoint(repo, number);
    const comment = await this.publishComment(repo, number, replyTo === undefined ? "general" : "inline", body, requestId, (text) => replyTo !== undefined
      ? this.write(`${endpoint}/comments/${replyTo}/replies`, { body: text })
       : this.write(`repos/${repo}/issues/${number}/comments`, { body: text }));
    // Inline receipts are attached to their existing local message by ThreadSync/the publisher.
    // Allocating a second message here would race that acknowledgement's GitHub-ID constraint.
    if (this.storage && replyTo === undefined) {
      await reviewIdentity(this.storage, `${repo.toLowerCase()}/${number}`);
      this.storage.db.transaction(() => new PrActivity(this.storage!.db).comment(`${repo.toLowerCase()}/${number}`, comment, "issue_comment"))();
    }
    else if (this.storage) this.storage.db.query("UPDATE prs SET discussion_version=discussion_version+1 WHERE id=?").run(`${repo.toLowerCase()}/${number}`);
    return comment;
  }

  /** Publish one line comment against the exact head shown in the diff. */
  async inlineComment(repo: string, number: string, commitId: string, comment: DraftComment & { start_line?: number; start_side?: "LEFT" | "RIGHT" }, requestId?: string) {
    const endpoint = pullEndpoint(repo, number);
    const published = await this.publishComment(repo, number, "inline", comment.body, requestId, async (body) => {
      const pr = await this.get<PullRequest>(endpoint);
      if (pr.head.sha !== commitId) throw new Error("The PR has new commits. Refresh and check your comment against the latest changes before submitting.");
      return this.write(`${endpoint}/comments`, { commit_id: commitId, path: comment.path, side: comment.side, line: comment.line, ...(comment.start_line ? { start_line: comment.start_line, start_side: comment.start_side } : {}), body });
    });
    if (this.storage) this.storage.db.query("UPDATE prs SET discussion_version=discussion_version+1 WHERE id=?").run(`${repo.toLowerCase()}/${number}`);
    return published;
  }

  /** Recover a published inline comment before requiring its old hunk to still exist. */
  async submittedComment(repo: string, number: string, requestId: string): Promise<DiscussionComment | undefined> {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(requestId)) throw new Error("Invalid comment submission ID");
    const pending = this.commentWrites.get(`${repo.toLowerCase()}/${number}:${requestId}`);
    if (pending) return pending;
    const marker = `<!-- biff:${requestId}:${requestId} -->`;
    return (await this.pages<DiscussionComment>(`${pullEndpoint(repo, number)}/comments`)).find((comment) => comment.body?.trimEnd().endsWith(marker));
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
      if (body === undefined) {
        if (this.storage) new PrActivity(this.storage.db).changeComment(`${repo.toLowerCase()}/${number}`, id, kind);
        return;
      }
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
    if (this.storage) new PrActivity(this.storage.db).changeComment(`${repo.toLowerCase()}/${number}`, id, kind, body);
  }

  /** Share head, checks, and current approvals between discovered requests and retained reviews. */
  private rememberDashboardPR(pr: DashboardPR, viewer: string): PullRequestSummary {
    const head = pr.commits.nodes.at(-1)?.commit;
    if (pr.baseRefOid) this.dashboardComparisons.set(`${pr.repository.nameWithOwner.toLowerCase()}/${pr.number}`, { head: pr.headRefOid, base: pr.baseRefOid });
    this.dashboardMetadata.set(`${pr.repository.nameWithOwner.toLowerCase()}/${pr.number}`, {
      head: pr.headRefOid, headAuthor: head?.author.user?.login || "",
      ...reviewStatus(pr, viewer),
    });
    return { number: pr.number, title: pr.title, url: pr.url, repository: pr.repository, author: pr.author ?? { login: "ghost" }, isDraft: pr.isDraft, updatedAt: pr.updatedAt, createdAt: pr.createdAt };
  }

  /** Share the authenticated identity for this server lifetime, retrying failed lookups. */
  viewerLogin(): Promise<string> {
    this.viewer ??= this.get<{ login: string }>("user").then((user) => user.login).catch((error) => { this.viewer = undefined; throw error; });
    return this.viewer;
  }

  /** Retry only read-only GitHub requests, using HTTP/1.1 after a broken HTTP/2 stream. */
  private async read(args: string[]): Promise<string> {
    try { return await this.run(args); }
    catch (cause) {
      if (!isConnectionError(cause)) throw cause;
      try { return await this.run(args, { env: { GODEBUG: [process.env.GODEBUG, "http2client=0"].filter(Boolean).join(",") } }); }
      catch (retry) {
        if (!isConnectionError(retry)) throw retry;
        throw new Error("GitHub connection was interrupted. Your saved notes are safe; retry to check GitHub.");
      }
    }
  }

  private async get<T>(endpoint: string): Promise<T> { return JSON.parse(await this.read(["gh", "api", endpoint])); }
  private async pages<T>(endpoint: string): Promise<T[]> {
    const pages: T[][] = JSON.parse(await this.read(["gh", "api", `${endpoint}${endpoint.includes("?") ? "&" : "?"}per_page=100`, "--paginate", "--slurp"]));
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
  return { ...comment, body: (comment.body ?? "").replace(/\n\n<!-- biff:[a-f0-9-]+:[a-f0-9-]+ -->\s*$/, "") };
}

/** Validate URL segments before they become gh endpoint arguments. */
function pullEndpoint(repo: string, number: string): string {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !/^[1-9]\d*$/.test(number)) throw new Error("Invalid GitHub repository or PR number.");
  return `repos/${repo}/pulls/${number}`;
}

/** Transport failures do not say whether a write reached GitHub; HTTP validation errors are different. */
function isConnectionError(cause: unknown): boolean {
  const message = cause instanceof Error ? cause.message : String(cause);
  return /GitHub connection was interrupted|stream error:.*(?:CANCEL|INTERNAL_ERROR|REFUSED_STREAM)|HTTP\/2|connection reset|unexpected EOF|TLS handshake timeout|i\/o timeout|timeout awaiting response headers/i.test(message);
}

/** Normalize the same GitHub status fields for both the queue and an independently opened PR. */
function reviewStatus(pr: StatusPR, viewer: string) {
  const check = pr.commits.nodes.at(-1)?.commit.statusCheckRollup?.state;
  // GitHub keeps each reviewer's current decision here, so a later
  // comment-only review does not hide an existing approval.
  const approvers = pr.latestOpinionatedReviews.nodes.flatMap((review) => review.state === "APPROVED" && review.author ? [review.author.login] : []).sort((a, b) => a.localeCompare(b));
  const changeRequesters = pr.latestOpinionatedReviews.nodes.flatMap((review) => review.state === "CHANGES_REQUESTED" && review.author ? [review.author.login] : []).sort((a, b) => a.localeCompare(b));
  return {
    reviewDecision: pr.reviewDecision || "REVIEW_REQUIRED", approvers, changeRequesters,
    reviewRequested: pr.reviewRequests?.nodes.some((request) => request.requestedReviewer?.login?.toLowerCase() === viewer.toLowerCase()) ?? false,
    checks: check === "SUCCESS" ? "Passing" : check === "FAILURE" || check === "ERROR" ? "Failing" : check ? "Pending" : "No checks",
  };
}

/** Keep failed jobs and statuses; missing or unsafe provider URLs fall back to GitHub checks. */
function failedCheck(context: CheckContext | null, fallback: string): FailedCheck | undefined {
  if (!context) return;
  const failed = context.__typename === "CheckRun"
    ? ["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(context.conclusion ?? "")
    : ["FAILURE", "ERROR"].includes(context.state);
  if (!failed) return;

  const target = context.__typename === "CheckRun" ? context.detailsUrl || context.url : context.targetUrl;
  let url = fallback;
  try {
    const parsed = new URL(target ?? "");
    if (parsed.protocol === "https:" || parsed.protocol === "http:") url = parsed.href;
  } catch { /* Some providers omit a details URL; GitHub still has the check's result. */ }
  return { name: context.__typename === "CheckRun" ? context.name : context.context, url };
}
