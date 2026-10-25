import type { Database } from "bun:sqlite";
import type { ReviewedChange } from "../shared/progress";
import { HunkApprovals } from "./hunkApprovals";

/** Apply ordered, transactional upgrades after the original base schema exists. */
export function migrate(db: Database) {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY)");
  const migrations = [extractHunkApprovals];
  for (const [index, migration] of migrations.entries()) db.transaction(() => {
    const version = index + 1;
    if (db.query("SELECT version FROM schema_migrations WHERE version=?").get(version)) return;
    migration(db);
    db.query("INSERT INTO schema_migrations(version) VALUES (?)").run(version);
  })();
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
