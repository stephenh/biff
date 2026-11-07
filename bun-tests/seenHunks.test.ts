import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { parsePatchFiles } from "@pierre/diffs";
import { identifyChanges } from "../shared/changeProgress";
import { captureHunkTexts } from "../shared/hunkText";
import { Storage } from "../server/storage";
import { ensureReview } from "../server/reviewStore";
import { beginHunkReconciliation, hunkApprovals, reconcileHunks, mergeLogicalHunks } from "../server/logicalHunks";
import { readHunkHistory, readSeenHunks, seeHunk } from "../server/hunkHistory";
import { createApi } from "../server/api";
import { GitHub } from "../server/github";
import { Workspaces } from "../server/workspaces";
import { settleReviewReconciliations, startReviewReconciliation } from "../server/reviewReconciliation";
import type { HunkComparison } from "../shared/hunkHistory";

describe("seenHunks", () => {
  let storage: Storage;
  const scope = "example/repo/1";
  const comparison = { head: "a".repeat(40), base: "b".repeat(40) };
  const next = { ...comparison, head: "c".repeat(40) };
  beforeEach(() => { storage = new Storage(); ensureReview(storage.db, scope); });
  afterEach(async () => { await settleReviewReconciliations(storage); await storage.close(); });

  test("server observations alone do not retain disappeared hunks", async () => {
    // Given a comparison that nobody encountered
    await reconcile("first", comparison);
    // When a replacement comparison arrives
    await reconcile("second", next);
    // Then Historical excludes the unseen edit
    expect(readHunkHistory(storage.db, scope, "example.ts", next)).toEqual({ observations: [], missing: 0 });
  });

  test("an encounter retains old code without a submitted review", async () => {
    // Given an encountered edit
    const [unit] = await reconcile("first", comparison);
    await seeHunk(storage, scope, unit, comparison);
    // When different content replaces it
    await reconcile("second", next);
    // Then the old code is available without claiming an ancestor for the replacement
    expect(readHunkHistory(storage.db, scope, "example.ts", next).observations).toMatchObject([
      { head: comparison.head, base: comparison.base, diffText: "-before\n+first\n" },
    ]);
  });

  test("encounters do not approve hunks", async () => {
    // Given a current unreviewed edit
    const [unit] = await reconcile("first", comparison);
    // When it is encountered
    await seeHunk(storage, scope, unit, comparison);
    // Then explicit review progress remains unchanged
    expect(await hunkApprovals(storage, scope)).toEqual([]);
  });

  test("repeated encounters preserve their first timestamp", async () => {
    // Given an already encountered edit
    const [unit] = await reconcile("first", comparison);
    await seeHunk(storage, scope, unit, comparison);
    storage.db.exec("UPDATE logical_hunks SET seen_at='2026-11-01T12:00:00Z'");
    // When the same save is retried
    const result = await seeHunk(storage, scope, unit, comparison);
    // Then the idempotent receipt keeps the original encounter
    expect(result).toEqual({ seenAt: "2026-11-01T12:00:00Z" });
  });

  test("a delayed save retains the encountered comparison rather than today's edit", async () => {
    // Given a browser still displaying an older captured comparison
    const [unit] = await reconcile("first", comparison);
    // And a newer comparison has already arrived
    await reconcile("second", next);
    // When the old encounter reaches the server
    await seeHunk(storage, scope, unit, comparison);
    // Then only the encountered content is marked seen
    expect(storage.db.query("SELECT diff_text,seen_at IS NOT NULL AS seen FROM logical_hunks ORDER BY rowid").all()).toEqual([
      { diff_text: "-before\n+first\n", seen: 1 }, { diff_text: "-before\n+second\n", seen: 0 },
    ]);
  });

  test("history presence is relative to the displayed comparison including its base", async () => {
    // Given a seen edit and a changed base under the same head
    const [unit] = await reconcile("first", comparison);
    await seeHunk(storage, scope, unit, comparison);
    const rebased = { ...comparison, base: "d".repeat(40) };
    await reconcile("second", rebased);
    // When the old comparison is still displayed
    const history = readHunkHistory(storage.db, scope, "example.ts", comparison);
    // Then its own seen content is not incorrectly shown as historical
    expect(history).toEqual({ observations: [], missing: 0 });
  });

  test("linked local presence does not hide a hunk absent from the PR comparison", async () => {
    // Given a locally encountered edit and a different PR comparison in the same lifetime
    const [unit] = await reconcile("local", comparison, "local");
    await seeHunk(storage, scope, unit, comparison);
    await reconcile("remote", next);
    // When the PR's seen-hunk summary is read
    const history = readSeenHunks(storage.db, scope, next);
    // Then the retained local content is historical relative to that PR
    expect(history.hunks).toMatchObject([{ hash: unit.hash, present: false }]);
  });

  test("an encounter cannot invent a comparison", async () => {
    // Given an edit observed only in the first comparison
    const [unit] = await reconcile("first", comparison);
    // When a caller claims it was in an unknown comparison
    const result = seeHunk(storage, scope, unit, next);
    // Then no unverified retention is admitted
    await expect(result).rejects.toThrow("This hunk is not in the captured comparison.");
  });

  test("a duplicate encounter retains only its occurrence", async () => {
    // Given two identical edits at different coordinates
    const [first] = await reconcile("first", comparison, "pr", scope, true);
    // When only the first occurrence is encountered
    await seeHunk(storage, scope, first, comparison);
    // Then duplicate disambiguation keeps the second occurrence unseen
    expect(storage.db.query("SELECT old_line,seen_at IS NOT NULL AS seen FROM logical_hunks ORDER BY old_line").all()).toEqual([
      { old_line: 1, seen: 1 }, { old_line: 20, seen: 0 },
    ]);
  });

  test("linking review lifetimes preserves seen evidence", async () => {
    // Given a seen local identity and an unseen matching PR identity
    const local = ensureReview(storage.db, "local");
    const [unit] = await reconcile("first", comparison, "local", local.id);
    await seeHunk(storage, local.id, unit, comparison);
    await reconcile("first", comparison);
    // When the local review merges into the PR review
    mergeLogicalHunks(storage.db, local.id, ensureReview(storage.db, scope).id);
    // Then the canonical hunk keeps its encounter evidence
    expect(readSeenHunks(storage.db, scope, comparison).hunks).toMatchObject([{ hash: unit.hash, present: true }]);
  });

  test("an early focus request waits for complete comparison evidence without blocking reads", async () => {
    // Given a ready file whose PR-wide inventory is still being finalized
    const files = parsePatchFiles(patch("first")).flatMap((entry) => entry.files);
    const [unit] = await identifyChanges(files);
    const held = Promise.withResolvers<void>();
    startReviewReconciliation(storage, scope, comparison, ["example.ts"], async (reporter) => {
      reporter.sharedReady();
      reporter.ready("example.ts");
      await held.promise;
      await reconcile("first", comparison);
    });
    const api = createApi({ storage, workspaces: new Workspaces(storage), github: new GitHub() });
    const pending = api(new Request(`http://127.0.0.1:4567/api/github/pr/${scope}/seen`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ identity: unit, ...comparison }),
    }));
    await hunkApprovals(storage, scope);
    // When finalization commits the server-observed comparison
    held.resolve();
    await pending;
    // Then the original encounter is retained rather than failing the early request
    expect(readSeenHunks(storage.db, scope, comparison).hunks).toMatchObject([{ hash: unit.hash, present: true }]);
  });

  /** Keep classification real while controlling source/comparison ordering independently. */
  async function reconcile(content: string, version: HunkComparison, source: "pr" | "local" = "pr", reviewScope = scope, duplicate = false) {
    const files = parsePatchFiles(patch(content) + (duplicate ? "@@ -20 +20 @@\n-before\n+first\n" : "")).flatMap((entry) => entry.files);
    const blocks = await identifyChanges(files);
    const texts = captureHunkTexts(files, blocks);
    await reconcileHunks(storage, reviewScope, blocks.map((block) => ({ ...block, text: texts.get(block) })), version.head, source, beginHunkReconciliation(storage, reviewScope, source), version.base);
    return blocks;
  }
});

/** A real patch avoids fake hunk identities in retention tests. */
function patch(content: string): string {
  return `diff --git a/example.ts b/example.ts\n--- a/example.ts\n+++ b/example.ts\n@@ -1 +1 @@\n-before\n+${content}\n`;
}
