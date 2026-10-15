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
    if (options?.input) {
      const body: unknown = JSON.parse(options.input);
      written.push(body);
      return JSON.stringify({ id: 42, submitted: body });
    }
    if (endpoint === "repos/example/project/pulls/12") return JSON.stringify({ head: { sha: head }, base: { sha: base } });
    if (endpoint === "repos/example/project/pulls/12/commits?per_page=100") return JSON.stringify([[{ sha: commit }], [{ sha: head }]]);
    if (endpoint === `repos/example/project/compare/${base}...${head}`) return "full PR diff";
    if (endpoint === `repos/example/project/commits/${commit}`) return "single commit diff";
    if (endpoint.endsWith("/comments?per_page=100")) return JSON.stringify([[{ id: 1 }], [{ id: 2 }]]);
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
});
