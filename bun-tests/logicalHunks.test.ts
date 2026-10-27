import { reviewIdentity } from "../server/reviewStore";
import { updateDiscussion, readDiscussion } from "../server/discussionThreads";
import { followUpHunk, followUps } from "../server/followUps";
import { updateHunkApproval, hunkApprovals, reconcileFollowUps } from "../server/logicalHunks";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { Storage } from "../server/storage";
import { identifyChanges, identifyMetadata } from "../shared/changeProgress";
import { parseInput } from "../src/patches";
import type { ChangeIdentity } from "../shared/progress";
import type { ReviewThread } from "../shared/localReview";

describe("logicalHunks", () => {
  let directory: string;
  let storage: Storage;
  let block: ChangeIdentity;
  const scope = "example/project/12";
  const patch = "diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-before();\n+after();\n";

  beforeEach(async () => {
    directory = await mkdtemp("/tmp/opencode/biff-logical-hunks-");
    storage = new Storage(`${directory}/state.sqlite`);
    const [change] = await identifyChanges(parseInput(patch));
    block = { path: change.path, hash: change.hash, oldLine: change.oldLine, newLine: change.newLine, duplicate: change.duplicate };
    await reviewIdentity(storage, scope);
  });
  afterEach(async () => { await storage.close(); await rm(directory, { recursive: true, force: true }); });

  test("comments, flags, and approval share one durable identity", async () => {
    // Given an anchored comment on an unapproved edit
    await updateDiscussion(storage, scope, (discussion) => { discussion.threads.push(thread(block)); });
    const before = storage.db.query<{ hunk_id: string }, []>("SELECT hunk_id FROM thread_anchors").get()!;

    // When the edit is flagged and approved, then the database reopens
    await followUpHunk(storage, scope, block, "head", true);
    await reopen();

    // Then one canonical entity owns all three features
    expect(storage.db.query("SELECT id,follow_up,reviewed_head,reviewed_at IS NOT NULL AS approved FROM logical_hunks").all())
      .toEqual([{ id: before.hunk_id, follow_up: 1, reviewed_head: "head", approved: 1 }]);
    expect(storage.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='hunk_approvals'").all()).toEqual([]);
  });

  test("unapproving a hunk preserves its follow-up and comment anchor", async () => {
    // Given a flagged, approved, commented edit
    await updateDiscussion(storage, scope, (discussion) => { discussion.threads.push(thread(block)); });
    await followUpHunk(storage, scope, block, "head", true);
    const before = await readDiscussion(storage, scope);

    // When the approval is cleared
    await updateHunkApproval(storage, scope, block, false, "head");

    // Then only approval state is removed
    expect(await hunkApprovals(storage, scope)).toEqual([]);
    expect(followUps(storage, scope)).toMatchObject([{ hash: block.hash }]);
    expect(await readDiscussion(storage, scope)).toEqual(before);
  });

  test("complete comparisons register untouched edits as unapproved units", async () => {
    // Given a comparison with two edits and no comments or prior approvals
    const comparison = patch + "@@ -20 +20 @@\n-beforeTwo();\n+afterTwo();\n";

    // When its current PR snapshot is processed
    await reconcileFollowUps(storage, scope, comparison, "head", "pr");

    // Then both edits are present and neither is implicitly approved
    expect(storage.db.query("SELECT old_line,pr_head,reviewed_at FROM logical_hunks ORDER BY old_line").all()).toEqual([
      { old_line: 1, pr_head: "head", reviewed_at: null }, { old_line: 20, pr_head: "head", reviewed_at: null },
    ]);
  });

  test("binary changes are canonical review units even without text hunks", async () => {
    // Given a changed binary file
    const binary = "diff --git a/picture.png b/picture.png\nindex 1234567..abcdef0 100644\nBinary files a/picture.png and b/picture.png differ\n";

    // When its current comparison is processed
    await reconcileFollowUps(storage, scope, binary, "head", "pr");

    // Then it contributes an unapproved metadata unit
    expect(storage.db.query("SELECT path,kind,pr_head,reviewed_at FROM logical_hunks").all()).toEqual([{ path: "picture.png", kind: "metadata", pr_head: "head", reviewed_at: null }]);
  });

  test("metadata approval survives an unrelated text rewrite", async () => {
    // Given a file with an executable-bit change and a text edit
    const mode = patch.replace("--- a/file.ts", "old mode 100644\nnew mode 100755\n--- a/file.ts");
    const [metadata] = await identifyMetadata(parseInput(mode), "head");
    await reconcileFollowUps(storage, scope, mode, "head", "pr");
    await updateHunkApproval(storage, scope, metadata, true, "head");
    const before = await hunkApprovals(storage, scope);

    // When the text changes but the mode change is unchanged
    await reconcileFollowUps(storage, scope, mode.replace("after();", "different();"), "new-head", "pr");

    // Then the original metadata receipt remains approved and present
    expect(await hunkApprovals(storage, scope)).toEqual(before);
    expect(storage.db.query("SELECT pr_head FROM logical_hunks WHERE kind='metadata'").all()).toEqual([{ pr_head: "new-head" }]);
  });

  test("a duplicate occurrence cannot inherit another occurrence's approval", async () => {
    // Given a formerly unique edit approved at line one
    await updateHunkApproval(storage, scope, block, true, "old");

    // When the new comparison contains the same edit twice
    await reconcileFollowUps(storage, scope, patch + "@@ -20 +20 @@\n-before();\n+after();\n", "new", "pr");

    // Then only the explicitly approved occurrence is approved
    expect(storage.db.query("SELECT old_line,reviewed_at IS NOT NULL AS approved FROM logical_hunks WHERE pr_head='new' ORDER BY old_line").all())
      .toEqual([{ old_line: 1, approved: 1 }, { old_line: 20, approved: 0 }]);
  });

  test("commented hunk identity and text/metadata approvals survive restart", async () => {
    // Given a commented, flagged hunk and text/metadata approvals
    await updateDiscussion(storage, scope, (discussion) => { discussion.threads.push(thread(block)); });
    await followUpHunk(storage, scope, block, "head", true);
    const original = storage.db.query<{ id: string }, []>("SELECT id FROM logical_hunks").get()!;
    const metadata = { ...block, kind: "metadata" as const, hash: "metadata-hash", oldLine: 0, newLine: 0 };
    await updateHunkApproval(storage, scope, metadata, true, "head");
    storage.db.exec("UPDATE logical_hunks SET reviewed_at='2026-01-01T00:00:00Z' WHERE reviewed_at IS NOT NULL");

    // When two successive startups open the database
    await reopen();
    await reopen();

    // Then the original entity keeps its flag and receipt, and metadata gets its own canonical unit
    expect(storage.db.query("SELECT id,follow_up,reviewed_head,reviewed_at FROM logical_hunks WHERE kind=''").all()).toEqual([
      { id: original.id, follow_up: 1, reviewed_head: "head", reviewed_at: "2026-01-01T00:00:00Z" },
    ]);
    expect(await hunkApprovals(storage, scope)).toEqual([
      { ...block, head: "head", reviewedAt: "2026-01-01T00:00:00Z" },
      { ...metadata, head: "head", reviewedAt: "2026-01-01T00:00:00Z" },
    ]);
    expect(storage.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  test("a disappearing duplicate leaves one current unit without borrowing its sibling's approval", async () => {
    // Given an approved first occurrence followed by a second identical occurrence
    await updateHunkApproval(storage, scope, block, true, "old");
    await reconcileFollowUps(storage, scope, patch + "@@ -20 +20 @@\n-before();\n+after();\n", "duplicated", "pr");

    // When the first occurrence disappears and only the second remains
    await reconcileFollowUps(storage, scope, patch.replace("-1 +1", "-20 +20"), "single-again", "pr");

    // Then completion sees exactly the surviving unapproved unit
    expect(storage.db.query("SELECT old_line,reviewed_at FROM logical_hunks WHERE pr_head='single-again'").all()).toEqual([{ old_line: 20, reviewed_at: null }]);
  });

  /** Ensure restart tests do not reuse in-memory state. */
  async function reopen() {
    await storage.close();
    storage = new Storage(`${directory}/state.sqlite`);
  }
});

/** Give the edit a real anchor before approval state is attached to it. */
function thread(change: ChangeIdentity): ReviewThread {
  return { id: "thread", resolved: false, humanSequence: 0,
    anchor: { path: change.path, side: "RIGHT", line: change.newLine, endLine: change.newLine, commitId: "head", excerpt: "after();" },
    hunk: { change, offset: 0, text: "after();" },
    messages: [{ id: "message", author: "user", body: "Question", sequence: 1, createdAt: "today" }] };
}
