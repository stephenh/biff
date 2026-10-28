import { beforeEach, describe, expect, test } from "bun:test";
import { GitHub } from "../server/github";
import { createApi } from "../server/api";
import { Workspaces } from "../server/workspaces";
import { Storage } from "../server/storage";
import type { CommandOptions } from "../server/commands";
import type { DiscussionComment } from "../shared/types";

const head = "a".repeat(40);
const base = "b".repeat(40);
const commit = "c".repeat(40);

describe("github", () => {
  let github: GitHub;
  let written: unknown[];
  let resolved: boolean;
  beforeEach(() => {
    written = [];
    resolved = false;
    github = new GitHub(runFixture);
  });

  /** Simulate GitHub at the command boundary without making network writes. */
  async function runFixture(args: string[], options?: CommandOptions): Promise<string> {
    const endpoint = args[2];
    if (endpoint === "graphql") {
      const query = args.find((arg) => arg.startsWith("query="))!;
      if (query.includes("reviewThreads(")) {
        if (!args.includes("--paginate") || !args.includes("--slurp")) throw new Error("Review threads must include all pages");
        return JSON.stringify([1, 2].map((id) => ({ data: { repository: { pullRequest: { reviewThreads: { nodes: [{ id: `THREAD_${id}`, isResolved: resolved, viewerCanResolve: true, viewerCanUnresolve: true, comments: { nodes: [{ databaseId: id }] } }] } } } } })));
      }
      if (query.includes("resolveReviewThread(")) {
        if (!args.includes("threadId=THREAD_2")) throw new Error("Wrong thread ID");
        resolved = !query.includes("unresolveReviewThread(");
        return JSON.stringify({ data: { [resolved ? "resolveReviewThread" : "unresolveReviewThread"]: { thread: { id: "THREAD_2", isResolved: resolved, viewerCanResolve: !resolved, viewerCanUnresolve: resolved } } } });
      }
      if (query.includes("mentionableUsers")) {
        if (!args.includes("owner=example") || !args.includes("name=project")) throw new Error("Unexpected mention repository");
        const users = [{ login: "reviewer-hb", name: "Repository Reviewer" }];
        return JSON.stringify([{ data: { repository: { mentionableUsers: { nodes: users } } } }]);
      }
      if (query.includes("mutation")) {
        written.push({ viewed: query.includes("markFileAsViewed(") && !query.includes("unmarkFileAsViewed("), path: args.find((arg) => arg.startsWith("path="))?.slice(5), pullRequestId: args.find((arg) => arg.startsWith("pullRequestId="))?.slice(14) });
        return JSON.stringify({ data: {} });
      }
      return JSON.stringify([
        { data: { repository: { pullRequest: { files: { nodes: [{ path: "src/viewed.ts", viewerViewedState: "VIEWED" }, { path: "src/changed.ts", viewerViewedState: "DISMISSED" }] } } } } },
        { data: { repository: { pullRequest: { files: { nodes: [{ path: "src/new.ts", viewerViewedState: "UNVIEWED" }] } } } } },
      ]);
    }
    if (options?.input) {
      const body: unknown = JSON.parse(options.input);
      written.push(body);
      return JSON.stringify({ id: 42, submitted: body });
    }
    if (endpoint === "repos/example/project/pulls/12") return JSON.stringify({ node_id: "PR_example", head: { sha: head }, base: { sha: base } });
    if (endpoint === "user") return JSON.stringify({ login: "me" });
    if (endpoint === "repos/example/project/pulls/12/commits?per_page=100") return JSON.stringify([[{ sha: commit }], [{ sha: head }]]);
    if (endpoint === `repos/example/project/compare/${base}...${head}`) return "full PR diff";
    if (endpoint === `repos/example/project/commits/${commit}`) return "single commit diff";
    if (endpoint.endsWith("/comments?per_page=100")) return JSON.stringify([[{ id: 1, body: "First comment" }], [{ id: 2, body: "Second comment" }]]);
    if (endpoint.endsWith("/reviews?per_page=100")) return JSON.stringify([[{ id: 3 }]]);
    throw new Error(`Unexpected fixture endpoint: ${endpoint}`);
  }

  test("full PR diffs use pinned base and head SHAs", async () => {
    // Given a PR whose head could change after metadata is fetched
    // When its full diff is loaded
    const review = await github.review("example/project", "12", "all");

    // Then it uses the diff for the exact metadata SHAs
    expect(review.patch).toBe("full PR diff");
  });

  test("individual commits can be selected from paginated PR commits", async () => {
    // Given a PR with more than one page of commits
    // When one commit is selected
    const review = await github.review("example/project", "12", commit);

    // Then the single-commit diff is returned with the complete commit list
    expect(review.patch).toBe("single commit diff");
    expect(review.commits.map((entry) => entry.sha)).toEqual([commit, head]);
  });

  test("discussion includes comments beyond the first page", async () => {
    // Given a paginated conversation
    // When discussion is loaded
    const discussion = await github.conversation("example/project", "12");

    // Then inline comments from both pages are present
    expect(discussion.inline.map((comment) => comment.id)).toEqual([1, 2]);
  });

  test("reviews preserve inline coordinates and markdown in the posted body", async () => {
    // Given a review of the current head, including an old-side comment
    const submission = { event: "COMMENT" as const, commitId: head, body: "Summary\n\n`code`", comments: [{ path: "src/file.ts", line: 12, side: "LEFT" as const, body: "Please retain this.\nThanks!" }] };

    // When the review is submitted
    await github.submitReview("example/project", "12", submission);

    // Then GitHub receives the exact reviewed commit and line coordinates
    expect(written).toEqual([{ event: "COMMENT", commit_id: head, body: submission.body, comments: submission.comments }]);
  });

  test("a push after loading the diff prevents posting stale line comments", async () => {
    // Given a review composed against an older head
    const submission = { event: "APPROVE" as const, commitId: commit, body: "", comments: [] };

    // When the review is submitted
    const result = github.submitReview("example/project", "12", submission);

    // Then submission fails without publishing anything
    await expect(result).rejects.toThrow("The PR has new commits.");
    expect(written).toEqual([]);
  });

  test("the local API rejects cross-origin mutation requests", async () => {
    // Given a request from an unrelated website
    const api = createApi({ github, workspaces: new Workspaces(new Storage()) });
    const request = new Request("http://127.0.0.1:4567/api/github/pr/example/project/12/comment", {
      method: "POST", headers: { Origin: "https://example.com", "Content-Type": "application/json" }, body: JSON.stringify({ body: "Should not be sent" }),
    });

    // When the daemon handles it
    const response = await api(request);

    // Then the mutation is refused
    expect(response.status).toBe(403);
    expect(written).toEqual([]);
  });

  test("viewed files include dismissed marks and later pages", async () => {
    // Given GitHub returns two pages of personal viewed marks
    // When the file states are loaded
    const result = await github.viewedFiles("example/project", "12");

    // Then every file retains its GitHub state
    expect(result).toEqual({ files: { "src/viewed.ts": "VIEWED", "src/changed.ts": "DISMISSED", "src/new.ts": "UNVIEWED" } });
  });

  test("marking a file viewed uses its exact path and PR node ID", async () => {
    // Given a path with spaces and Unicode
    const path = "src/a file 日本語.ts";

    // When the file is marked viewed
    await github.setFileViewed("example/project", "12", path, true);

    // Then GitHub receives the personal viewed mutation for that file
    expect(written).toEqual([{ viewed: true, path, pullRequestId: "PR_example" }]);
  });

  test("unmarking a viewed file clears its GitHub mark", async () => {
    // Given a previously viewed file
    // When its viewed mark is cleared
    await github.setFileViewed("example/project", "12", "src/viewed.ts", false);

    // Then GitHub receives the inverse mutation
    expect(written).toEqual([{ viewed: false, path: "src/viewed.ts", pullRequestId: "PR_example" }]);
  });

  test("immediate inline comments preserve old-side line coordinates", async () => {
    // Given a line comment composed against the current head
    const comment = { path: "src/a file.ts", line: 12, side: "LEFT" as const, body: "Keep this line.\n日本語" };
    const api = createApi({ github, workspaces: new Workspaces(new Storage()) });

    // When the inline-comment endpoint receives it
    const response = await api(new Request("http://127.0.0.1:4567/api/github/pr/example/project/12/inline-comment", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ commitId: head, comment }),
    }));
    if (!response.ok) throw new Error(await response.text());

    // Then GitHub receives the exact reviewed commit, side, and text
    expect(written).toEqual([{ commit_id: head, ...comment }]);
  });

  test("a stale head prevents immediate line comments", async () => {
    // Given a line comment composed before a push
    const comment = { path: "src/file.ts", line: 3, side: "RIGHT" as const, body: "Old coordinate" };

    // When it is submitted against the previous head
    const result = github.inlineComment("example/project", "12", commit, comment);

    // Then GitHub publication is rejected
    await expect(result).rejects.toThrow("The PR has new commits.");
  });

  test("the mentions endpoint searches users within the PR repository", async () => {
    // Given a PR with repository-specific mentionable users
    const api = createApi({ github, workspaces: new Workspaces(new Storage()) });

    // When a username prefix is searched through the local API
    const response = await api(new Request("http://127.0.0.1:4567/api/github/pr/example/project/12/mentions?q=review"));

    // Then matching GitHub usernames and display names are returned
    expect(await response.json()).toEqual([{ login: "reviewer-hb", name: "Repository Reviewer" }]);
  });

  test("mention search text is bounded before invoking GitHub", async () => {
    // Given an oversized search
    const search = "a".repeat(101);

    // When repository users are searched
    const result = github.mentionUsers("example/project", "12", search);

    // Then the invalid query is rejected
    await expect(result).rejects.toThrow("Mention search is too long");
  });

  test("full PR context uses the merge base and both renamed paths", async () => {
    // Given a PR whose target branch has advanced beyond its merge base
    const service = new GitHub(contextFixture);

    // When a renamed file's omitted context is requested
    const result = await service.contents("example/project", "12", head, base, "new file.ts", "old file.ts", false);

    // Then each side uses its exact path and immutable comparison revision
    expect(result).toEqual({ oldFile: { name: "old file.ts", contents: "before\n" }, newFile: { name: "new file.ts", contents: "after\n" } });
  });

  /** Reject any endpoint that uses the target branch instead of the merge base. */
  async function contextFixture(args: string[]): Promise<string> {
    if (args[2] === `repos/example/project/compare/${base}...${head}`) return JSON.stringify({ merge_base_commit: { sha: commit } });
    if (args[2] === `repos/example/project/contents/old%20file.ts?ref=${commit}`) return "before\n";
    if (args[2] === `repos/example/project/contents/new%20file.ts?ref=${head}`) return "after\n";
    throw new Error(`Unexpected context endpoint: ${args[2]}`);
  }

  test("inline comments include their paginated GitHub thread state", async () => {
    // Given two pages of GitHub review threads
    // When loading the conversation
    const conversation = await github.conversation("example/project", "12");

    // Then the second page's root carries the actual thread ID and permissions
    expect(conversation.inline[1].reviewThread).toEqual({ id: "THREAD_2", resolved: false, canResolve: true, canReopen: true });
  });

  test("resolving a thread updates GitHub's conversation state", async () => {
    // Given an open GitHub thread
    // When resolving it through its opaque GraphQL ID
    await github.resolveThread("example/project", "12", "THREAD_2", true);
    const conversation = await github.conversation("example/project", "12");

    // Then a fresh read shows it resolved
    expect(conversation.inline[1].reviewThread?.resolved).toBe(true);
  });

  test("a resolved GitHub thread can be reopened", async () => {
    // Given a resolved thread
    resolved = true;

    // When reopening it
    await github.resolveThread("example/project", "12", "THREAD_2", false);
    const conversation = await github.conversation("example/project", "12");

    // Then a fresh read shows it open
    expect(conversation.inline[1].reviewThread?.resolved).toBe(false);
  });

  test("a thread outside the selected PR cannot be resolved", async () => {
    // Given a thread ID absent from this PR
    // When attempting to resolve it
    const result = github.resolveThread("example/project", "12", "OTHER_THREAD", true);

    // Then no unrelated thread can be mutated
    await expect(result).rejects.toThrow("Thread not found in this PR");
  });

  test("full source for an added file has an empty old side", async () => {
    // Given a file that exists only at the PR head
    const service = new GitHub(fileSourceFixture(new Error("gh: Not Found (HTTP 404)"), "export const added = true;\n"));

    // When its full source is loaded
    const contents = await service.contents("example/project", "12", head, base, "file.ts", "file.ts", false);

    // Then the available source is retained with an empty old file
    expect(contents).toEqual({ oldFile: { name: "file.ts", contents: "" }, newFile: { name: "file.ts", contents: "export const added = true;\n" } });
  });

  test("full source for a deleted file has an empty new side", async () => {
    // Given a file that exists only at the merge base
    const service = new GitHub(fileSourceFixture("export const removed = true;\n", new Error("gh: Not Found (HTTP 404)")));

    // When its full source is loaded
    const contents = await service.contents("example/project", "12", head, base, "file.ts", "file.ts", false);

    // Then the available source is retained with an empty new file
    expect(contents).toEqual({ oldFile: { name: "file.ts", contents: "export const removed = true;\n" }, newFile: { name: "file.ts", contents: "" } });
  });

  test("source loading preserves GitHub errors other than missing paths", async () => {
    // Given a successful old-file read and a rate-limited new-file request
    const service = new GitHub(fileSourceFixture("before\n", new Error("gh: API rate limit exceeded (HTTP 403)")));

    // When full source is requested
    const result = service.contents("example/project", "12", head, base, "file.ts", "file.ts", false);

    // Then the failure is not treated as a deleted file
    await expect(result).rejects.toThrow("API rate limit exceeded");
  });

  test("missing source on both sides remains a failure", async () => {
    // Given a missing path or repository access denied with GitHub's 404 response
    const service = new GitHub(fileSourceFixture(new Error("gh: Not Found (HTTP 404)"), new Error("gh: Not Found (HTTP 404)")));

    // When full source is requested
    const result = service.contents("example/project", "12", head, base, "file.ts", "file.ts", false);

    // Then search can report the failure instead of indexing fake empty source
    await expect(result).rejects.toThrow("File not found on either side of this diff");
  });

  test("single-commit source supports an added empty file", async () => {
    // Given a valid empty file added by the selected commit
    const service = new GitHub(fileSourceFixture(new Error("gh: Not Found (HTTP 404)"), ""));

    // When source is loaded against that commit's parent
    const contents = await service.contents("example/project", "12", head, base, "file.ts", "file.ts", true);

    // Then an empty successful response is distinct from missing source on both sides
    expect(contents).toEqual({ oldFile: { name: "file.ts", contents: "" }, newFile: { name: "file.ts", contents: "" } });
  });
  test("dashboard activity combines paginated replies with published reviews", async () => {
    // Given paginated discussion and a pending draft review
    const service = new GitHub(dashboardFixture);
    await service.dashboard("authored");

    // When activity is fetched for the dashboard
    const activity = await service.dashboardActivity("example/project", "12");

    // Then distinct comment types retain their identities and draft reviews stay private
    expect(activity.events.map((event) => event.key)).toEqual(["general:1", "general:2", "inline:1", "review:3"]);
  });

  test("dashboard check failures use GitHub's combined check status", async () => {
    // Given GitHub reports a failed check rollup
    const service = new GitHub(dashboardFixture);
    await service.dashboard("authored");

    // When the dashboard loads status
    const activity = await service.dashboardActivity("example/project", "12");

    // Then the PR is shown as failing
    expect(activity.checks).toEqual("Failing");
  });

  test("legacy Dependabot discovery links search the unified review queue", async () => {
    // Given the GitHub command boundary
    const searches: string[] = [];
    const service = new GitHub(async (args) => {
      searches.push(...args.filter((arg) => arg.startsWith("search=")));
      return dashboardFixture(args);
    });
    // When an old dependency queue link loads
    await service.dashboard("dependabot");
    // Then discovery includes all review requests
    expect(searches).toEqual([
      "search=is:pr is:open review-requested:me sort:updated-desc",
    ]);
  });

  test("review requests include Dependabot at the search boundary", async () => {
    // Given the GitHub command boundary
    const searches: string[] = [];
    const service = new GitHub(async (args) => {
      searches.push(...args.filter((arg) => arg.startsWith("search=")));
      return dashboardFixture(args);
    });
    // When the review queue loads
    await service.dashboard("requested");
    // Then discovery does not exclude dependency updates
    expect(searches).toEqual([
      "search=is:pr is:open review-requested:me sort:updated-desc",
    ]);
  });

  test("saved activity without thread membership reloads GitHub's reply relationships", async () => {
    // Given a saved snapshot from before activity included thread membership
    const service = new GitHub(async (args) => {
      if (args[2].includes("/pulls/12/comments?")) return JSON.stringify([
        [{ id: 1, user: { login: "me" }, created_at: "2026-10-18" }],
        [{ id: 2, in_reply_to_id: 1, user: { login: "author" }, created_at: "2026-10-19" }],
      ]);
      return dashboardFixture(args);
    });
    await service.dashboard("authored");
    const previous = { head, headAuthor: "author", reviewDecision: "APPROVED", checks: "Failing", events: [
      { key: "inline:1", actor: "me", at: "2026-10-18", kind: "reply" as const },
    ] };

    // When unchanged activity is refreshed from the old cache
    const activity = await service.dashboardActivity("example/project", "12", previous);

    // Then paginated root comments and replies share the root's identity
    expect(activity.events.filter((event) => event.key.startsWith("inline:") && event.thread)).toEqual([
      { key: "inline:1", thread: "inline:1", actor: "me", at: "2026-10-18", kind: "reply" },
      { key: "inline:2", thread: "inline:1", actor: "author", at: "2026-10-19", kind: "reply" },
    ]);
  });
  test("tracked reviews are fetched in batches of at most 25", async () => {
    // Given 51 known PRs whose requests have disappeared
    const batches: number[] = [];
    const service = new GitHub(async (args) => {
      const query = args.find((arg) => arg.startsWith("query="));
      if (query) batches.push([...query.matchAll(/p\d+: repository/g)].length);
      return trackedFixture(args);
    });

    // When refreshing only their explicit repository/number identities
    await service.trackedPullRequests(Array.from({ length: 51 }, (_, index) => `example/project/${index + 1}`));

    // Then bounded GraphQL batches replace individual lookups or history searches
    expect(batches).toEqual([25, 25, 1]);
  });

  test("missing tracked PR responses are not interpreted as closed", async () => {
    // Given an inaccessible repository in an otherwise successful GitHub response
    const service = new GitHub(async (args) => {
      return args[2] === "graphql" ? JSON.stringify({ data: { p0: null } }) : dashboardFixture(args);
    });

    // When checking the remembered review
    const result = service.trackedPullRequests(["example/project/12"]);

    // Then refresh fails instead of authorizing removal from the queue
    await expect(result).rejects.toThrow("Could not refresh tracked PR example/project/12");
  });

  test("tracked PRs supply the same cached activity metadata as discovery", async () => {
    // Given a known PR loaded without a discovery search
    const service = new GitHub(trackedFixture);
    await service.trackedPullRequests(["example/project/12"]);

    // When the inbox refreshes its activity
    const activity = await service.dashboardActivity("example/project", "12");

    // Then the retained review has its current head and checks
    expect(activity).toMatchObject({ head, checks: "Failing" });
  });

  test("manual recovery routes GraphQL's Dependabot author to review requests", async () => {
    // Given GitHub's GraphQL bot login without REST's [bot] suffix
    const service = new GitHub(async (args) => {
      const response = await trackedFixture(args);
      if (args[2] !== "graphql") return response;
      const result = JSON.parse(response) as { data: { p0: { pullRequest: { author: { login: string } } } } };
      result.data.p0.pullRequest.author.login = "dependabot";
      return JSON.stringify(result);
    });

    // When manually recovering a dependency PR
    const [result] = await service.trackedPullRequests(["example/project/12"]);

    // Then it returns to the shared review queue
    expect(result.view).toBe("requested");
  });

  test("tracked merged PRs report their GitHub merge time for retention", async () => {
    // Given a PR merged before its most recent comment update
    const service = new GitHub(async (args) => {
      const response = await trackedFixture(args);
      if (args[2] !== "graphql") return response;
      const result = JSON.parse(response) as { data: { p0: { pullRequest: Record<string, unknown> } } };
      Object.assign(result.data.p0.pullRequest, { state: "MERGED", mergedAt: "2026-10-01T00:00:00Z", closedAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-20T00:00:00Z" });
      return JSON.stringify(result);
    });

    // When refreshing the tracked PR
    const [result] = await service.trackedPullRequests(["example/project/12"]);

    // Then later comments cannot reset the retention clock
    expect(result.closedAt).toBe("2026-10-01T00:00:00Z");
  });

  test("the inline API forwards a stable submission receipt to GitHub", async () => {
    // Given a comment submitted with an idempotency key
    const fixture = publicationFixture();
    const service = new GitHub(fixture.run);
    const storage = new Storage();
    const api = createApi({ github: service, workspaces: new Workspaces(storage) });
    const id = "10000000-0000-4000-8000-000000000001";
    const body = { commitId: head, comment: { path: "src/file.ts", line: 3, side: "RIGHT", body: "Publish only once" } };

    try {
      // When the same submission is sent twice
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await api(new Request("http://127.0.0.1:4567/api/github/pr/example/project/12/inline-comment", {
          method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": id }, body: JSON.stringify(body),
        }));
        if (!response.ok) throw new Error(await response.text());
      }

      // Then GitHub receives one comment with a recoverable receipt
      expect(fixture.state.comments.map((comment) => comment.body)).toEqual([`Publish only once\n\n<!-- biff:${id}:${id} -->`]);
    } finally { await storage.close(); }
  });

  test("a retry recovers a reply whose GitHub response was lost", async () => {
    // Given GitHub accepted the reply but its command response was lost
    const fixture = publicationFixture();
    fixture.state.loseResponse = true;
    const service = new GitHub(fixture.run);
    const id = "10000000-0000-4000-8000-000000000002";
    await service.comment("example/project", "12", "Keep this reply", 42, id).catch(() => {});

    // When the same submission is retried
    await service.comment("example/project", "12", "Keep this reply", 42, id);

    // Then no duplicate reply is created
    expect(fixture.state.comments.map((comment) => comment.id)).toEqual([1]);
  });

  test("a receipt recovers across restart even if the PR head changed", async () => {
    // Given an inline comment successfully published against the old head
    const fixture = publicationFixture();
    const id = "10000000-0000-4000-8000-000000000003";
    const comment = { path: "src/file.ts", line: 3, side: "RIGHT" as const, body: "Already published" };
    await new GitHub(fixture.run).inlineComment("example/project", "12", head, comment, id);
    // And the PR receives new commits before the server restarts
    fixture.state.head = base;

    // When a fresh service receives a retry of the old submission
    const recovered = await new GitHub(fixture.run).inlineComment("example/project", "12", head, comment, id);

    // Then it returns the already-published comment rather than posting stale coordinates
    expect(recovered.id).toBe(1);
  });

  test("concurrent retries publish a submission only once", async () => {
    // Given two simultaneous requests with the same receipt
    const fixture = publicationFixture();
    const service = new GitHub(fixture.run);
    const id = "10000000-0000-4000-8000-000000000004";

    // When both requests reach the service
    await Promise.all([service.comment("example/project", "12", "One reply", 42, id), service.comment("example/project", "12", "One reply", 42, id)]);

    // Then only one remote comment exists
    expect(fixture.state.comments.length).toBe(1);
  });

  test("invalid submission IDs are rejected before publication", async () => {
    // Given an invalid receipt supplied by a client
    const fixture = publicationFixture();
    const service = new GitHub(fixture.run);

    // When it is used to publish a reply
    const result = service.comment("example/project", "12", "Do not publish", 42, "invalid");

    // Then the malformed receipt is rejected
    await expect(result).rejects.toThrow("Invalid comment submission ID");
  });

  test("dashboard approval names include only reviewers whose current decision is approved", async () => {
    // Given current approvals, changed decisions, dismissed reviews, and a deleted reviewer
    const service = new GitHub(dashboardFixture);
    await service.dashboard("requested");

    // When the inbox loads approval metadata
    const activity = await service.dashboardActivity("example/project", "12");

    // Then only named, current approvers are listed in a stable order
    expect(activity.approvers).toEqual(["me", "reviewer"]);
  });

  test("retained PRs keep approver names after their review request disappears", async () => {
    // Given a known PR refreshed by identity instead of review-request discovery
    const service = new GitHub(trackedFixture);
    await service.trackedPullRequests(["example/project/12"]);

    // When its inbox activity loads
    const activity = await service.dashboardActivity("example/project", "12");

    // Then its approval list is available just like a newly discovered PR
    expect(activity.approvers).toEqual(["me", "reviewer"]);
  });

  test("fresh approval decisions replace cached approvers even when discussion is unchanged", async () => {
    // Given an unchanged conversation with a stale approval list
    const service = new GitHub(dashboardFixture);
    await service.dashboard("requested");
    const previous = { head, headAuthor: "author", reviewDecision: "APPROVED", checks: "Failing", events: [], approvers: ["dismissed"] };

    // When the inbox reuses discussion events after refreshing current GitHub metadata
    const activity = await service.dashboardActivity("example/project", "12", previous);

    // Then the cached approver is replaced rather than carried forward
    expect(activity.approvers).toEqual(["me", "reviewer"]);
  });

  test("the inbox discussion metadata endpoint returns the current PR head", async () => {
    // Given the public API backed by GitHub's PR metadata
    const storage = new Storage();
    const api = createApi({ github, workspaces: new Workspaces(storage) });

    // When discussion opens without asking for a diff snapshot
    const response = await api(new Request("http://127.0.0.1:4567/api/github/pr/example/project/12/metadata"));

    // Then review drafts can use the current PR head
    try { expect(await response.json()).toMatchObject({ head: { sha: head } }); }
    finally { await storage.close(); }
  });

  test("current review requests are refreshed even when discussion is unchanged", async () => {
    // Given a retained PR whose review request has been cleared on GitHub
    const service = new GitHub(async (args) => {
      if (args[2] !== "graphql") return trackedFixture(args);
      const response = JSON.parse(await trackedFixture(args)) as { data: { p0: { pullRequest: { reviewRequests: { nodes: { requestedReviewer: { login: string } }[] } } } } };
      response.data.p0.pullRequest.reviewRequests = { nodes: [{ requestedReviewer: { login: "someone-else" } }] };
      return JSON.stringify(response);
    });
    await service.trackedPullRequests(["example/project/12"]);

    // When old conversation events are reused alongside fresh request metadata
    const activity = await service.dashboardActivity("example/project", "12", { head, headAuthor: "author", reviewDecision: "APPROVED", checks: "Passing", events: [], reviewRequested: true });

    // Then an old request cannot keep the PR in Todo
    expect(activity.reviewRequested).toEqual(false);
  });

  test("a requested review is recognized independently of existing approval", async () => {
    // Given an approved PR requesting another review from me
    const service = new GitHub(async (args) => {
      if (args[2] !== "graphql") return trackedFixture(args);
      const response = JSON.parse(await trackedFixture(args)) as { data: { p0: { pullRequest: { reviewRequests: { nodes: { requestedReviewer: { login: string } }[] } } } } };
      response.data.p0.pullRequest.reviewRequests = { nodes: [{ requestedReviewer: { login: "me" } }] };
      return JSON.stringify(response);
    });
    await service.trackedPullRequests(["example/project/12"]);

    // When activity is assembled from the current GitHub state
    const activity = await service.dashboardActivity("example/project", "12");

    // Then approval does not cancel a newer outstanding request
    expect(activity.reviewRequested).toEqual(true);
  });
  test("editing another author's comment is rejected before GitHub mutation", async () => {
    // Given another author's comment in this PR
    const service = new GitHub(async (args) => {
      if (args[2] === "user") return JSON.stringify({ login: "me" });
      if (args[2].endsWith("/comments?per_page=100")) return JSON.stringify([[{ id: 1, body: "Original", user: { login: "alice" } }]]);
      throw new Error("Unexpected mutation");
    });

    // When the authenticated user tries editing it
    const result = service.changeComment("example/project", "12", 1, "inline", "Replacement");

    // Then repository permissions cannot bypass authorship
    await expect(result).rejects.toThrow("You can only change your own comments.");
  });

  test("deleting another author's general comment is rejected", async () => {
    // Given another author's PR discussion message
    const service = new GitHub(async (args) => {
      if (args[2] === "user") return JSON.stringify({ login: "me" });
      if (args[2].endsWith("/comments?per_page=100")) return JSON.stringify([[{ id: 1, body: "Original", user: { login: "alice" } }]]);
      throw new Error("Unexpected mutation");
    });

    // When the authenticated user tries deleting it
    const result = service.changeComment("example/project", "12", 1, "general");

    // Then the API rejects the mutation
    await expect(result).rejects.toThrow("You can only change your own comments.");
  });

  test("a cancelled HTTP2 read recovers through a read-only HTTP1 retry", async () => {
    // Given a GitHub connection which cancels HTTP2 streams
    const service = new GitHub(async (args, options) => {
      if (args[2] !== "repos/example/project/pulls/12") throw new Error("Unexpected endpoint");
      if (!options?.env?.GODEBUG.split(",").includes("http2client=0")) throw new Error("stream error: stream ID 1; CANCEL; received from peer");
      return JSON.stringify({ head: { sha: head } });
    });

    // When loading the PR through the normal adapter
    const pr = await service.pullRequest("example/project", "12");

    // Then a safe HTTP1 read recovers the actual PR state
    expect(pr.head.sha).toEqual(head);
  });

  test("a cancelled review response recovers the receipt without repeating the write", async () => {
    // Given a review accepted by GitHub before its response stream is cancelled
    const reviews: DiscussionComment[] = [];
    let writes = 0;
    const requestId = "11111111-1111-4111-8111-111111111111";
    const service = new GitHub(async (args, options) => {
      if (options?.input) {
        writes++;
        reviews.push({ id: 42, body: JSON.parse(options.input).body, state: "COMMENTED", user: { login: "me" }, html_url: "https://github.com/review/42" });
        throw new Error("stream error: stream ID 1; CANCEL; received from peer");
      }
      if (args[2].endsWith("/reviews?per_page=100")) return JSON.stringify([reviews]);
      if (args[2] === "repos/example/project/pulls/12") return JSON.stringify({ head: { sha: head } });
      throw new Error(`Unexpected endpoint ${args[2]}`);
    });

    // When publishing through the retry-safe review operation
    await service.submitReview("example/project", "12", { commitId: head, event: "COMMENT", body: "Keep my review.", comments: [] }, requestId);

    // Then recovering its receipt does not send a second review
    expect(writes).toEqual(1);
  });

  test("persistent stream cancellation reports unconfirmed publication rather than raw transport output", async () => {
    // Given an unavailable GitHub connection
    const service = new GitHub(async () => { throw new Error("stream error: stream ID 1; CANCEL; received from peer"); });

    // When a review cannot be checked or published
    const result = service.submitReview("example/project", "12", { commitId: head, event: "COMMENT", body: "Keep my review.", comments: [] }, "11111111-1111-4111-8111-111111111111");

    // Then the error explains the safe next action without claiming the review was rejected
    await expect(result).rejects.toThrow("Your review is saved in Biff, but publication is unconfirmed. Retry will check GitHub before resubmitting.");
  });

  test("an older attempt recovers a later review which published its exact comments", async () => {
    // Given a later successful review containing the same comments plus a new summary
    const commentId = "22222222-2222-4222-8222-222222222222";
    const published = { id: 42, body: "Still reading, comments so far...", state: "COMMENTED", user: { login: "me" }, html_url: "https://github.com/review/42" };
    const service = new GitHub(async (args, options) => {
      if (options?.input) throw new Error("An acknowledged comment must not be published again");
      if (args[2].endsWith("/reviews?per_page=100")) return JSON.stringify([[published]]);
      if (args[2].endsWith("/comments?per_page=100")) return JSON.stringify([[{ id: 101, body: `Same saved note.\n\n<!-- biff:${commentId}:${commentId} -->`, pull_request_review_id: 42 }]]);
      throw new Error(`Unexpected endpoint ${args[2]}`);
    });

    // When retrying the older summary-free attempt under its original submission ID
    const receipt = await service.submitReview("example/project", "12", { commitId: head, event: "COMMENT", body: "", comments: [{ id: commentId, path: "file.ts", line: 1, side: "RIGHT", body: "Same saved note." }] }, "11111111-1111-4111-8111-111111111111");

    // Then the existing acknowledged review fulfills that exact older intent
    expect(receipt.id).toEqual(42);
  });

  test("published inline comments cannot acknowledge a different unsent summary", async () => {
    // Given published comments but a summary which has never reached GitHub
    const commentId = "22222222-2222-4222-8222-222222222222";
    const service = new GitHub(async (args) => {
      if (args[2].endsWith("/reviews?per_page=100")) return JSON.stringify([[{ id: 42, body: "Another summary.", state: "COMMENTED" }]]);
      if (args[2].endsWith("/comments?per_page=100")) return JSON.stringify([[{ id: 101, body: `Same saved note.\n\n<!-- biff:${commentId}:${commentId} -->`, pull_request_review_id: 42 }]]);
      throw new Error(`Unexpected endpoint ${args[2]}`);
    });

    // When looking for a receipt for the unsent summary and those comments
    const receipt = await service.submittedReview("example/project", "12", "11111111-1111-4111-8111-111111111111", { commitId: head, event: "COMMENT", body: "Do not drop this summary.", comments: [{ id: commentId, path: "file.ts", line: 1, side: "RIGHT", body: "Same saved note." }] });

    // Then partial publication does not acknowledge the unsent words
    expect(receipt).toEqual(undefined);
  });

  test("receipt recovery cannot acknowledge edited comment words", async () => {
    // Given an existing publication of an earlier version of the same comment
    const commentId = "22222222-2222-4222-8222-222222222222";
    const service = new GitHub(async (args) => {
      if (args[2].endsWith("/reviews?per_page=100")) return JSON.stringify([[{ id: 42, body: "", state: "COMMENTED" }]]);
      if (args[2].endsWith("/comments?per_page=100")) return JSON.stringify([[{ id: 101, body: `The earlier words.\n\n<!-- biff:${commentId}:${commentId} -->`, pull_request_review_id: 42 }]]);
      throw new Error(`Unexpected endpoint ${args[2]}`);
    });

    // When checking whether the edited comment was published
    const receipt = await service.submittedReview("example/project", "12", "11111111-1111-4111-8111-111111111111", { commitId: head, event: "COMMENT", body: "", comments: [{ id: commentId, path: "file.ts", line: 1, side: "RIGHT", body: "The edited words, still unsent." }] });

    // Then an identity match alone cannot acknowledge unsent text
    expect(receipt).toEqual(undefined);
  });

  test("published comments do not acknowledge an unmet approval outcome", async () => {
    // Given a commented review that has not approved the PR
    const commentId = "22222222-2222-4222-8222-222222222222";
    const service = new GitHub(async (args) => {
      if (args[2].endsWith("/reviews?per_page=100")) return JSON.stringify([[{ id: 42, body: "", state: "COMMENTED" }]]);
      if (args[2].endsWith("/comments?per_page=100")) return JSON.stringify([[{ id: 101, body: `Same note.\n\n<!-- biff:${commentId}:${commentId} -->`, pull_request_review_id: 42 }]]);
      throw new Error(`Unexpected endpoint ${args[2]}`);
    });

    // When checking an approval containing those same words
    const receipt = await service.submittedReview("example/project", "12", "11111111-1111-4111-8111-111111111111", { commitId: head, event: "APPROVE", body: "", comments: [{ id: commentId, path: "file.ts", line: 1, side: "RIGHT", body: "Same note." }] });

    // Then a publication without the requested outcome is not success
    expect(receipt).toEqual(undefined);
  });

  test("an interrupted write without a receipt is not automatically repeated", async () => {
    // Given a write whose response is lost and no visible GitHub receipt
    let writes = 0;
    const service = new GitHub(async (args, options) => {
      if (options?.input) { writes++; throw new Error("stream error: stream ID 1; CANCEL; received from peer"); }
      if (args[2].endsWith("/reviews?per_page=100")) return "[[]]";
      if (args[2] === "repos/example/project/pulls/12") return JSON.stringify({ head: { sha: head } });
      throw new Error(`Unexpected endpoint ${args[2]}`);
    });

    // When publication is interrupted
    await service.submitReview("example/project", "12", { commitId: head, event: "COMMENT", body: "Keep my review.", comments: [] }, "11111111-1111-4111-8111-111111111111").catch(() => undefined);

    // Then receipt recovery never blindly repeats a write
    expect(writes).toEqual(1);
  });
  test("the authenticated identity stays fixed until a new server instance resolves it", async () => {
    // Given the identity resolved at startup
    let login = "first-account";
    const service = new GitHub(async () => JSON.stringify({ login }));
    await service.viewerLogin();

    // When gh's selected account changes during this server lifetime
    login = "second-account";

    // Then the running service continues using its startup identity
    expect(await service.viewerLogin()).toEqual("first-account");
  });

  test("a new server instance resolves the current gh account", async () => {
    // Given the account selected by gh before startup
    const service = new GitHub(async () => JSON.stringify({ login: "current-account" }));

    // When startup resolves the authenticated identity
    const login = await service.viewerLogin();

    // Then it uses gh's account instead of a cached PR's viewer
    expect(login).toEqual("current-account");
  });

  test("PR header status includes personal approval before all required reviews are complete", async () => {
    // Given my current approval, another pending review, and failing checks
    const service = new GitHub(statusFixture("APPROVED", "FAILURE"));

    // When a PR is opened directly without first loading the queue
    const status = await service.status("example/project", "12");

    // Then the header receives my approval and the same normalized CI status as the list
    expect(status).toEqual({ reviewDecision: "REVIEW_REQUIRED", approvers: ["Me", "other"], changeRequesters: [], checks: "Failing", reviewRequested: false, viewerHasApproved: true, viewerRequestedChanges: false, viewerReReviewRequested: false });
  });

  test("another reviewer's approval does not count as my approval", async () => {
    // Given my earlier approval was replaced with requested changes
    const service = new GitHub(statusFixture("CHANGES_REQUESTED", "SUCCESS"));

    // When the current status is read
    const status = await service.status("example/project", "12");

    // Then another reviewer's approval does not produce my check mark
    expect(status.viewerHasApproved).toEqual(false);
  });

  test("the PR status endpoint returns normalized indicators without loading the diff", async () => {
    // Given a standalone status lookup and no inbox or diff fixture
    const service = new GitHub(statusFixture("APPROVED", "ERROR"));
    const storage = new Storage();
    const api = createApi({ github: service, workspaces: new Workspaces(storage) });

    // When the header requests status
    const response = await api(new Request("http://localhost/api/github/pr/example/project/12/status"));
    await storage.close();

    // Then the route exposes the status summary
    expect(await response.json()).toEqual({ reviewDecision: "REVIEW_REQUIRED", approvers: ["Me", "other"], changeRequesters: [], checks: "Failing", reviewRequested: false, viewerHasApproved: true, viewerRequestedChanges: false, viewerReReviewRequested: false });
  });

  test("partial GraphQL errors do not masquerade as successful PR status", async () => {
    // Given GitHub could not read status
    const service = new GitHub(async (args) => args[2] === "user" ? JSON.stringify({ login: "me" }) : JSON.stringify({ errors: [{ message: "Status unavailable" }] }));

    // When the header requests status
    const result = service.status("example/project", "12");

    // Then no approval or passing status is invented
    await expect(result).rejects.toThrow("Status unavailable");
  });

  test("removing my review request preserves other reviewers, teams, and approvals", async () => {
    // Given an outstanding request with different login casing beside other reviewers and an existing approval
    const remote = { state: "open", requested_reviewers: [{ login: "Me" }, { login: "other" }], requested_teams: [{ slug: "backend" }], reviews: [{ user: "me", state: "APPROVED" }] };
    const service = new GitHub(async (args, options) => {
      if (args[2] === "user") return JSON.stringify({ login: "me" });
      if (args[2] === "repos/example/project/pulls/12") return JSON.stringify(remote);
      if (args[2] !== "repos/example/project/pulls/12/requested_reviewers" || args[4] !== "DELETE") throw new Error("Unexpected GitHub write");
      const body = JSON.parse(options!.input!) as { reviewers: string[] };
      remote.requested_reviewers = remote.requested_reviewers.filter((reviewer) => !body.reviewers.some((login) => login.toLowerCase() === reviewer.login.toLowerCase()));
      return JSON.stringify(remote);
    });

    // When I remove my outstanding request
    await service.removeReviewRequest("example/project", "12");

    // Then only my individual request is removed
    expect(remote).toEqual({ state: "open", requested_reviewers: [{ login: "other" }], requested_teams: [{ slug: "backend" }], reviews: [{ user: "me", state: "APPROVED" }] });
  });

  test("removing an already absent review request requires no GitHub write", async () => {
    // Given the request was already cleared by a review or an earlier interrupted archive
    const service = new GitHub(async (args, options) => {
      if (options?.input) throw new Error("An absent request must not be removed again");
      return args[2] === "user" ? JSON.stringify({ login: "me" }) : JSON.stringify({ state: "open", requested_reviewers: [{ login: "other" }] });
    });

    // When archive retries the removal
    const result = service.removeReviewRequest("example/project", "12");

    // Then the absent request is already satisfied
    await expect(result).resolves.toBeUndefined();
  });

  test("closed PRs can be archived without changing GitHub reviewers", async () => {
    // Given a closed PR whose reviewer list is no longer actionable
    const service = new GitHub(async (args, options) => {
      if (options?.input) throw new Error("Closed PRs must not receive reviewer writes");
      return args[2] === "user" ? JSON.stringify({ login: "me" }) : JSON.stringify({ state: "closed", requested_reviewers: [{ login: "me" }] });
    });

    // When the closed PR is archived
    const result = service.removeReviewRequest("example/project", "12");

    // Then there is no outstanding request to clear
    await expect(result).resolves.toBeUndefined();
  });

  test("reviewer removal reports GitHub permission failures", async () => {
    // Given GitHub allows reading the request but not removing it
    const service = new GitHub(async (args, options) => {
      if (options?.input) throw new Error("Resource not accessible (HTTP 403)");
      return args[2] === "user" ? JSON.stringify({ login: "me" }) : JSON.stringify({ state: "open", requested_reviewers: [{ login: "me" }] });
    });

    // When archive attempts the removal
    const result = service.removeReviewRequest("example/project", "12");

    // Then the caller can keep the failed save visible for retry
    await expect(result).rejects.toThrow("Resource not accessible (HTTP 403)");
  });

  test("direct PR status distinguishes a re-review request from my earlier approval", async () => {
    // Given my approval and a newly outstanding request with different login casing
    const service = new GitHub(statusFixture("APPROVED", "SUCCESS", true));

    // When the PR is opened without first visiting the inbox
    const status = await service.status("example/project", "12");

    // Then the header receives the pending re-review without losing the approval history
    expect(status).toMatchObject({ reviewRequested: true, viewerHasApproved: true, viewerReReviewRequested: true });
  });

  test("an initial review request is not labeled as a re-review", async () => {
    // Given my first outstanding request and only another reviewer's approval
    const service = new GitHub(statusFixture("COMMENTED", "SUCCESS", true));

    // When reading PR status
    const status = await service.status("example/project", "12");

    // Then another person's approval does not turn my request into a re-review
    expect(status).toMatchObject({ reviewRequested: true, viewerHasApproved: false, viewerReReviewRequested: false });
  });

  test("direct PR status identifies my requested changes beside someone else's approval", async () => {
    // Given my change request and another reviewer's current approval
    const service = new GitHub(statusFixture("CHANGES_REQUESTED", "SUCCESS"));

    // When the PR header loads its status directly
    const status = await service.status("example/project", "12");

    // Then the overall decision is attributed to me only because my review requested changes
    expect(status).toMatchObject({ approvers: ["other"], changeRequesters: ["Me"], viewerRequestedChanges: true });
  });
});

/** Model gh's JSON boundary, including overlapping IDs in separate comment collections. */
async function dashboardFixture(args: string[]): Promise<string> {
  if (args[2] === "graphql") return JSON.stringify({ data: { search: { nodes: [{ number: 12, title: "A PR", url: "https://github.com/example/project/pull/12", repository: { nameWithOwner: "example/project" }, author: { login: "author" }, isDraft: false, updatedAt: "2026-10-18", headRefOid: head, reviewDecision: "APPROVED", latestOpinionatedReviews: { nodes: [{ author: { login: "reviewer" }, state: "APPROVED" }, { author: { login: "me" }, state: "APPROVED" }, { author: { login: "changes" }, state: "CHANGES_REQUESTED" }, { author: { login: "dismissed" }, state: "DISMISSED" }, { author: { login: "commenter" }, state: "COMMENTED" }, { author: null, state: "APPROVED" }] }, commits: { nodes: [{ commit: { author: { user: { login: "author" } }, statusCheckRollup: { state: "FAILURE" } } }] } }] } } });
  if (args[2] === "user") return JSON.stringify({ login: "me" });
  const user = { login: "author" };
  if (args[2].includes("/issues/")) return JSON.stringify([[{ id: 1, user, created_at: "2026-10-18" }], [{ id: 2, user, created_at: "2026-10-19" }]]);
  if (args[2].includes("/comments?")) return JSON.stringify([[{ id: 1, user, created_at: "2026-10-19" }]]);
  if (args[2].includes("/reviews?")) return JSON.stringify([[{ id: 3, user, submitted_at: "2026-10-19", state: "APPROVED" }, { id: 4, user, state: "PENDING" }]]);
  throw new Error(`Unexpected dashboard request: ${args.join(" ")}`);
}

/** Model GitHub's current review decisions and head check rollup for a direct PR lookup. */
function statusFixture(viewerState: string, checks: string, reviewRequested = false) {
  return async function run(args: string[]): Promise<string> {
    if (args[2] === "user") return JSON.stringify({ login: "me" });
    if (args[2] !== "graphql") throw new Error(`Unexpected status request: ${args.join(" ")}`);
    return JSON.stringify({ data: { repository: { pullRequest: {
      reviewDecision: viewerState === "CHANGES_REQUESTED" ? "CHANGES_REQUESTED" : "REVIEW_REQUIRED",
      reviewRequests: { nodes: reviewRequested ? [{ requestedReviewer: { login: "ME" } }] : [] },
      latestOpinionatedReviews: { nodes: [{ author: { login: "Me" }, state: viewerState }, { author: { login: "other" }, state: "APPROVED" }] },
      commits: { nodes: [{ commit: { author: { user: { login: "author" } }, statusCheckRollup: { state: checks } } }] },
    } } } });
  };
}

/** Return explicit PR lookups using the same summary/status data as search results. */
async function trackedFixture(args: string[]): Promise<string> {
  if (args[2] !== "graphql") return dashboardFixture(args);
  const query = args.find((arg) => arg.startsWith("query="))!;
  const fixture = JSON.parse(await dashboardFixture(args)) as { data: { search: { nodes: Record<string, unknown>[] } } };
  const data = Object.fromEntries([...query.matchAll(/p(\d+): repository[^\n]+?pullRequest\(number: (\d+)\)/g)].map((match) => [
    `p${match[1]}`, { pullRequest: { ...fixture.data.search.nodes[0], number: Number(match[2]), state: "OPEN" } },
  ]));
  return JSON.stringify({ data });
}

/** Return immutable source or gh's stderr failures at the command boundary. */
function fileSourceFixture(oldContents: string | Error, newContents: string | Error) {
  return async function run(args: string[]): Promise<string> {
    if (args[2] === `repos/example/project/compare/${base}...${head}`) return JSON.stringify({ merge_base_commit: { sha: commit } });
    if (args[2] === `repos/example/project/commits/${head}`) return JSON.stringify({ parents: [{ sha: commit }] });
    const contents = args[2] === `repos/example/project/contents/file.ts?ref=${commit}` ? oldContents
      : args[2] === `repos/example/project/contents/file.ts?ref=${head}` ? newContents : new Error(`Unexpected source endpoint: ${args[2]}`);
    if (contents instanceof Error) throw contents;
    return contents;
  };
}

/** Model remote comment state, including a write that succeeds before its transport fails. */
function publicationFixture() {
  const state = { comments: [] as DiscussionComment[], head, loseResponse: false };

  /** Respond at the gh boundary without contacting GitHub or mutating the live inbox. */
  async function run(args: string[], options?: CommandOptions): Promise<string> {
    if (options?.input) {
      const body = JSON.parse(options.input) as { body: string };
      const comment = { id: state.comments.length + 1, body: body.body, user: { login: "me" }, html_url: "https://github.com/example/project/pull/12" };
      state.comments.push(comment);
      if (state.loseResponse) { state.loseResponse = false; throw new Error("GitHub response lost"); }
      return JSON.stringify(comment);
    }
    if (args[2] === "repos/example/project/pulls/12") return JSON.stringify({ head: { sha: state.head } });
    if (args[2].endsWith("/comments?per_page=100")) return JSON.stringify([state.comments]);
    throw new Error(`Unexpected publication endpoint: ${args[2]}`);
  }

  return { state, run };
}
