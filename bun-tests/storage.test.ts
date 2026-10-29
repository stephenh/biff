import { commentReads, reviewIdentity } from "../server/reviewStore";
import { updateDiscussion, readDiscussion } from "../server/discussionThreads";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { Storage } from "../server/storage";
import { Reviews } from "../server/reviews";
import { Workspaces } from "../server/workspaces";
import { Inbox } from "../server/inbox";
import type { LocalReview } from "../shared/types";

describe("Storage", () => {
  let directory: string;
  let storage: Storage;
  beforeEach(async () => {
    directory = await mkdtemp("/tmp/opencode/biff-storage-");
    storage = new Storage(`${directory}/biff.sqlite`);
  });
  afterEach(async () => { await storage.close(); await rm(directory, { recursive: true, force: true }); });

  test("working-copy registrations survive closing and reopening the shared database", async () => {
    // Given a registered canonical working copy
    const workspaces = new Workspaces(storage, async () => directory);
    await workspaces.add(directory, "Project");

    // When the database connection is reopened
    await reopen();
    const entries = await new Workspaces(storage).list();

    // Then the registration remains available
    expect(entries.map((entry) => entry.name)).toEqual(["Project"]);
  });

  test("session delivery cursors survive closing and reopening the database", async () => {
    // Given a session with acknowledged human feedback
    const reviews = new Reviews(storage);
    const session = await reviews.start(snapshot(directory), "agent-session");
    await reviews.update(session.id, true, () => {});
    await reviews.update(session.id, false, (review) => { review.acknowledged = review.humanSequence; });

    // When a fresh daemon reads the session
    await reopen();
    const restored = await new Reviews(storage).get(session.id);

    // Then it retains the independent delivery counters
    expect(restored).toMatchObject({ agentSession: "agent-session", sequence: 2, humanSequence: 1, acknowledged: 1 });
  });

  test("independent read acknowledgements share the database write queue", async () => {
    // Given two tabs using the same database

    // When independent tabs acknowledge messages concurrently
    await Promise.all([commentReads(storage, "example/repo/1", ["github:1"]), commentReads(storage, "example/repo/1", ["github:2"])]);

    // Then neither saved read marker is lost
    expect(await commentReads(storage, "example/repo/1")).toEqual(["github:1", "github:2"]);
  });

  test("an alias write failure rolls back its newly allocated review record", async () => {
    // Given SQLite rejects an alias write
    storage.db.exec("CREATE TRIGGER reject_alias BEFORE INSERT ON review_aliases BEGIN SELECT RAISE(ABORT, 'write rejected'); END");

    // When a lifetime cannot be committed completely
    await reviewIdentity(storage, "example/repo/1").catch(() => {});

    // Then no orphan review record remains
    expect(storage.db.query("SELECT id FROM reviews").all()).toEqual([]);
  });

  test("failed asynchronous discussion edits do not poison later saves", async () => {
    // Given an established review
    await reviewIdentity(storage, "example/repo/1");

    // When one asynchronous edit fails and a later read marker is saved
    await updateDiscussion(storage, "example/repo/1", async () => { throw new Error("GitHub unavailable"); }).catch(() => {});
    await commentReads(storage, "example/repo/1", ["github:3"]);

    // Then the later mutation is durable
    expect(await commentReads(storage, "example/repo/1")).toEqual(["github:3"]);
  });

  test("personal state survives subsequent restarts", async () => {
    // Given saved inbox state
    storage.db.query("INSERT INTO pr_user_state (id, archived, restored_until, snooze_until) VALUES (?, ?, ?, ?)").run("example/repo/1", 1, 0, 1800000000000);

    // When successive startups open the database
    await reopen();
    await reopen();

    // Then the original state is preserved
    expect(storage.db.query("SELECT * FROM pr_user_state").all()).toEqual([{ id: "example/repo/1", archived: 1, restored_until: 0, snooze_until: 1800000000000, new_changes: 0, changes_version: 0, changes_viewer: null, last_review_id: null }]);
  });

  test("repository preference updates survive a restart", async () => {
    // Given an inbox on a fresh database
    const source = { dashboard: async () => [], dashboardActivity: async () => { throw new Error("Unexpected GitHub call"); } };
    const inbox = new Inbox(storage, "me", source);
    inbox.preferences("authored", { repository: "example/old" });

    // When the selected repository changes and the database reopens
    inbox.preferences("authored", { repository: "example/new" });
    await reopen();

    // Then the latest filter is available through the inbox API
    expect(new Inbox(storage, "me", source).preferences("authored")).toEqual({ repository: "example/new" });
  });

  test("unsaved repository preferences default to all repositories", () => {
    // Given an inbox without saved preferences
    const inbox = new Inbox(storage, "me", { dashboard: async () => [], dashboardActivity: async () => { throw new Error("Unexpected GitHub call"); } });

    // When the filter is read for the first time
    const preferences = inbox.preferences("requested");

    // Then all repositories are selected
    expect(preferences).toEqual({ repository: "" });
  });

  test("agent sessions survive subsequent restarts", async () => {
    // Given a saved collaboration session
    const session = await new Reviews(storage).start(snapshot(directory), "agent-session");

    // When successive startups open the database
    await reopen();
    await reopen();

    // Then the entire session remains readable through the existing API
    expect(await new Reviews(storage).get(session.id)).toEqual(session);
    expect(storage.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'").all()).toEqual([]);
  });

  test("populated reviews preserve discussion ownership across restarts", async () => {
    // Given a review with an alias and a durable discussion
    await updateDiscussion(storage, "example/repo/1", (discussion) => {
      discussion.threads.push({ id: "thread", resolved: false, humanSequence: 0,
        anchor: { path: "file.ts", side: "RIGHT", line: 1, endLine: 1, commitId: "head", excerpt: "line" },
        messages: [{ id: "message", author: "user", body: "Keep this", createdAt: "today", sequence: 1 }] });
    });
    const before = await readDiscussion(storage, "example/repo/1");

    // When successive startups open the database
    await reopen();
    await reopen();

    // Then discussion identity and foreign keys survive without recreating the old table
    expect(await readDiscussion(storage, "example/repo/1")).toEqual(before);
    expect(storage.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(storage.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='review_records'").all()).toEqual([]);
    expect(storage.db.query<{ table: string }, []>("PRAGMA foreign_key_list(review_threads)").all().map((key) => key.table)).toEqual(["reviews"]);
  });

  test("reopening canonical session feedback does not deliver the same message again", async () => {
    // Given feedback with a persisted session-local delivery sequence
    const reviews = new Reviews(storage);
    const session = await reviews.start(snapshot(directory), "agent-session");
    const delivered = await reviews.update(session.id, true, (review) => {
      review.threads.push({ id: "thread", resolved: false, humanSequence: review.sequence,
        anchor: { path: "file.ts", side: "RIGHT", line: 1, endLine: 1, commitId: "head", excerpt: "code" },
        messages: [{ id: "message", author: "user", body: "Feedback", createdAt: "today", sequence: review.sequence }] });
    });

    // When both database connection and session service restart
    await reopen();

    // Then reconstructing the shared message preserves the original delivery state exactly
    expect(await new Reviews(storage).get(session.id)).toEqual(delivered);
  });

  /** Exercise real connection teardown rather than just constructing a new service. */
  async function reopen() {
    await storage.close();
    storage = new Storage(`${directory}/biff.sqlite`);
  }
});

/** Supply a minimal immutable session snapshot without invoking JJ. */
function snapshot(path: string): LocalReview {
  const revision = { commit_id: "a".repeat(40), change_id: "change", description: "A review", author: { name: "Author", email: "author@example.com", timestamp: "2026-10-18T00:00:00Z" } };
  return { workspace: { id: "workspace", name: "Project", path }, selected: revision, revisions: [revision], patch: "" };
}
