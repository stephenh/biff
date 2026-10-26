import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { Storage } from "../server/storage";
import { Inbox } from "../server/inbox";

describe("inboxMigration", () => {
  let directory: string;
  let legacy: Database;
  let storage: Storage | undefined;
  const id = "example/repo/1";
  const now = 1_800_000_000_000;
  const summary = { number: 1, title: "A PR", url: "https://github.com/example/repo/pull/1", repository: { nameWithOwner: "Example/Repo" }, author: { login: "author" }, isDraft: true, updatedAt: "2026-10-26T00:00:00Z", createdAt: "2026-10-25T00:00:00Z" };
  const activity = { head: "abc", headAuthor: "author", reviewDecision: "", checks: "Passing", events: [] };
  const source = { dashboard: async () => [], dashboardActivity: async () => activity };

  beforeEach(async () => {
    directory = await mkdtemp("/tmp/opencode/biff-inbox-migration-");
    storage = undefined;
    legacy = new Database(`${directory}/inbox.sqlite`);
    legacy.exec(`CREATE TABLE prs (id TEXT PRIMARY KEY, summary TEXT NOT NULL, activity TEXT, activity_updated TEXT, activity_error TEXT);
      CREATE TABLE personal (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE undo (token TEXT PRIMARY KEY, id TEXT NOT NULL, before_value TEXT NOT NULL, after_value TEXT NOT NULL, expires INTEGER NOT NULL);`);
    legacy.query("INSERT INTO prs VALUES (?, ?, ?, ?, ?)").run(id, JSON.stringify(summary), JSON.stringify({ ...activity, viewer: "old-account" }), summary.updatedAt, "offline");
  });
  afterEach(async () => {
    legacy.close();
    await storage?.close();
    await rm(directory, { recursive: true, force: true });
  });

  test("PR summary columns preserve the independently cached activity across restarts", async () => {
    // Given a legacy PR with its summary, activity, and error cached independently
    // When startup migrates the database and a second startup reopens it
    await reopen();
    await reopen();

    // Then PR data survives while the obsolete per-PR authenticated identity is removed
    expect(storage!.db.query("SELECT * FROM prs").all()).toEqual([{
      id, number: 1, title: summary.title, url: summary.url, repository: "Example/Repo", author: "author", is_draft: 1,
      updated_at: summary.updatedAt, created_at: summary.createdAt, activity: JSON.stringify(activity), activity_updated: summary.updatedAt, activity_error: "offline",
    }]);
  });

  test("legacy personal choices retain Ignore intent, explicit false, and missing-field defaults", async () => {
    // Given old Ignore intent alongside newer Archive intent and an empty personal record
    legacy.query("INSERT INTO personal VALUES (?, ?)").run(id, JSON.stringify({ ignored: true, snoozeUntil: now, seenHead: "abc" }));
    legacy.query("INSERT INTO personal VALUES (?, ?)").run("example/repo/2", JSON.stringify({ archived: false, ignored: true, restoredUntil: now }));
    legacy.query("INSERT INTO personal VALUES (?, ?)").run("example/repo/3", "{}");

    // When migration and another startup run
    await reopen();
    await reopen();

    // Then only current personal choices remain, with the same effective values
    expect(storage!.db.query("SELECT * FROM pr_user_state ORDER BY id").all()).toEqual([
      { id, archived: 1, restored_until: 0, snooze_until: now },
      { id: "example/repo/2", archived: 0, restored_until: now, snooze_until: 0 },
      { id: "example/repo/3", archived: 0, restored_until: 0, snooze_until: 0 },
    ]);
  });

  test("an outstanding JSON undo receipt remains usable after migration", async () => {
    // Given an archive action with a still-valid legacy receipt
    legacy.query("INSERT INTO personal VALUES (?, ?)").run(id, JSON.stringify({ archived: true }));
    legacy.query("INSERT INTO undo VALUES (?, ?, ?, ?, ?)").run("receipt", id,
      JSON.stringify({ archived: false, restoredUntil: now, snoozeUntil: now + 1000 }),
      JSON.stringify({ archived: true, restoredUntil: 0, snoozeUntil: 0 }), now + 60_000);

    // When the migrated receipt is used after another restart
    await reopen();
    await reopen();
    const result = new Inbox(storage!, "me", source, () => now).act(id, { action: "undo", token: "receipt" });

    // Then the prior choices are restored through the normal inbox API
    expect(result.item?.personal).toEqual({ archived: false, restoredUntil: now, snoozeUntil: now + 1000 });
  });

  test("a migrated receipt cannot overwrite a newer personal choice", async () => {
    // Given a legacy receipt whose after-state no longer matches personal state
    legacy.query("INSERT INTO personal VALUES (?, ?)").run(id, JSON.stringify({ archived: true, snoozeUntil: now }));
    legacy.query("INSERT INTO undo VALUES (?, ?, ?, ?, ?)").run("receipt", id, "{}", JSON.stringify({ archived: true }), now + 60_000);

    // When an old tab tries to undo after migration
    await reopen();
    const inbox = new Inbox(storage!, "me", source, () => now);

    // Then the stale action is rejected
    expect(() => inbox.act(id, { action: "undo", token: "receipt" })).toThrow("This PR changed since that action");
  });

  test("migration preserves receipt expiry", async () => {
    // Given an expired legacy receipt
    legacy.query("INSERT INTO personal VALUES (?, ?)").run(id, JSON.stringify({ archived: true }));
    legacy.query("INSERT INTO undo VALUES (?, ?, ?, ?, ?)").run("receipt", id, "{}", JSON.stringify({ archived: true }), now - 1);

    // When the expired receipt is used after migration
    await reopen();
    const inbox = new Inbox(storage!, "me", source, () => now);

    // Then expiry is still enforced
    expect(() => inbox.act(id, { action: "undo", token: "receipt" })).toThrow("Undo has expired");
  });

  test("new relational undo receipts survive restarting the server", async () => {
    // Given a new archive receipt created after migration
    await reopen();
    const receipt = new Inbox(storage!, "me", source, () => now).act(id, { action: "archive" });

    // When the server restarts and the action is undone
    await reopen();
    const result = new Inbox(storage!, "me", source, () => now).act(id, { action: "undo", token: receipt.undo! });

    // Then all original choices are restored
    expect(result.item?.personal).toEqual({ archived: false, restoredUntil: 0, snoozeUntil: 0 });
  });

  /** Open through real startup so the legacy table rename and all migrations run. */
  async function reopen() {
    await storage?.close();
    storage = new Storage(`${directory}/inbox.sqlite`);
  }
});
