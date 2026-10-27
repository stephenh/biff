import type { Database } from "bun:sqlite";

interface Migration { version: number; apply: (db: Database) => void }

/** Apply future upgrades after schema.ts creates the version-19 baseline on fresh databases. */
export function migrate(db: Database, migrations: Migration[] = [
  // Add migrations starting at version 20. Versions 1–19 are included in schema.ts.
]): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY);
    INSERT OR IGNORE INTO schema_migrations (version) VALUES (19);`);
  for (const migration of migrations) db.transaction(() => {
    if (db.query("SELECT version FROM schema_migrations WHERE version=?").get(migration.version)) return;
    migration.apply(db);
    db.query("INSERT INTO schema_migrations (version) VALUES (?)").run(migration.version);
  })();
}
