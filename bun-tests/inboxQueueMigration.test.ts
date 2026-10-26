import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { Storage } from "../server/storage";

describe("inboxQueueMigration", () => {
  let directory: string;
  let legacy: Database;
  let storage: Storage | undefined;

  beforeEach(async () => {
    directory = await mkdtemp("/tmp/opencode/biff-queue-migration-");
    storage = undefined;
    legacy = new Database(`${directory}/inbox.sqlite`);
    legacy.exec(`CREATE TABLE queues (view TEXT PRIMARY KEY, ids TEXT NOT NULL, updated_at INTEGER NOT NULL, error TEXT);
      CREATE TABLE prs (id TEXT PRIMARY KEY, summary TEXT NOT NULL, activity TEXT, activity_updated TEXT, activity_error TEXT);
      CREATE TABLE inbox_tracked_prs (id TEXT PRIMARY KEY, view TEXT NOT NULL, state TEXT NOT NULL, closed_at INTEGER, archived_at INTEGER);
      CREATE TABLE preferences (view TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO queues VALUES ('authored', '[]', 100, NULL), ('requested', '["example/repo/1"]', 200, NULL),
        ('dependabot', '["example/repo/1","example/repo/2"]', 150, 'offline');
      INSERT INTO inbox_tracked_prs VALUES ('example/repo/3', 'dependabot', 'MERGED', 50, 100);
      INSERT INTO preferences VALUES ('requested', '{"repository":"example/human"}'), ('dependabot', '{"repository":"example/bot"}');`);
    for (const number of [1, 2, 3]) {
      const summary = { number, title: `PR ${number}`, url: `https://github.com/example/repo/pull/${number}`, repository: { nameWithOwner: "example/repo" }, author: { login: number === 1 ? "human" : "dependabot" }, isDraft: false, updatedAt: "2026-10-26T00:00:00Z" };
      legacy.query("INSERT INTO prs (id, summary) VALUES (?, ?)").run(`example/repo/${number}`, JSON.stringify(summary));
    }
  });
  afterEach(async () => {
    legacy.close();
    await storage?.close();
    await rm(directory, { recursive: true, force: true });
  });

  test("merges legacy membership through synthetic queue IDs without duplicates", async () => {
    // Given overlapping human and Dependabot discovery snapshots
    // When migration runs and the server restarts
    await reopen();
    await reopen();

    // Then membership references the merged queue by its synthetic ID
    expect(storage!.db.query(`SELECT queue.queue_view, membership.pr_id FROM inbox_queue_prs AS membership
      JOIN inbox_queues AS queue ON queue.id=membership.queue_id ORDER BY membership.pr_id`).all()).toEqual([
      { queue_view: "requested", pr_id: "example/repo/1" },
      { queue_view: "requested", pr_id: "example/repo/2" },
    ]);
  });

  test("retains empty queues and the older refresh timestamp with errors", async () => {
    // Given an empty authored queue and separate review refresh metadata
    // When migration merges the review snapshots
    await reopen();

    // Then emptiness is cached and a failed half remains visible
    expect(storage!.db.query("SELECT queue_view, updated_at, error FROM inbox_queues ORDER BY queue_view").all()).toEqual([
      { queue_view: "authored", updated_at: 100, error: null },
      { queue_view: "requested", updated_at: 150, error: "offline" },
    ]);
  });

  test("preserves archived bot history outside current queue membership", async () => {
    // Given an archived bot PR absent from both discovery snapshots
    // When startup migrates and reopens the database
    await reopen();
    await reopen();

    // Then its archived state survives in the requested queue
    expect(storage!.db.query("SELECT * FROM inbox_tracked_prs WHERE id='example/repo/3'").get()).toEqual({
      id: "example/repo/3", view: "requested", state: "MERGED", closed_at: 50, archived_at: 100,
    });
  });

  test("keeps the requested repository filter when consolidating preferences", async () => {
    // Given distinct repository filters on the two legacy queues
    // When migration merges their preferences
    await reopen();

    // Then the filter already used by Needs Review wins
    expect(storage!.db.query("SELECT * FROM inbox_preferences").all()).toEqual([{ queue_view: "requested", repository: "example/human" }]);
  });

  test("does not recreate the JSON queue table on restart", async () => {
    // Given the old queue schema
    // When migration and a subsequent startup run
    await reopen();
    await reopen();

    // Then the obsolete JSON table remains removed
    expect(storage!.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='queues'").all()).toEqual([]);
  });

  /** Exercise startup backfills as well as the schema upgrade. */
  async function reopen() {
    await storage?.close();
    storage = new Storage(`${directory}/inbox.sqlite`);
  }
});
