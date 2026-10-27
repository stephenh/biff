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

  test("a child after a fork has its own linear stack with shared ancestors", () => {
    // Given two sibling PRs stacked on one base PR
    const pulls = [pull(30, "first", "third"), pull(10, "main", "first"), pull(20, "first", "second")];
    // When one sibling is reviewed
    const result = stackPosition(pulls, 20);
    // Then only that child's path is included, not its sibling
    expect(result).toEqual({ position: 2, total: 2, pulls: [
      { number: 10, title: "PR 10" },
      { number: 20, title: "PR 20" },
    ] });
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

  test("an upstream PR's stack ends before the child stacks diverge", () => {
    // Given the shape of #10994's stack, whose later tip splits into two PRs
    const pulls = [pull(50, "third", "fifth"), pull(30, "second", "third"), pull(10, "main", "first"), pull(40, "third", "fourth"), pull(20, "first", "second")];

    // When an upstream PR is reviewed
    const result = stackPosition(pulls, 20);

    // Then only the common linear chain is shown before the fork
    expect(result).toEqual({ position: 2, total: 3, pulls: [
      { number: 10, title: "PR 10" },
      { number: 20, title: "PR 20" },
      { number: 30, title: "PR 30" },
    ] });
  });

  test("cyclic dependencies still do not form a valid stack", () => {
    // Given two PRs based on one another
    const pulls = [pull(10, "second", "first"), pull(20, "first", "second")];

    // When either PR's stack is requested
    const result = stackPosition(pulls, 10);

    // Then the malformed graph is rejected
    expect(result).toBeNull();
  });

  test("a child stack continues through its own descendants after a fork", () => {
    // Given a shared base with two child stacks, one of which has a later PR
    const pulls = [pull(40, "second", "fourth"), pull(30, "first", "third"), pull(10, "main", "first"), pull(20, "first", "second")];

    // When the first PR of the longer child stack is opened
    const result = stackPosition(pulls, 20);

    // Then its own descendants are included without the sibling stack
    expect(result).toEqual({ position: 2, total: 3, pulls: [{ number: 10, title: "PR 10" }, { number: 20, title: "PR 20" }, { number: 40, title: "PR 40" }] });
  });

  test("a lone shared base does not show either child stack", () => {
    // Given two child stacks fork directly from a single PR
    const pulls = [pull(10, "main", "first"), pull(20, "first", "second"), pull(30, "first", "third")];

    // When the shared base PR is opened
    const result = stackPosition(pulls, 10);

    // Then neither branch is chosen as part of the base's stack
    expect(result).toBeNull();
  });
});

/** Build GitHub branch references without depending on commit SHAs or PR titles. */
function pull(number: number, base: string, head: string): StackPullRequest {
  return { number, title: `PR ${number}`, base: { ref: base, repo: { full_name: "example/project" } }, head: { ref: head, repo: { full_name: "example/project" } } };
}
