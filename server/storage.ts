import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { migrate } from "./migrations";

/** One connection owns Biff's backend state and applies ordered schema upgrades. */
export class Storage {
  readonly db: Database;
  private writes = new Map<string, Promise<unknown>>();

  constructor(file: string = ":memory:") {
    if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    this.db = new Database(file, { create: true });
    if (file !== ":memory:") chmodSync(file, 0o600);
    // Rename in place so existing read markers and inbox choices survive the schema change.
    if (this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='personal'").get()) {
      this.db.exec("ALTER TABLE personal RENAME TO pr_user_state");
    }
    // Keep the original base schema so fresh and existing databases follow the same migrations.
    this.db.exec(`PRAGMA journal_mode=WAL;
      PRAGMA busy_timeout=5000;
      PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE);
      CREATE TABLE IF NOT EXISTS review_records (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS review_aliases (alias TEXT PRIMARY KEY, review_id TEXT NOT NULL REFERENCES review_records(id) DEFERRABLE INITIALLY DEFERRED);
      CREATE TABLE IF NOT EXISTS local_reviews (scope TEXT PRIMARY KEY, review_id TEXT NOT NULL REFERENCES review_records(id) DEFERRABLE INITIALLY DEFERRED);
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, workspace TEXT NOT NULL, updated_at TEXT NOT NULL, value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS sessions_workspace ON sessions(workspace);
      CREATE TABLE IF NOT EXISTS repository_users (repo TEXT PRIMARY KEY, updated_at INTEGER NOT NULL, users TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS prs (id TEXT PRIMARY KEY, summary TEXT NOT NULL, activity TEXT, activity_updated TEXT, activity_error TEXT);
      CREATE TABLE IF NOT EXISTS inbox_tracked_prs (id TEXT PRIMARY KEY, view TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pr_user_state (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS undo (token TEXT PRIMARY KEY, id TEXT NOT NULL, before_value TEXT NOT NULL, after_value TEXT NOT NULL, expires INTEGER NOT NULL);`);
    const trackingColumns = new Set(this.db.query<{ name: string }, []>("PRAGMA table_info(inbox_tracked_prs)").all().map((column) => column.name));
    for (const [name, definition] of Object.entries({ state: "TEXT NOT NULL DEFAULT 'OPEN'", closed_at: "INTEGER", archived_at: "INTEGER" })) {
      if (!trackingColumns.has(name)) this.db.exec(`ALTER TABLE inbox_tracked_prs ADD COLUMN ${name} ${definition}`);
    }
    if (!this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='inbox_queues'").get()) {
      this.db.exec("CREATE TABLE IF NOT EXISTS queues (view TEXT PRIMARY KEY, ids TEXT NOT NULL, updated_at INTEGER NOT NULL, error TEXT)");
    }
    // Do not recreate the legacy table after migration has renamed it.
    if (!this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='inbox_preferences'").get()) {
      this.db.exec("CREATE TABLE IF NOT EXISTS preferences (view TEXT PRIMARY KEY, value TEXT NOT NULL)");
    }
    migrate(this.db);
    // Existing queue membership is evidence of a request; unrelated cached PRs are not.
    this.db.exec(`INSERT OR IGNORE INTO inbox_tracked_prs (id, view)
      SELECT membership.pr_id, queue.queue_view FROM inbox_queue_prs AS membership
      JOIN inbox_queues AS queue ON queue.id=membership.queue_id`);
  }

  /**
   * Serialize asynchronous mutations within a domain, including across service instances.
   *
   * GitHub calls may await network I/O; never leave a SQLite transaction open during those awaits.
   * Each service commits its completed mutation synchronously before acknowledging it.
   */
  serialize<T>(domain: string, operation: () => Promise<T>): Promise<T> {
    const pending = (this.writes.get(domain) ?? Promise.resolve()).then(operation);
    this.writes.set(domain, pending.catch(() => {}));
    return pending;
  }

  /** Drain admitted domain mutations before shutting down the shared connection. */
  async close() {
    await Promise.all(this.writes.values());
    this.db.close();
  }
}
