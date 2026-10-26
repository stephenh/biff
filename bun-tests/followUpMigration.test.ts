import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { Storage } from "../server/storage";
import { Progress } from "../server/progress";
import { PrActivity } from "../server/prActivity";
import type { FollowUp } from "../shared/followUps";

describe("followUpMigration", () => {
  let directory: string;
  let storage: Storage;
  const review = "a".repeat(64);
  const pr = "example/project/12";
  const change = { path: "file.ts", hash: "hash", oldLine: 1, newLine: 1, duplicate: false };
  const flags: FollowUp[] = [
    { ...change, type: "hunk", head: "local-head", source: "local" },
    { type: "thread", id: "local:thread", label: "Old label", location: { path: "file.ts", side: "RIGHT", line: 1 } },
    { type: "thread", id: "github:42", label: "Pending remote hydration", location: { path: "other.ts", side: "RIGHT", line: 3 } },
  ];

  beforeEach(async () => {
    directory = await mkdtemp("/tmp/opencode/biff-follow-up-migration-");
    const db = new Database(`${directory}/biff.sqlite`);
    db.exec("CREATE TABLE review_records (id TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE review_aliases (alias TEXT PRIMARY KEY,review_id TEXT NOT NULL)");
    db.query("INSERT INTO review_records VALUES (?,?)").run(review, JSON.stringify({ id: review, pr, closed: false, records: [], commits: [], changes: [], followUps: flags, followUpHeads: { local: "local-head" },
      threads: [{ id: "thread", resolved: false, humanSequence: 0,
        anchor: { path: "file.ts", side: "RIGHT", line: 1, endLine: 1, commitId: "local-head", excerpt: "line" },
        hunk: { change, offset: 0, text: "line" }, messages: [{ id: "message", body: "Canonical question", author: "user", createdAt: "today", sequence: 1 }] }],
      githubFileReview: { repo: "example/project", number: "12", head: "head", files: [] } }));
    db.query("INSERT INTO review_aliases VALUES (?,?)").run(pr, review);
    db.query("INSERT INTO review_aliases VALUES (?,?)").run("jj/workspace/local", review);
    db.close();
    storage = new Storage(`${directory}/biff.sqlite`);
  });
  afterEach(async () => { await storage.close(); await rm(directory, { recursive: true, force: true }); });

  test("migration reuses the comment's hunk and preserves local presence across restart", async () => {
    // Given an old flag on an already-commented hunk
    const before = storage.db.query<{ hunk_id: string }, []>("SELECT hunk_id FROM thread_anchors WHERE thread_id='thread'").get()!;

    // When another startup opens the migrated database
    await reopen();

    // Then there is one canonical hunk with the original source observation and flag
    expect(storage.db.query("SELECT id,follow_up,local_head,pr_head FROM logical_hunks").all()).toEqual([{ id: before.hunk_id, follow_up: 1, local_head: "local-head", pr_head: null }]);
    expect(storage.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  test("migration removes only the extracted JSON collections", () => {
    // Given migrated flags and source cursors
    // When the remaining payload is read
    const row = storage.db.query<{ value: string }, []>("SELECT value FROM reviews").get()!;

    // Then deferred viewed-file state is intact and follow-up JSON is gone
    expect(JSON.parse(row.value)).toEqual({ records: [], githubFileReview: { repo: "example/project", number: "12", head: "head", files: [] } });
  });

  test("an unhydrated remote flag survives unrelated saves without inventing a message", async () => {
    // Given a legacy GitHub flag with anchor evidence but no fetched message
    const progress = new Progress(storage);

    // When another user action saves the review
    await progress.commentReads(pr, ["general:1"]);
    await reopen();

    // Then the flag remains actionable using its preserved location and label
    expect(new Progress(storage).followUps(pr)).toMatchObject([
      { id: "local:thread", label: "Canonical question" },
      { id: "github:42", label: "Pending remote hydration", location: { path: "other.ts", side: "RIGHT", line: 3 } },
    ]);
    expect(storage.db.query("SELECT id FROM review_messages").all()).toEqual([{ id: "message" }]);
  });

  test("hydration reuses the flagged remote thread instead of allocating a second identity", async () => {
    // Given a migrated flag whose GitHub comment is not cached yet
    const before = storage.db.query<{ id: string }, []>("SELECT id FROM review_threads WHERE thread_key='inline:42'").get()!;

    // When the canonical remote message is fetched
    new PrActivity(storage.db).comment(pr, { id: 42, body: "Fetched question", user: { login: "reviewer" }, html_url: "url", created_at: "today" }, "inline_comment");
    await new Progress(storage).commentReads(pr, ["inline:42"]);

    // Then publication, flag, and current label share the same thread
    expect(storage.db.query("SELECT id,follow_up FROM review_threads WHERE thread_key='inline:42'").all()).toEqual([{ id: before.id, follow_up: 1 }]);
    expect(new Progress(storage).followUps(pr)).toMatchObject([{ id: "local:thread" }, { id: "github:42", label: "Fetched question" }]);
  });

  /** Exercise the persisted relational state through a new connection. */
  async function reopen() {
    await storage.close();
    storage = new Storage(`${directory}/biff.sqlite`);
  }
});
