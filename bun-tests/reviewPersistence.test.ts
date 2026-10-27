import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Storage } from "../server/storage";
import { ReviewStore, recordPullRequest, reviewIdentity } from "../server/reviewStore";
import { readDiscussion, updateDiscussion } from "../server/discussionThreads";
import type { ReviewThread } from "../shared/localReview";

describe("reviewPersistence", () => {
  let storage: Storage;
  beforeEach(() => { storage = new Storage(); });
  afterEach(async () => { await storage.close(); });

  test("editing one thread does not rewrite an unchanged sibling", async () => {
    // Given two discussion threads and a database rejecting writes to the untouched sibling
    await updateDiscussion(storage, "example/repo/1", (discussion) => { discussion.threads.push(thread("edited"), thread("untouched")); });
    storage.db.exec(`CREATE TRIGGER protect_sibling BEFORE UPDATE ON review_threads WHEN OLD.id='untouched'
      BEGIN SELECT RAISE(ABORT,'unrelated thread write'); END;`);

    // When only the first thread changes
    await updateDiscussion(storage, "example/repo/1", (discussion) => { discussion.threads[0].messages[0].body = "Revised"; });

    // Then its edit is saved alongside the untouched message
    expect((await readDiscussion(storage, "example/repo/1")).threads.map((entry) => entry.messages[0].body)).toEqual(["Revised", "Original"]);
  });

  test("a failed new discussion edit creates neither identity nor threads", async () => {
    // Given an unknown review scope
    // When an asynchronous edit fails after changing its in-memory discussion
    await updateDiscussion(storage, "example/repo/1", async (discussion) => {
      discussion.threads.push(thread("unsaved"));
      throw new Error("Remote edit failed");
    }).catch(() => {});

    // Then the failed operation leaves no durable lifetime
    expect(storage.db.query("SELECT id FROM reviews").all()).toEqual([]);
  });

  test("linking preserves the IDs of remote file flags and read receipts", async () => {
    // Given separate local and remote identities with matching tip/head evidence
    seedLink();
    storage.db.exec(`INSERT INTO review_files (id,review_id,path,github_viewed,sync_error) VALUES (42,'remote','file.ts',1,'Offline');
      INSERT INTO review_comment_reads (id,review_id,receipt_key,position) VALUES (50,'local','inline:1',0),(51,'remote','inline:2',0);`);

    // When observing the PR joins their review identities
    await recordPullRequest(storage, "example/repo/1", ["shared"], false, "shared");

    // Then remote rows move to the local identity without replacement
    expect(storage.db.query("SELECT id,review_id,path,github_viewed,sync_error FROM review_files").all())
      .toEqual([{ id: 42, review_id: "local", path: "file.ts", github_viewed: 1, sync_error: "Offline" }]);
    expect(storage.db.query("SELECT id,review_id,receipt_key,position FROM review_comment_reads ORDER BY position").all())
      .toEqual([{ id: 50, review_id: "local", receipt_key: "inline:1", position: 0 }, { id: 51, review_id: "local", receipt_key: "inline:2", position: 1 }]);
  });

  test("linking retains unanchored conversations and pending draft state", async () => {
    // Given a remote general conversation and a draft outside the anchored-thread projection
    seedLink();
    storage.db.exec(`INSERT INTO review_threads (id,review_id,kind,resolved,human_sequence,discussion_kind) VALUES ('general','remote','github',0,0,'general');
      INSERT INTO review_messages (id,thread_id,author,body,created_at,sequence) VALUES ('message','general','user','Keep this','today',0);
      INSERT INTO review_draft_state VALUES ('remote',3,'Pending summary','shared');
      INSERT INTO review_draft_receipts VALUES ('remote','publication','123');`);

    // When the remote lifetime merges into the local review
    await recordPullRequest(storage, "example/repo/1", ["shared"], false, "shared");

    // Then discussion and draft ownership survive the retired parent's deletion
    expect(storage.db.query("SELECT id,review_id FROM review_threads").all()).toEqual([{ id: "general", review_id: "local" }]);
    expect(storage.db.query("SELECT * FROM review_draft_state").all()).toEqual([{ review_id: "local", version: 3, body: "Pending summary", commit_id: "shared" }]);
    expect(storage.db.query("SELECT * FROM review_draft_receipts").all()).toEqual([{ review_id: "local", kind: "publication", token: "123" }]);
    expect(storage.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  test("a rejected alias redirect rolls back the entire identity merge", async () => {
    // Given linkable identities and a file flag owned by the PR
    seedLink();
    storage.db.exec(`INSERT INTO review_files (id,review_id,path,github_viewed) VALUES (42,'remote','file.ts',1);
      CREATE TRIGGER reject_redirect BEFORE UPDATE ON review_aliases BEGIN SELECT RAISE(ABORT,'alias rejected'); END;`);

    // When linking fails at the alias redirect after moving dependent entities
    await recordPullRequest(storage, "example/repo/1", ["shared"], false, "shared").catch(() => {});

    // Then all ownership changes rolled back with the redirect
    expect(await reviewIdentity(storage, "example/repo/1")).toEqual({ id: "remote", pr: "example/repo/1", closed: false });
    expect(storage.db.query("SELECT id,review_id FROM review_files").all()).toEqual([{ id: 42, review_id: "remote" }]);
  });

  /** Seed independently persisted identities without triggering linking before the test operation. */
  function seedLink(): void {
    const store = new ReviewStore(storage.db);
    store.save({ id: "local", closed: false, local: { workspace: "workspace", bookmark: "feature" }, commits: ["shared"], changes: ["change"], bookmarkTips: ["shared"] });
    store.save({ id: "remote", closed: false, pr: "example/repo/1", commits: ["shared"], changes: [], prHeads: ["shared"] });
    storage.db.exec(`INSERT INTO review_aliases VALUES ('example/repo/1','remote');
      UPDATE reviews SET viewed_sync_head='shared',viewed_sync_base='base' WHERE id='remote';`);
  }
});

/** Give each saved thread independent synthetic message identity and anchor evidence. */
function thread(id: string): ReviewThread {
  return { id, resolved: false, humanSequence: 1,
    anchor: { path: "file.ts", side: "RIGHT", line: 1, endLine: 1, commitId: "head", excerpt: "after();" },
    messages: [{ id: `${id}-message`, author: "user", body: "Original", sequence: 1, createdAt: "today" }] };
}
