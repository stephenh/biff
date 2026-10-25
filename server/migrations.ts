import type { Database } from "bun:sqlite";
import type { ReviewedChange } from "../shared/progress";
import { HunkApprovals } from "./hunkApprovals";

/** Apply ordered, transactional upgrades after the original base schema exists. */
export function migrate(db: Database) {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY)");
  // Version 2 briefly introduced comparison receipts. Keep its number retired on existing databases.
  const migrations = [{ version: 1, apply: extractHunkApprovals }, { version: 3, apply: removeComparisonKey }];
  for (const migration of migrations) db.transaction(() => {
    const { version } = migration;
    if (db.query("SELECT version FROM schema_migrations WHERE version=?").get(version)) return;
    migration.apply(db);
    db.query("INSERT INTO schema_migrations(version) VALUES (?)").run(version);
  })();
}

/** Remove the retired receipt key without changing review data or approvals. */
function removeComparisonKey(db: Database) {
  db.exec("DROP TABLE IF EXISTS comparison_key");
}

/** Keep legacy file evidence until an exact loaded comparison can translate it safely. */
function extractHunkApprovals(db: Database) {
  db.exec(`CREATE TABLE hunk_approvals (
    review_id TEXT NOT NULL REFERENCES review_records(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    path TEXT NOT NULL, hash TEXT NOT NULL, old_line INTEGER NOT NULL, new_line INTEGER NOT NULL,
    duplicate INTEGER NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('', 'metadata')),
    head TEXT NOT NULL, reviewed_at TEXT NOT NULL,
    PRIMARY KEY(review_id,path,hash,old_line,new_line,kind)
  )`);
  const approvals = new HunkApprovals(db);
  for (const row of db.query<{ id: string; value: string }, []>("SELECT id,value FROM review_records").all()) {
    const value = JSON.parse(row.value) as { records?: ReviewedChange[] };
    for (const record of value.records ?? []) if (record.kind !== "file") approvals.insert(row.id, record);
    value.records = (value.records ?? []).filter((record) => record.kind === "file");
    db.query("UPDATE review_records SET value=? WHERE id=?").run(JSON.stringify(value), row.id);
  }
}
