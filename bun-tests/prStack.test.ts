import { describe, expect, test } from "bun:test";
import { stackPosition, type StackPullRequest } from "../server/prStack";
import { GitHub } from "../server/github";

describe("prStack", () => {
  test("numbers the middle of a stack from the bottom regardless of API ordering", () => {
    // Given three open PRs based on each other's branches
    const pulls = [pull(30, "second", "third"), pull(10, "main", "first"), pull(20, "first", "second")];
    // When the middle PR is reviewed
    const result = stackPosition(pulls, 20);
    // Then its position includes both its parent and child
    expect(result).toEqual({ position: 2, total: 3, pulls: [{ number: 10, title: "PR 10" }, { number: 20, title: "PR 20" }, { number: 30, title: "PR 30" }] });
  });

  test("same-named branches from unrelated forks do not create a stack", () => {
    // Given a standalone PR and another repository's same-named head branch
    const unrelated = pull(20, "main", "main");
    unrelated.head.repo = { full_name: "someone/fork" };
    // When the standalone PR is reviewed
    const result = stackPosition([pull(10, "main", "first"), unrelated], 10);
    // Then no stack counter is shown
    expect(result).toBeNull();
  });

  test("branching dependencies do not receive a misleading linear position", () => {
    // Given two sibling PRs stacked on one base PR
    const pulls = [pull(10, "main", "first"), pull(20, "first", "second"), pull(30, "first", "third")];
    // When one sibling is reviewed
    const result = stackPosition(pulls, 20);
    // Then there is no unique stack order to display
    expect(result).toBeNull();
  });

  test("repository pagination includes later stack members", async () => {
    // Given stack members on different GitHub response pages
    const github = new GitHub(async (args) => {
      if (args[2] !== "repos/example/project/pulls?state=open&per_page=100" || !args.includes("--paginate")) throw new Error("Expected paginated open PRs");
      return JSON.stringify([[pull(10, "main", "first")], [pull(20, "first", "second")]]);
    });
    // When the bottom PR's stack is loaded
    const result = await github.stack("example/project", "10");
    // Then the later page contributes to the total
    expect(result).toEqual({ position: 1, total: 2, pulls: [{ number: 10, title: "PR 10" }, { number: 20, title: "PR 20" }] });
  });
});

/** Build GitHub branch references without depending on commit SHAs or PR titles. */
function pull(number: number, base: string, head: string): StackPullRequest {
  return { number, title: `PR ${number}`, base: { ref: base, repo: { full_name: "example/project" } }, head: { ref: head, repo: { full_name: "example/project" } } };
}
