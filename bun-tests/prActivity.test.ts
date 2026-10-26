import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { Storage } from "../server/storage";
import { PrActivity } from "../server/prActivity";
import { Progress } from "../server/progress";
import { conversationActivity } from "../shared/commentActivity";
import type { DiscussionComment } from "../shared/types";
import type { Activity } from "../shared/inbox";

describe("PrActivity", () => {
  let storage: Storage;
  let activities: PrActivity;
  const pr = "example/repo/1";
  const summary = { number: 1, title: "PR", url: "https://github.com/example/repo/pull/1", repository: { nameWithOwner: "example/repo" }, author: { login: "author" }, isDraft: false, updatedAt: "2026-10-26T00:00:00Z" };
  const status = { head: "head", headAuthor: "author", reviewDecision: "APPROVED", reviewRequested: false, checks: "Passing", approvers: ["reviewer"] };

  beforeEach(() => {
    storage = new Storage();
    activities = new PrActivity(storage.db);
    activities.summary(summary);
  });
  afterEach(async () => { await storage.close(); });

  test("comments and reviews with overlapping GitHub IDs stay distinct", () => {
    // Given an issue comment, an inline comment, and a submitted review with the same remote ID
    const conversation = { comments: [comment(1, "General feedback")], inline: [comment(1, "Inline feedback")], reviews: [{ ...comment(1, "Approved"), state: "APPROVED", submitted_at: "today" }] };

    // When a complete snapshot is saved
    activities.save(pr, { ...status, events: conversationActivity(conversation), conversation });

    // Then the projection preserves each remote namespace and conversation
    expect(activities.get(pr)?.events).toEqual([
      { key: "general:1", actor: "reviewer", at: "today", kind: "reply", thread: "general" },
      { key: "inline:1", actor: "reviewer", at: "today", kind: "reply", thread: "inline:1" },
      { key: "review:1", actor: "reviewer", at: "today", kind: "review", hasBody: true },
    ]);
  });

  test("general comments share an unanchored conversation that progress updates preserve", async () => {
    // Given two top-level PR comments
    activities.conversation(pr, { comments: [comment(1, "First"), comment(2, "Second")], inline: [], reviews: [] });

    // When an unrelated read acknowledgement saves the same review lifetime
    await new Progress(storage).commentReads(pr, ["general:1"]);

    // Then both messages remain in the single general thread without a fake file anchor
    expect(storage.db.query(`SELECT t.discussion_kind,m.body,a.path FROM review_messages m
      JOIN review_threads t ON t.id=m.thread_id LEFT JOIN thread_anchors a ON a.thread_id=t.id ORDER BY m.github_id`).all()).toEqual([
      { discussion_kind: "general", body: "First", path: null },
      { discussion_kind: "general", body: "Second", path: null },
    ]);
  });

  test("refreshes update message text without replacing its synthetic identity", () => {
    // Given a persisted comment
    activities.comment(pr, comment(1, "Before"), "issue_comment");
    const before = storage.db.query<{ id: string }, []>("SELECT id FROM review_messages").get()!;

    // When GitHub returns edited text
    activities.conversation(pr, { comments: [comment(1, "After")], inline: [], reviews: [] });

    // Then the original local message identity survives
    expect(storage.db.query("SELECT id,body FROM review_messages").all()).toEqual([{ id: before.id, body: "After" }]);
  });

  test("submitted reviews persist decisions and bodies while pending reviews stay out of activity", () => {
    // Given an approved review and an unsubmitted review
    const conversation = { comments: [], inline: [], reviews: [{ ...comment(1, "Looks good"), state: "APPROVED" }, { ...comment(2, "Draft feedback"), state: "PENDING" }] };

    // When the snapshot is stored
    activities.save(pr, { ...status, events: conversationActivity(conversation), conversation });

    // Then only the submitted review contributes activity
    expect(activities.get(pr)?.events).toEqual([{ key: "review:1", actor: "reviewer", at: "", kind: "review", hasBody: true }]);
    expect(storage.db.query("SELECT github_id,state,body FROM pr_reviews ORDER BY github_id").all()).toEqual([
      { github_id: 1, state: "APPROVED", body: "Looks good" }, { github_id: 2, state: "PENDING", body: "Draft feedback" },
    ]);
  });

  test("a complete empty snapshot removes unread events but preserves comment history", () => {
    // Given a cached comment
    const conversation = { comments: [comment(1, "Deleted remotely")], inline: [], reviews: [] };
    activities.save(pr, { ...status, events: conversationActivity(conversation), conversation });

    // When a complete successful remote fetch reports no comments
    activities.conversation(pr, { comments: [], inline: [], reviews: [] });

    // Then history remains but no longer contributes an unread event
    expect(activities.get(pr)?.events).toEqual([]);
    expect(storage.db.query("SELECT body,remote_deleted_at IS NOT NULL AS deleted FROM review_messages").all()).toEqual([{ body: "Deleted remotely", deleted: 1 }]);
  });

  test("a failed snapshot rolls back status and discussion together", () => {
    // Given a saved status and comment
    const conversation = { comments: [comment(1, "Original")], inline: [], reviews: [] };
    activities.save(pr, { ...status, events: conversationActivity(conversation), conversation });
    const before = activities.get(pr);
    // And a database failure while saving a later review
    storage.db.exec("CREATE TRIGGER reject_review BEFORE INSERT ON pr_reviews BEGIN SELECT RAISE(ABORT, 'write rejected'); END");

    // When a newer snapshot fails halfway through
    const changed = { comments: [comment(1, "Changed")], inline: [], reviews: [{ ...comment(2, "No"), state: "CHANGES_REQUESTED" }] };
    try { activities.save(pr, { ...status, head: "new-head", events: conversationActivity(changed), conversation: changed }); } catch { /* Inspect committed state below. */ }

    // Then neither status nor comment text was partially committed
    expect(activities.get(pr)).toEqual(before);
    expect(storage.db.query("SELECT body FROM review_messages").all()).toEqual([{ body: "Original" }]);
  });

  test("a held full fetch cannot discard a newer acknowledged comment", () => {
    // Given a snapshot started before a comment was published
    const discussionVersion = activities.version(pr);
    // And the newer publication has already been acknowledged
    activities.comment(pr, comment(1, "Just published"), "issue_comment");

    // When the older fetch completes without that comment
    activities.save(pr, { ...status, events: [], conversation: { comments: [], inline: [], reviews: [] }, discussionVersion });

    // Then the published comment remains active
    expect(activities.get(pr)?.events).toEqual([{ key: "general:1", actor: "reviewer", at: "today", kind: "reply", thread: "general" }]);
  });

  test("reused discussion metadata does not replace newer canonical rows", () => {
    // Given fresh canonical text after a prior activity snapshot
    activities.comment(pr, comment(1, "Just published"), "issue_comment");

    // When only status is refreshed using the old discussion metadata
    activities.save(pr, { ...status, events: [], reuseDiscussion: true });

    // Then status refresh does not delete the comment
    expect(activities.get(pr)?.events.map((event) => event.key)).toEqual(["general:1"]);
  });

  test("migration retains known bodies and unknown legacy review evidence across restarts", async () => {
    // Given old activity JSON and an existing inline discussion publication
    const directory = await mkdtemp("/tmp/opencode/biff-activity-migration-");
    const file = `${directory}/legacy.sqlite`;
    const legacy = new Database(file);
    const messages = [{ id: "local-message", author: "user", login: "reviewer", body: "Known body", createdAt: "today", sequence: 1, published: { pr, id: 1, url: "url", publishedAt: "today" } }];
    const thread = { id: "local-thread", kind: "github", resolved: false, humanSequence: 0, anchor: { path: "file.ts", side: "RIGHT", line: 1, endLine: 1, commitId: "head", excerpt: "line" }, messages };
    legacy.exec("CREATE TABLE prs (id TEXT PRIMARY KEY, summary TEXT NOT NULL, activity TEXT, activity_updated TEXT, activity_error TEXT); CREATE TABLE review_records (id TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE review_aliases (alias TEXT PRIMARY KEY, review_id TEXT NOT NULL)");
    const events: Activity[] = [{ key: "inline:1", thread: "inline:1", kind: "reply", actor: "reviewer", at: "today" }, { key: "review:1", kind: "review", actor: "reviewer", at: "today", hasBody: true }];
    legacy.query("INSERT INTO prs VALUES (?,?,?,?,NULL)").run(pr, JSON.stringify(summary), JSON.stringify({ ...status, events }), summary.updatedAt);
    legacy.query("INSERT INTO review_records VALUES (?,?)").run("lifetime", JSON.stringify({ id: "lifetime", pr, closed: false, records: [], commits: [], changes: [], threads: [thread] }));
    legacy.query("INSERT INTO review_aliases VALUES (?,?)").run(pr, "lifetime");
    legacy.close();

    // When migration runs and the database reopens
    let migrated = new Storage(file);
    await migrated.close();
    migrated = new Storage(file);
    try {
      // Then known text and publication identity survive; missing review details remain explicitly unknown
      expect(migrated.db.query("SELECT id,body FROM review_messages").all()).toEqual([{ id: "local-message", body: "Known body" }]);
      expect(migrated.db.query("SELECT github_id,body,state,has_body FROM pr_reviews").all()).toEqual([{ github_id: 1, body: null, state: null, has_body: 1 }]);
      expect(new PrActivity(migrated.db).get(pr)?.events).toEqual(events);
    } finally {
      await migrated.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

/** Supply a GitHub comment without depending on network access. */
function comment(id: number, body: string): DiscussionComment {
  return { id, body, user: { login: "reviewer" }, created_at: "today", html_url: `https://github.com/example/repo/pull/1#comment-${id}` };
}
