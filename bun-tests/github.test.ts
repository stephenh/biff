import { beforeEach, describe, expect, test } from "bun:test";
import { GitHub } from "../server/github";
import { createApi } from "../server/api";
import { Workspaces } from "../server/workspaces";
import type { CommandOptions } from "../server/commands";

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
        return JSON.stringify({ data: {} });
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
    const api = createApi({ github, workspaces: new Workspaces("/tmp/opencode/unused-registry.json") });
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
    const api = createApi({ github, workspaces: new Workspaces("/tmp/opencode/unused-registry.json") });

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
    const api = createApi({ github, workspaces: new Workspaces("/tmp/opencode/unused-registry.json") });

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
});

/** Model gh's JSON boundary, including overlapping IDs in separate comment collections. */
async function dashboardFixture(args: string[]): Promise<string> {
  if (args[2] === "graphql") return JSON.stringify({ data: { search: { nodes: [{ number: 12, title: "A PR", url: "https://github.com/example/project/pull/12", repository: { nameWithOwner: "example/project" }, author: { login: "author" }, isDraft: false, updatedAt: "2026-10-18", headRefOid: head, reviewDecision: "APPROVED", commits: { nodes: [{ commit: { author: { user: { login: "author" } }, statusCheckRollup: { state: "FAILURE" } } }] } }] } } });
  if (args[2] === "user") return JSON.stringify({ login: "me" });
  const user = { login: "author" };
  if (args[2].includes("/issues/")) return JSON.stringify([[{ id: 1, user, created_at: "2026-10-18" }], [{ id: 2, user, created_at: "2026-10-19" }]]);
  if (args[2].includes("/comments?")) return JSON.stringify([[{ id: 1, user, created_at: "2026-10-19" }]]);
  if (args[2].includes("/reviews?")) return JSON.stringify([[{ id: 3, user, submitted_at: "2026-10-19", state: "APPROVED" }, { id: 4, user, state: "PENDING" }]]);
  throw new Error(`Unexpected dashboard request: ${args.join(" ")}`);
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
