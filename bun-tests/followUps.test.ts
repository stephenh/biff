import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Storage } from "../server/storage";
import { Progress } from "../server/progress";
import { identifyChanges } from "../src/changeProgress";
import { parseInput } from "../src/patches";
import { createApi } from "../server/api";
import { GitHub } from "../server/github";
import { Workspaces } from "../server/workspaces";
import type { ChangeIdentity } from "../shared/progress";
import type { LocalReview } from "../shared/types";
import type { ReviewThread } from "../shared/localReview";

const patch = "diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-before();\n+after();\n";

describe("followUps", () => {
  test("the API durably flags and completes a hunk together", async () => {
    // Given a PR hunk and the real persistence API
    const storage = new Storage();
    try {
      const progress = new Progress(storage);
      const api = createApi({ github: new GitHub(undefined, storage), workspaces: new Workspaces(storage), progress });
      const [block] = await identifyChanges(parseInput(patch));
      // When the user flags the hunk
      const response = await api(new Request("http://localhost/api/github/pr/example/project/12/follow-ups", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...block, type: "hunk", head: "a".repeat(40), enabled: true }) }));
      if (!response.ok) throw new Error(await response.text());
      // Then both personal state and reviewed progress are durable
      expect(new Progress(storage).followUps("example/project/12")).toMatchObject([{ type: "hunk", hash: block.hash }]);
      expect(await progress.get("example/project/12")).toMatchObject([{ hash: block.hash, head: "a".repeat(40) }]);
    } finally { await storage.close(); }
  });

  test("clearing a follow-up preserves hunk completion", async () => {
    // Given a flagged and reviewed hunk
    const storage = new Storage();
    try {
      const progress = new Progress(storage);
      const [block] = await identifyChanges(parseInput(patch));
      await progress.followUpHunk("example/project/12", block, "head", true);
      // When the flag is cleared
      await progress.followUpHunk("example/project/12", block, "head", false);
      // Then completion remains but the follow-up is gone
      expect(progress.followUps("example/project/12")).toEqual([]);
      expect(await progress.get("example/project/12")).toMatchObject([{ hash: block.hash }]);
    } finally { await storage.close(); }
  });

  test("reconciliation retains moved exact edits", async () => {
    // Given a flagged hunk
    const storage = new Storage();
    try {
      const progress = new Progress(storage);
      const [block] = await identifyChanges(parseInput(patch));
      await progress.followUpHunk("example/project/12", block, "old", true);
      // When unrelated edits shift its coordinates
      await progress.reconcileFollowUps("example/project/12", patch.replace("-1 +1", "-20 +20"), "new", "pr");
      // Then the flag follows its exact content
      expect(progress.followUps("example/project/12")).toMatchObject([{ hash: block.hash }]);
    } finally { await storage.close(); }
  });

  test("a complete new diff drops a changed hunk", async () => {
    // Given a flagged hunk
    const storage = new Storage();
    try {
      const progress = new Progress(storage);
      const [block] = await identifyChanges(parseInput(patch));
      await progress.followUpHunk("example/project/12", block, "old", true);
      // When the new complete diff replaces the edit
      await progress.reconcileFollowUps("example/project/12", patch.replace("after();", "different();"), "new", "pr");
      // Then the obsolete flag is gone
      expect(progress.followUps("example/project/12")).toEqual([]);
    } finally { await storage.close(); }
  });

  test("a remote diff preserves unpublished local hunks", async () => {
    // Given a local flag sharing a review lifetime
    const storage = new Storage();
    try {
      const progress = new Progress(storage);
      const identity = await progress.identity("example/project/12");
      storage.db.query("INSERT INTO review_aliases VALUES (?, ?)").run("jj/workspace/local", identity.id);
      const [block] = await identifyChanges(parseInput(patch));
      await progress.followUpHunk("jj/workspace/local", block, "unpublished", true);
      // When the older remote diff is reconciled
      await progress.reconcileFollowUps("example/project/12", "", "remote", "pr");
      // Then unpublished work stays flagged
      expect(progress.followUps("jj/workspace/local")).toMatchObject([{ hash: block.hash, source: "local" }]);
      expect(progress.followUps("example/project/12")).toEqual([]);
    } finally { await storage.close(); }
  });

  test("deleted GitHub threads lose their personal flags", async () => {
    // Given two flagged threads
    const storage = new Storage();
    try {
      const progress = new Progress(storage);
      const location = { path: "file.ts", line: 1, side: "RIGHT" as const };
      await progress.followUpThread("example/project/12", { type: "thread", id: "github:1", location, label: "first" }, true);
      await progress.followUpThread("example/project/12", { type: "thread", id: "github:2", location, label: "second" }, true);
      // When a complete conversation contains only the second thread
      await progress.reconcileFollowUpThreads("example/project/12", [2]);
      // Then only the surviving thread stays flagged
      expect(progress.followUps("example/project/12")).toMatchObject([{ id: "github:2" }]);
    } finally { await storage.close(); }
  });

  test("a flag added during a diff fetch survives its older snapshot", async () => {
    // Given the candidates captured before a remote fetch
    const storage = new Storage();
    try {
      const progress = new Progress(storage);
      const [block] = await identifyChanges(parseInput(patch));
      await progress.followUpHunk("example/project/12", block, "old", true);
      const token = progress.beginHunkReconciliation("example/project/12", "pr");
      // And a reader flags a newer version while that fetch is pending
      await progress.followUpHunk("example/project/12", block, "newer", true);
      // When the older complete diff arrives
      await progress.reconcileFollowUps("example/project/12", "", "old", "pr", token);
      // Then the newer flag is retained
      expect(progress.followUps("example/project/12")).toMatchObject([{ head: "newer" }]);
    } finally { await storage.close(); }
  });
});

describe("relational followUps", () => {
  let storage: Storage;
  let progress: Progress;
  let block: ChangeIdentity;
  const pr = "example/project/12";
  const local = "jj/workspace/local";

  beforeEach(async () => {
    storage = new Storage();
    progress = new Progress(storage);
    const [change] = await identifyChanges(parseInput(patch));
    block = { path: change.path, hash: change.hash, oldLine: change.oldLine, newLine: change.newLine, duplicate: change.duplicate };
    const identity = await progress.identity(pr);
    storage.db.query("INSERT INTO review_aliases VALUES (?,?)").run(local, identity.id);
  });
  afterEach(async () => { await storage.close(); });

  test("JJ rewrites update presence without replacing the commented logical hunk", async () => {
    // Given a flagged hunk shared with a comment anchor
    await progress.updateDiscussion(local, (discussion) => { discussion.threads.push(thread("thread", block)); });
    await progress.followUpHunk(local, block, "old-sha", true);
    const before = storage.db.query<{ id: string }, []>("SELECT id FROM logical_hunks").get()!;

    // When JJ rewrites the commit and the edit moves to a later line
    await progress.reconcileFollowUps(local, patch.replace("-1 +1", "-20 +20"), "rewritten-sha", "local");

    // Then the original identity and flag remain attached to the current local head
    expect(storage.db.query("SELECT id,follow_up,local_head,pr_head FROM logical_hunks").all()).toEqual([
      { id: before.id, follow_up: 1, local_head: "rewritten-sha", pr_head: null },
    ]);
    expect(storage.db.query("SELECT hunk_id FROM thread_anchors").all()).toEqual([{ hunk_id: before.id }]);
  });

  test("PR disappearance hides a flag there while preserving its local presence", async () => {
    // Given one flagged edit observed in both sources
    await progress.followUpHunk(local, block, "local-head", true);
    await progress.reconcileFollowUps(pr, patch, "pr-head", "pr");

    // When only the PR loses the edit
    await progress.reconcileFollowUps(pr, "", "next-pr-head", "pr");

    // Then PR counts and lists exclude it while local review can still act on it
    expect(progress.followUps(pr)).toEqual([]);
    expect(progress.followUps(local)).toEqual([{ ...block, type: "hunk", head: "local-head", source: "local" }]);
  });

  test("disappearance from both sources clears the flag without deleting the entity", async () => {
    // Given a flagged edit present locally and on the PR
    await progress.followUpHunk(local, block, "local-head", true);
    await progress.reconcileFollowUps(pr, patch, "pr-head", "pr");
    // And the local edit has disappeared
    await progress.reconcileFollowUps(local, "", "next-local", "local");

    // When the PR also loses it
    await progress.reconcileFollowUps(pr, "", "next-pr", "pr");

    // Then the hunk survives with neither presence nor a follow-up flag
    expect(storage.db.query("SELECT follow_up,local_head,pr_head FROM logical_hunks").all()).toEqual([{ follow_up: 0, local_head: null, pr_head: null }]);
    expect(storage.db.query("SELECT local_reconciled_head,pr_reconciled_head FROM reviews").all()).toEqual([{ local_reconciled_head: "next-local", pr_reconciled_head: "next-pr" }]);
  });

  test("an automatically cleared flag does not return when its hunk reappears", async () => {
    // Given an edit whose last presence disappeared
    await progress.followUpHunk(pr, block, "old", true);
    await progress.reconcileFollowUps(pr, "", "gone", "pr");

    // When its exact content returns in another commit
    await progress.reconcileFollowUps(pr, patch, "returned", "pr");

    // Then presence returns but the cleared user flag does not
    expect(storage.db.query("SELECT follow_up,pr_head FROM logical_hunks").all()).toEqual([{ follow_up: 0, pr_head: "returned" }]);
  });

  test("a held older fetch cannot undo a newer completed comparison", async () => {
    // Given two source fetches started in order by separate Progress instances
    await progress.followUpHunk(pr, block, "initial", true);
    const older = progress.beginHunkReconciliation(pr, "pr");
    const other = new Progress(storage);
    const newer = other.beginHunkReconciliation(pr, "pr");
    const held = Promise.withResolvers<void>();
    const pending = held.promise.then(() => progress.reconcileFollowUps(pr, "", "older", "pr", older));
    // And the newer comparison finishes first
    await other.reconcileFollowUps(pr, patch, "newer", "pr", newer);

    // When the old empty response finally arrives
    held.resolve();
    await pending;

    // Then it cannot clear the newer observation or flag
    expect(progress.followUps(pr)).toMatchObject([{ head: "newer" }]);
    expect(progress.needsFollowUpDiff(pr, "newer")).toEqual(false);
  });

  test("same-head flag reversals invalidate a pending empty snapshot", async () => {
    // Given a pending fetch at the same head as the original flag
    await progress.followUpHunk(pr, block, "head", true);
    const pending = progress.beginHunkReconciliation(pr, "pr");
    // And the user clears then restores that flag before it completes
    await progress.followUpHunk(pr, block, "head", false);
    await progress.followUpHunk(pr, block, "head", true);

    // When the older response arrives
    await progress.reconcileFollowUps(pr, "", "head", "pr", pending);

    // Then the latest intent survives and a fresh comparison is still required
    expect(progress.followUps(pr)).toMatchObject([{ head: "head" }]);
    expect(progress.needsFollowUpDiff(pr, "head")).toEqual(true);
  });

  test("duplicate edits do not borrow each other's presence", async () => {
    // Given two identical edits distinguished by their coordinates
    const first = { ...block, duplicate: true };
    const second = { ...first, oldLine: 20, newLine: 20 };
    await progress.followUpHunk(pr, first, "old", true);
    await progress.followUpHunk(pr, second, "old", true);

    // When the current comparison retains only the second duplicate
    await progress.reconcileHunks(pr, [second], "new", "pr", progress.beginHunkReconciliation(pr, "pr"));

    // Then only that exact duplicate remains flagged
    expect(progress.followUps(pr)).toEqual([{ ...second, type: "hunk", source: "pr", head: "new" }]);
  });

  test("linking reviews merges presence and redirects comment anchors", async () => {
    // Given separate local and PR identities with comments on the same edit
    const localIdentity = await progress.local(snapshot());
    const localScope = `jj/workspace/${localIdentity.id}`;
    await progress.updateDiscussion(localScope, (discussion) => { discussion.threads.push(thread("local-thread", block)); });
    await progress.followUpHunk(localScope, block, "local-head", true);
    const target = storage.db.query<{ id: string }, [string]>("SELECT id FROM logical_hunks WHERE review_id=?").get(localIdentity.id)!;
    await progress.updateDiscussion(pr, (discussion) => { discussion.threads.push(thread("pr-thread", block)); });
    await progress.followUpHunk(pr, block, "shared", true);

    // When the PR head links it to the local bookmark
    await progress.pullRequest(pr, ["shared"], false, "shared");

    // Then both anchors reference the surviving identity with both observations intact
    expect(storage.db.query("SELECT id,review_id,follow_up,local_head,pr_head FROM logical_hunks").all()).toEqual([
      { id: target.id, review_id: localIdentity.id, follow_up: 1, local_head: "local-head", pr_head: "shared" },
    ]);
    expect(storage.db.query("SELECT hunk_id FROM thread_anchors ORDER BY id").all()).toEqual([{ hunk_id: target.id }, { hunk_id: target.id }]);
    expect(storage.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  test("thread follow-up labels are derived from the current canonical message", async () => {
    // Given a flagged local conversation
    await progress.updateDiscussion(local, (discussion) => { discussion.threads.push(thread("thread", block)); });
    await progress.followUpThread(local, { type: "thread", id: "local:thread", label: "Stale label", location: { path: "file.ts", side: "RIGHT", line: 1 } }, true);

    // When the message text changes
    await progress.updateDiscussion(local, (discussion) => { discussion.threads[0].messages[0].body = "Updated question"; });

    // Then the follow-up label uses that message instead of a separate JSON copy
    expect(progress.followUps(local)).toMatchObject([{ type: "thread", id: "local:thread", label: "Updated question" }]);
  });
});

/** Supply an anchored discussion that shares the flagged edit's identity. */
function thread(id: string, block: ChangeIdentity): ReviewThread {
  return { id, resolved: false, humanSequence: 0, anchor: { path: block.path, side: "RIGHT", line: block.newLine, endLine: block.newLine, commitId: "head", excerpt: "after();" },
    hunk: { change: block, offset: 0, text: "after();" }, messages: [{ id: `${id}-message`, body: "Question", author: "user", createdAt: "today", sequence: 1 }] };
}

/** A local bookmark matches the PR through its published tip while local edits are ahead. */
function snapshot(): LocalReview {
  const revision = { commit_id: "shared", change_id: "change", description: "Review", author: { name: "Author", email: "author@example.com", timestamp: "today" } };
  return { workspace: { id: "workspace", path: "/workspace", name: "Workspace" }, bookmark: "feature", selected: revision, revisions: [revision], bookmarkTip: revision, patch };
}
