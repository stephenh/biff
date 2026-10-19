import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { Storage } from "../server/storage";
import { Progress } from "../server/progress";
import { Reviews } from "../server/reviews";
import { Workspaces } from "../server/workspaces";
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

  test("separate progress services share the same write queue", async () => {
    // Given two services attached to the same database
    const first = new Progress(storage);
    const second = new Progress(storage);

    // When independent tabs acknowledge messages concurrently
    await Promise.all([first.commentReads("example/repo/1", ["github:1"]), second.commentReads("example/repo/1", ["github:2"])]);

    // Then neither saved read marker is lost
    expect(await first.commentReads("example/repo/1")).toEqual(["github:1", "github:2"]);
  });

  test("an alias write failure rolls back its newly allocated review record", async () => {
    // Given SQLite rejects an alias write
    storage.db.exec("CREATE TRIGGER reject_alias BEFORE INSERT ON review_aliases BEGIN SELECT RAISE(ABORT, 'write rejected'); END");
    const progress = new Progress(storage);

    // When a lifetime cannot be committed completely
    await progress.identity("example/repo/1").catch(() => {});

    // Then no orphan review record remains
    expect(storage.db.query("SELECT id FROM review_records").all()).toEqual([]);
  });

  test("failed asynchronous discussion edits do not poison later saves", async () => {
    // Given an established review
    const progress = new Progress(storage);
    await progress.identity("example/repo/1");

    // When one asynchronous edit fails and a later read marker is saved
    await progress.updateDiscussion("example/repo/1", async () => { throw new Error("GitHub unavailable"); }).catch(() => {});
    await progress.commentReads("example/repo/1", ["github:3"]);

    // Then the later mutation is durable
    expect(await progress.commentReads("example/repo/1")).toEqual(["github:3"]);
  });

  test("legacy personal state survives the table rename and subsequent restarts", async () => {
    // Given a database with the old table name and saved inbox state
    storage.db.exec("ALTER TABLE pr_user_state RENAME TO personal");
    const value = JSON.stringify({ ignored: true, pinned: true, snoozeUntil: 1800000000000, seenHead: "abc", seenEvents: ["inline:1"], isNew: false, unread: false });
    storage.db.query("INSERT INTO personal VALUES (?, ?)").run("example/repo/1", value);

    // When startup migrates the database and another restart opens it again
    await reopen();
    await reopen();

    // Then the original state is preserved in the renamed table
    expect(storage.db.query("SELECT * FROM pr_user_state").all()).toEqual([{ id: "example/repo/1", value }]);
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
