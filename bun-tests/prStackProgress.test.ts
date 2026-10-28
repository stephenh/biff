import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GitHub } from "../server/github";
import { beginHunkReconciliation, reconcileHunks, updateHunkApproval } from "../server/logicalHunks";
import { reviewIdentity } from "../server/reviewStore";
import { Storage } from "../server/storage";
import type { ChangeIdentity } from "../shared/progress";

describe("prStackProgress", () => {
  let storage: Storage;
  let github: GitHub;
  const scope = "example/project/10";
  const head = "a".repeat(40);
  const base = "b".repeat(40);
  const block: ChangeIdentity = { path: "file.ts", hash: "edit", oldLine: 1, newLine: 1, duplicate: false };

  beforeEach(() => {
    storage = new Storage();
    github = new GitHub(async (args) => {
      // Any additional GitHub request would make these cached counts needlessly expensive.
      if (args[2] !== "repos/Example/Project/pulls?state=open&per_page=100") throw new Error("Expected only the stack list request");
      return JSON.stringify([
        { number: 10, title: "Base", base: { ref: "main", sha: base, repo: { full_name: "Example/Project" } }, head: { ref: "first", sha: head, repo: { full_name: "Example/Project" } } },
        { number: 20, title: "Top", base: { ref: "first", sha: head, repo: { full_name: "Example/Project" } }, head: { ref: "second", sha: "c".repeat(40), repo: { full_name: "Example/Project" } } },
      ]);
    }, storage);
  });
  afterEach(async () => { await storage.close(); });

  test("counts current reviewable units without fetching any diffs", async () => {
    // Given one approved hunk, an untouched hunk, and an auto-reviewed unit
    await reviewIdentity(storage, scope);
    await reconcileHunks(storage, scope, [block, { ...block, hash: "untouched" }, { ...block, hash: "generated", reviewable: false }], head, "pr", beginHunkReconciliation(storage, scope, "pr"), base);
    // And an old approval that is no longer present in the PR
    await updateHunkApproval(storage, scope, { ...block, hash: "removed" }, true, "old-head");
    await updateHunkApproval(storage, scope, block, true, head);

    // When the stack is loaded with a differently cased repository name
    const result = await github.stack("Example/Project", "10");

    // Then only current reviewable units contribute to the cached progress
    expect(result?.pulls[0].progress).toEqual({ reviewed: 1, total: 2 });
  });

  test("omits progress when the PR has never been compared", async () => {
    // Given no stored comparison for either PR
    // When their stack is loaded
    const result = await github.stack("Example/Project", "10");

    // Then unknown totals are not presented as zero
    expect(result?.pulls).toEqual([{ number: 10, title: "Base" }, { number: 20, title: "Top" }]);
  });

  test("omits a stale head's counts", async () => {
    // Given a comparison from before the latest push
    await reviewIdentity(storage, scope);
    await reconcileHunks(storage, scope, [block], "old-head", "pr", beginHunkReconciliation(storage, scope, "pr"), base);

    // When the current stack is loaded
    const result = await github.stack("Example/Project", "10");

    // Then the old total is not shown for the new head
    expect(result?.pulls[0].progress).toBeUndefined();
  });

  test("omits counts after the comparison base changes", async () => {
    // Given the same head was compared against an older base
    await reviewIdentity(storage, scope);
    await reconcileHunks(storage, scope, [block], head, "pr", beginHunkReconciliation(storage, scope, "pr"), "old-base");

    // When its stack is loaded
    const result = await github.stack("Example/Project", "10");

    // Then the old comparison is not treated as current
    expect(result?.pulls[0].progress).toBeUndefined();
  });

  test("keeps known empty comparisons distinct from unknown totals", async () => {
    // Given a complete comparison with no reviewable units
    await reviewIdentity(storage, scope);
    await reconcileHunks(storage, scope, [], head, "pr", beginHunkReconciliation(storage, scope, "pr"), base);

    // When its stack is loaded
    const result = await github.stack("Example/Project", "10");

    // Then its known zero total is retained
    expect(result?.pulls[0].progress).toEqual({ reviewed: 0, total: 0 });
  });
});
