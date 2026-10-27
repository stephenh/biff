import { updateDiscussion } from "../server/discussionThreads";
import { followUpHunk, followUpThread, followUps } from "../server/followUps";
import { commentReads } from "../server/reviewStore";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { Storage } from "../server/storage";
import { PrActivity } from "../server/prActivity";
import { ReviewStore } from "../server/reviewStore";

describe("followUpPersistence", () => {
  let directory: string;
  let storage: Storage;
  const review = "a".repeat(64);
  const pr = "example/project/12";
  const change = { path: "file.ts", hash: "hash", oldLine: 1, newLine: 1, duplicate: false };

  beforeEach(async () => {
    directory = await mkdtemp("/tmp/opencode/biff-follow-up-persistence-");
    storage = new Storage(`${directory}/biff.sqlite`);
    new ReviewStore(storage.db).save({ id: review, pr, closed: false, commits: [], changes: [] });
    storage.db.query("INSERT INTO review_aliases VALUES (?,?)").run(pr, review);
    storage.db.query("INSERT INTO review_aliases VALUES (?,?)").run("jj/workspace/local", review);
    await updateDiscussion(storage, pr, (discussion) => {
      discussion.threads.push({ id: "thread", resolved: false, humanSequence: 0,
        anchor: { path: "file.ts", side: "RIGHT", line: 1, endLine: 1, commitId: "local-head", excerpt: "line" },
        hunk: { change, offset: 0, text: "line" }, messages: [{ id: "message", body: "Canonical question", author: "user", createdAt: "today", sequence: 1 }] });
    });
    await followUpHunk(storage, "jj/workspace/local", change, "local-head", true);
    await followUpThread(storage, pr, { type: "thread", id: "local:thread", label: "Old label", location: { path: "file.ts", side: "RIGHT", line: 1 } }, true);
    await followUpThread(storage, pr, { type: "thread", id: "github:42", label: "Pending remote hydration", location: { path: "other.ts", side: "RIGHT", line: 3 } }, true);
  });
  afterEach(async () => { await storage.close(); await rm(directory, { recursive: true, force: true }); });

  test("a flag shares the comment's hunk and preserves local presence across restart", async () => {
    // Given a flag on an already-commented hunk
    const before = storage.db.query<{ hunk_id: string }, []>("SELECT hunk_id FROM thread_anchors WHERE thread_id='thread'").get()!;

    // When another startup opens the database
    await reopen();

    // Then there is one canonical hunk with the original source observation and flag
    expect(storage.db.query("SELECT id,follow_up,local_head,pr_head FROM logical_hunks").all()).toEqual([{ id: before.hunk_id, follow_up: 1, local_head: "local-head", pr_head: null }]);
    expect(storage.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  test("an unhydrated remote flag survives unrelated saves without inventing a message", async () => {
    // Given a GitHub flag with anchor evidence but no fetched message

    // When another user action saves the review
    await commentReads(storage, pr, ["general:1"]);
    await reopen();

    // Then the flag remains actionable using its preserved location and label
    expect(followUps(storage, pr)).toMatchObject([
      { id: "local:thread", label: "Canonical question" },
      { id: "github:42", label: "Pending remote hydration", location: { path: "other.ts", side: "RIGHT", line: 3 } },
    ]);
    expect(storage.db.query("SELECT id FROM review_messages").all()).toEqual([{ id: "message" }]);
  });

  test("hydration reuses the flagged remote thread instead of allocating a second identity", async () => {
    // Given a flag whose GitHub comment is not cached yet
    const before = storage.db.query<{ id: string }, []>("SELECT id FROM review_threads WHERE thread_key='inline:42'").get()!;

    // When the canonical remote message is fetched
    new PrActivity(storage.db).comment(pr, { id: 42, body: "Fetched question", user: { login: "reviewer" }, html_url: "url", created_at: "today" }, "inline_comment");
    await commentReads(storage, pr, ["inline:42"]);

    // Then publication, flag, and current label share the same thread
    expect(storage.db.query("SELECT id,follow_up FROM review_threads WHERE thread_key='inline:42'").all()).toEqual([{ id: before.id, follow_up: 1 }]);
    expect(followUps(storage, pr)).toMatchObject([{ id: "local:thread" }, { id: "github:42", label: "Fetched question" }]);
  });

  /** Exercise the persisted relational state through a new connection. */
  async function reopen() {
    await storage.close();
    storage = new Storage(`${directory}/biff.sqlite`);
  }
});
