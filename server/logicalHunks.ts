import type { Database } from "bun:sqlite";
import { matchesChange, type ChangeIdentity } from "../shared/progress";

export interface LogicalHunk {
  id: string; path: string; hash: string; old_line: number; new_line: number; duplicate: number;
  follow_up: number; local_head: string | null; pr_head: string | null;
}

/** Share identity between comment anchors and flags, including hunks without comments. */
export function logicalHunk(db: Database, review: string, change: ChangeIdentity): string {
  const existing = db.query<LogicalHunk, [string, string, string]>("SELECT * FROM logical_hunks WHERE review_id=? AND path=? AND hash=?").all(review, change.path, change.hash)
    .find((row) => matchesChange(hunkIdentity(row), change));
  if (existing) return existing.id;
  const id = crypto.randomUUID();
  // Migration 8 uses this identity writer before presence and follow-up columns exist.
  db.query("INSERT INTO logical_hunks (id,review_id,path,hash,old_line,new_line,duplicate) VALUES (?,?,?,?,?,?,?)")
    .run(id, review, change.path, change.hash, change.oldLine, change.newLine, Number(change.duplicate));
  return id;
}

/** Keep duplicate-disambiguation coordinates separate from the stable synthetic ID. */
export function hunkIdentity(row: LogicalHunk): ChangeIdentity {
  return { path: row.path, hash: row.hash, oldLine: row.old_line, newLine: row.new_line, duplicate: Boolean(row.duplicate) };
}

/**
 * Merge source observations and flags before retiring a linked review lifetime.
 *
 * Anchors retain their own original coordinates; only their logical identity changes when two rows match.
 */
export function mergeLogicalHunks(db: Database, from: string, to: string): void {
  for (const row of db.query<LogicalHunk, [string]>("SELECT * FROM logical_hunks WHERE review_id=?").all(from)) {
    const target = db.query<LogicalHunk, [string]>("SELECT * FROM logical_hunks WHERE review_id=?").all(to).find((candidate) => matchesChange(hunkIdentity(candidate), hunkIdentity(row)));
    if (!target) {
      db.query("UPDATE logical_hunks SET review_id=? WHERE id=?").run(to, row.id);
      continue;
    }
    db.query("UPDATE logical_hunks SET follow_up=?,local_head=?,pr_head=? WHERE id=?")
      .run(Number(Boolean(target.follow_up || row.follow_up)), target.local_head ?? row.local_head, target.pr_head ?? row.pr_head, target.id);
    db.query("UPDATE thread_anchors SET hunk_id=? WHERE hunk_id=?").run(target.id, row.id);
    db.query("DELETE FROM logical_hunks WHERE id=?").run(row.id);
  }
  db.query("UPDATE reviews SET local_reconciled_head=NULL,pr_reconciled_head=NULL WHERE id=?").run(to);
}
