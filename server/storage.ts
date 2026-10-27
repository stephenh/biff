import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createSchema } from "./schema";
import { migrate } from "./migrations";

/** One connection owns Biff's backend state and initializes new databases. */
export class Storage {
  readonly db: Database;
  private writes = new Map<string, Promise<unknown>>();

  constructor(file: string = ":memory:") {
    if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    this.db = new Database(file, { create: true });
    if (file !== ":memory:") chmodSync(file, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL;
      PRAGMA busy_timeout=5000;
      PRAGMA foreign_keys=ON;`);
    // Replaying the baseline on every startup would recreate tables retired by future migrations.
    if (!this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get()) createSchema(this.db);
    migrate(this.db);
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
