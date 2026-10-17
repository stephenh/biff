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
  beforeEach(() => {
    written = [];
    github = new GitHub(runFixture);
  });

  /** Simulate GitHub at the command boundary without making network writes. */
  async function runFixture(args: string[], options?: CommandOptions): Promise<string> {
    const endpoint = args[2];
    if (endpoint === "graphql") {
      const query = args.find((arg) => arg.startsWith("query="))!;
      if (query.includes("mentionableUsers")) {
        if (!args.includes("owner=example") || !args.includes("name=project")) throw new Error("Unexpected mention repository");
        const search = args.find((arg) => arg.startsWith("search="))!.slice(7).toLowerCase();
        const users = [{ login: "reviewer-hb", name: "Repository Reviewer" }];
        return JSON.stringify({ data: { repository: { mentionableUsers: { nodes: users.filter((user) => `${user.login} ${user.name}`.toLowerCase().includes(search)) } } } });
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
});
