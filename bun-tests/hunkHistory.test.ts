import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Storage } from "../server/storage";
import { PrActivity } from "../server/prActivity";
import { beginHunkReconciliation, mergeLogicalHunks } from "../server/logicalHunks";
import { reconcilePrComparison } from "../server/prComparison";
import { findReview, recordPullRequest } from "../server/reviewStore";
import { backfillHunkHistory, readHunkHistory } from "../server/hunkHistory";
import { captureSinceReview, recordSinceReview } from "../server/sinceReview";
import { registerReviewChanges } from "../server/reviewChanges";
import { createApi } from "../server/api";
import { GitHub } from "../server/github";
import { Workspaces } from "../server/workspaces";
import type { GitHubReview } from "../shared/types";
import { parsePatchFiles } from "@pierre/diffs";
import { captureHunkTexts, renderHunkText } from "../shared/hunkText";
import { identifyChanges } from "../shared/changeProgress";

describe("hunkHistory", () => {
  let storage: Storage;
  const scope = "example/repo/1";
  const head = "a".repeat(40);
  const base = "c".repeat(40);
  beforeEach(async () => {
    storage = new Storage();
    new PrActivity(storage.db).summary({ number: 1, title: "History", url: "https://github.com/example/repo/pull/1", repository: { nameWithOwner: "example/repo" }, author: { login: "author" }, isDraft: false, updatedAt: "2026-11-04" });
    registerReviewChanges(storage.db, scope, "me");
    await reconcile(head, "first");
  });
  afterEach(async () => { await storage.close(); });

  /** Feed complete real patches through production classification and persistence. */
  async function reconcile(sha: string, content: string, line = 1, comparisonBase = base, reviewScope = scope, changedFiles = 1) {
    const review: GitHubReview = { pr: { number: 1, title: "History", body: "", html_url: "https://github.com/example/repo/pull/1", state: "open", draft: false, user: { login: "author" }, head: { sha, ref: "feature" }, base: { sha: comparisonBase, ref: "main" }, changed_files: changedFiles }, commit: "all", commits: [], patch: patch(content, line) };
    await recordPullRequest(storage, reviewScope, [sha], false, sha);
    return reconcilePrComparison(storage, { pullRequest: async () => review.pr, contents: async () => ({ oldFile: { name: "example.ts", contents: "before\n" }, newFile: { name: "example.ts", contents: content + "\n" } }) }, reviewScope, review, beginHunkReconciliation(storage, reviewScope, "pr"));
  }

  /** Keep the submitted comparison available to the legacy backfill path. */
  function submit() {
    const captured = captureSinceReview(storage.db, scope, head, base)!;
    new PrActivity(storage.db).review(scope, { id: 1, user: { login: "me" }, state: "APPROVED", body: "", commit_id: head, submitted_at: "2026-11-01T12:00:00Z", html_url: "https://github.com/example/repo/pull/1" });
    recordSinceReview(storage.db, scope, "me", 1, head, base, captured.units);
  }

  test("reconciliation stores the hunk body without positional headers", () => {
    // Given a classified current comparison
    // When retained text is read
    const rows = storage.db.query("SELECT diff_text FROM logical_hunks").all();
    // Then source text can be reused at any observed position
    expect(rows).toEqual([{ diff_text: "-before\n+first\n" }]);
  });

  test("moving unchanged content retains both observed positions", async () => {
    // Given the same logical edit observed at two positions
    await reconcile("b".repeat(40), "first", 50);
    // When a later edit makes that hunk historical
    await reconcile("d".repeat(40), "replacement", 50);
    // Then the earlier coordinates survive current-state reconciliation
    expect(readHunkHistory(storage.db, scope, "example.ts").observations).toMatchObject([
      { head, oldLine: 1, newLine: 1, diffText: "-before\n+first\n" },
      { head: "b".repeat(40), oldLine: 50, newLine: 50, diffText: "-before\n+first\n" },
    ]);
  });

  test("unchanged refreshes do not duplicate observations", async () => {
    // Given an already recorded comparison
    // When it is reconciled again
    await reconcile(head, "first");
    // Then the observation is retained once
    expect(storage.db.query("SELECT count(*) AS count FROM logical_hunk_observations").get()).toEqual({ count: 1 });
  });

  test("same-head base updates retain distinct observations", async () => {
    // Given a recorded head/base comparison
    // When the base changes without changing this edit
    await reconcile(head, "first", 1, "d".repeat(40));
    // Then the two observed comparisons remain distinguishable
    expect(storage.db.query("SELECT comparison_base_sha FROM logical_hunk_observations ORDER BY id").all()).toEqual([{ comparison_base_sha: base }, { comparison_base_sha: "d".repeat(40) }]);
  });

  test("incomplete comparisons do not record historical observations", async () => {
    // Given a complete captured comparison
    // When a newer patch omits a reported file
    await reconcile("b".repeat(40), "truncated", 1, base, scope, 2);
    // Then only the complete comparison contributes history
    expect(storage.db.query("SELECT comparison_head_sha FROM logical_hunk_observations").all()).toEqual([{ comparison_head_sha: head }]);
  });

  test("legacy current hunks are filled during an unchanged comparison refresh", async () => {
    // Given a pre-migration current hunk without retained text
    storage.db.exec("UPDATE logical_hunks SET diff_text=NULL; DELETE FROM logical_hunk_observations;");
    // When its already-current comparison is loaded normally
    await reconcile(head, "first");
    // Then the legacy body is captured without requiring a push
    expect(storage.db.query("SELECT diff_text FROM logical_hunks").all()).toEqual([{ diff_text: "-before\n+first\n" }]);
  });

  test("legacy historical backfill uses review evidence rather than today's timestamp", async () => {
    // Given an absent legacy hunk from a known submitted review
    submit();
    storage.db.exec("UPDATE logical_hunks SET diff_text=NULL; DELETE FROM logical_hunk_observations;");
    await reconcile("b".repeat(40), "replacement");
    // When the exact submitted comparison supplies the old body
    await backfillHunkHistory(storage.db, scope, patch("first"), head, base, "2026-11-01T12:00:00Z");
    // Then historical time is grounded in the review receipt
    expect(readHunkHistory(storage.db, scope, "example.ts").observations).toMatchObject([{ diffText: "-before\n+first\n", observedAt: "2026-11-01T12:00:00Z", head, base }]);
  });

  test("backfill does not guess text for unmatched identities", async () => {
    // Given a legacy hunk with missing text
    storage.db.exec("UPDATE logical_hunks SET diff_text=NULL; DELETE FROM logical_hunk_observations;");
    // When a different edit occupies the same source range in historical evidence
    await backfillHunkHistory(storage.db, scope, patch("different"), head, base, null);
    // Then matching coordinates alone cannot fill the content
    expect(storage.db.query("SELECT diff_text FROM logical_hunks").all()).toEqual([{ diff_text: null }]);
  });

  test("linked review merges preserve observation foreign keys", async () => {
    // Given two review lifetimes sharing one edit but observing different heads
    const other = "example/repo/2";
    await reconcile("b".repeat(40), "first", 1, base, other);
    // When the review lifetimes merge
    mergeLogicalHunks(storage.db, findReview(storage.db, other)!.id, findReview(storage.db, scope)!.id);
    // Then neither observation is lost with the retired hunk row
    expect(storage.db.query("SELECT comparison_head_sha FROM logical_hunk_observations ORDER BY id").all()).toEqual([{ comparison_head_sha: head }, { comparison_head_sha: "b".repeat(40) }]);
  });

  test("stored history renders when GitHub cannot serve historical commits", async () => {
    // Given a retained submitted hunk followed by replacement code
    submit();
    await reconcile("b".repeat(40), "replacement");
    // And only the authenticated identity can be read from GitHub
    const github = new GitHub(async (args) => {
      if (args[2] === "user") return JSON.stringify({ login: "me" });
      throw new Error("Historical commit unavailable");
    }, storage);
    const api = createApi({ github, storage, workspaces: new Workspaces(storage) });
    // When the file's historical pane loads
    const response = await api(new Request("http://127.0.0.1:4567/api/github/pr/example/repo/1/historical?path=example.ts"));
    const result = await response.json();
    // Then it receives the retained hunk without a historical GitHub fetch
    expect(result.observations).toMatchObject([{ path: "example.ts", diffText: "-before\n+first\n" }]);
  });

  test("retained bodies round-trip without inventing a final newline", () => {
    // Given an edit whose new side has no final newline
    const text = { diffText: "-before\n+after\n\\ No newline at end of file\n", oldLine: 10, newLine: 10 };
    // When its standalone reference patch is parsed
    const file = parsePatchFiles(renderHunkText("example.ts", text), undefined, true)[0].files[0];
    // Then the renderer receives the exact new-side content
    expect(file.additionLines).toEqual(["after"]);
  });

  test("retained pure insertions preserve their insertion-point coordinates", async () => {
    // Given a zero-context insertion after old line 5
    const files = parsePatchFiles("diff --git a/example.ts b/example.ts\n--- a/example.ts\n+++ b/example.ts\n@@ -5,0 +6,1 @@\n+inserted\n", undefined, true)[0].files;
    const blocks = await identifyChanges(files);
    const captured = captureHunkTexts(files, blocks).get(blocks[0])!;
    // When the retained hunk is reconstructed
    const rendered = parsePatchFiles(renderHunkText("example.ts", captured), undefined, true)[0].files[0];
    // Then its original empty old-side range is preserved
    expect(rendered.hunks[0]).toMatchObject({ deletionStart: 5, deletionCount: 0, additionStart: 6, additionCount: 1 });
  });

  test("unavailable legacy evidence does not hide locally retained versions", async () => {
    // Given two old versions, only one of which has retained text
    submit();
    await reconcile("b".repeat(40), "second");
    await reconcile("d".repeat(40), "current");
    storage.db.query("UPDATE logical_hunks SET diff_text=NULL WHERE diff_text=?").run("-before\n+first\n");
    // And GitHub can no longer supply the missing submitted comparison
    const github = new GitHub(async (args) => {
      if (args[2] === "user") return JSON.stringify({ login: "me" });
      throw new Error("Historical commit unavailable");
    }, storage);
    const api = createApi({ github, storage, workspaces: new Workspaces(storage) });
    // When the historical pane loads
    const response = await api(new Request("http://127.0.0.1:4567/api/github/pr/example/repo/1/historical?path=example.ts"));
    // Then the retained version is still usable alongside the recoverable error
    expect(await response.json()).toMatchObject({ observations: [{ diffText: "-before\n+second\n" }], backfillError: "Historical commit unavailable" });
  });
});

/** A single logical replacement makes identity reuse and position changes explicit. */
function patch(content: string, line = 1): string {
  return `diff --git a/example.ts b/example.ts\n--- a/example.ts\n+++ b/example.ts\n@@ -${line} +${line} @@\n-before\n+${content}\n`;
}
