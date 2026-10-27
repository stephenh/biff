import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { Storage } from "../server/storage";
import { migrate } from "../server/migrations";
import { Database } from "bun:sqlite";
import { createSchema } from "../server/schema";

describe("migrations", () => {
  let directory: string;
  let storage: Storage;

  beforeEach(async () => {
    directory = await mkdtemp("/tmp/opencode/biff-migrations-");
    storage = new Storage(`${directory}/state.sqlite`);
  });
  afterEach(async () => { await storage.close(); await rm(directory, { recursive: true, force: true }); });

  test("fresh databases start at the consolidated baseline", () => {
    // Given a freshly initialized database
    // When its schema version is read
    const versions = storage.db.query("SELECT version FROM schema_migrations ORDER BY version").all();

    // Then historical upgrade bodies are unnecessary
    expect(versions).toEqual([{ version: 19 }, { version: 20 }]);
  });

  test("future migrations run once across restarts", async () => {
    // Given existing data and a future column migration
    storage.db.exec("INSERT INTO inbox_preferences VALUES ('authored','example/repo')");
    const migrations = [{ version: 21, apply: (db: Storage["db"]) => { db.exec("ALTER TABLE inbox_preferences ADD COLUMN extra TEXT NOT NULL DEFAULT 'retained'"); } }];
    migrate(storage.db, migrations);

    // When the daemon reopens the database and encounters the same migration
    await storage.close();
    storage = new Storage(`${directory}/state.sqlite`);
    migrate(storage.db, migrations);

    // Then the column was added once and existing data survived
    expect(storage.db.query("SELECT * FROM inbox_preferences").all()).toEqual([{ queue_view: "authored", repository: "example/repo", extra: "retained" }]);
  });

  test("failed migrations roll back their schema changes and can retry", () => {
    // Given a migration that fails after its first schema change
    const migration = { version: 21, apply: (db: Storage["db"]) => {
      db.exec("ALTER TABLE inbox_preferences ADD COLUMN extra TEXT");
      throw new Error("Interrupted upgrade");
    } };
    try { migrate(storage.db, [migration]); } catch { /* Retry the same version below. */ }

    // When a corrected migration retries the same column change
    migrate(storage.db, [{ version: 21, apply: (db) => { db.exec("ALTER TABLE inbox_preferences ADD COLUMN extra TEXT"); } }]);

    // Then only the completed upgrade is recorded
    expect(storage.db.query("SELECT version FROM schema_migrations ORDER BY version").all()).toEqual([{ version: 19 }, { version: 20 }, { version: 21 }]);
  });

  test("startup does not recreate a table retired by a future migration", async () => {
    // Given a future migration retires a baseline table
    migrate(storage.db, [{ version: 21, apply: (db) => { db.exec("DROP TABLE inbox_preferences"); } }]);

    // When the daemon restarts
    await storage.close();
    storage = new Storage(`${directory}/state.sqlite`);

    // Then baseline creation does not undo that migration
    expect(storage.db.query("SELECT name FROM sqlite_master WHERE name='inbox_preferences'").all()).toEqual([]);
  });

  test("the snapshot upgrade discards old agent sessions while retaining durable reviews", () => {
    // Given a version-19 database with a disposable session and a durable review
    const db = new Database(":memory:");
    try {
      createSchema(db);
      db.exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY);
        INSERT INTO schema_migrations VALUES (19);
        INSERT INTO reviews (id) VALUES ('review');
        INSERT INTO workspaces VALUES ('workspace','Project','/project');
        INSERT INTO agent_sessions VALUES ('old-session','/project','today','{}');`);

      // When the new schema is applied
      migrate(db);

      // Then durable ownership survives while old session URLs are intentionally retired
      expect(db.query("SELECT id FROM reviews").all()).toEqual([{ id: "review" }]);
      expect(db.query("SELECT * FROM workspaces").all()).toEqual([{ id: "workspace", name: "Project", path: "/project" }]);
      expect(db.query("SELECT id FROM agent_sessions").all()).toEqual([]);
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally { db.close(); }
  });
});
