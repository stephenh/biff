import type { Database } from "bun:sqlite";
import { matchesChange, type ChangeIdentity, type ReviewedChange } from "../shared/progress";

export interface LogicalHunk {
  id: string; path: string; hash: string; old_line: number; new_line: number; duplicate: number;
  follow_up: number; local_head: string | null; pr_head: string | null;
  kind: "" | "metadata"; reviewed_head: string | null; reviewed_at: string | null;
  pr_reviewable: number;
}

/** Share identity between approvals, comment anchors, and flags, including non-text review units. */
export function logicalHunk(db: Database, review: string, change: ChangeIdentity): string {
  if (change.kind === "file") throw new Error("File completion must be derived from review units");
  const candidates = db.query<LogicalHunk, [string, string, string]>("SELECT * FROM logical_hunks WHERE review_id=? AND path=? AND hash=?").all(review, change.path, change.hash)
    .filter((row) => matchesChange(hunkIdentity(row), change));
  const existing = candidates.find((row) => row.old_line === change.oldLine && row.new_line === change.newLine) ?? candidates[0];
  if (existing) {
    // Once content is duplicated, its old unique receipt must not approve another occurrence.
    if (change.duplicate && !existing.duplicate) db.query("UPDATE logical_hunks SET duplicate=1 WHERE id=?").run(existing.id);
    return existing.id;
  }
  const id = crypto.randomUUID();
  // Migration 8 uses this identity writer before presence and follow-up columns exist.
  if (change.kind === "metadata") {
    db.query("INSERT INTO logical_hunks (id,review_id,path,hash,old_line,new_line,duplicate,kind) VALUES (?,?,?,?,?,?,?,'metadata')")
      .run(id, review, change.path, change.hash, change.oldLine, change.newLine, Number(change.duplicate));
  } else {
    db.query("INSERT INTO logical_hunks (id,review_id,path,hash,old_line,new_line,duplicate) VALUES (?,?,?,?,?,?,?)")
      .run(id, review, change.path, change.hash, change.oldLine, change.newLine, Number(change.duplicate));
  }
  return id;
}

/** Keep duplicate-disambiguation coordinates separate from the stable synthetic ID. */
export function hunkIdentity(row: LogicalHunk): ChangeIdentity {
  return { path: row.path, hash: row.hash, oldLine: row.old_line, newLine: row.new_line, duplicate: Boolean(row.duplicate), ...(row.kind === "metadata" ? { kind: "metadata" as const } : {}) };
}

/** Keep the existing approval API while storing its evidence on the canonical unit. */
export function reviewedHunks(db: Database, review: string): ReviewedChange[] {
  return db.query<LogicalHunk, [string]>("SELECT * FROM logical_hunks WHERE review_id=? AND reviewed_at IS NOT NULL ORDER BY rowid").all(review)
    .map((row) => ({ ...hunkIdentity(row), head: row.reviewed_head!, reviewedAt: row.reviewed_at! }));
}

/**
 * Change approval state without deleting an entity referenced by comments or follow-ups.
 *
 * An explicit approval retains the user's latest duplicate-disambiguation coordinates. Anchors keep
 * their original coordinates separately, so a new approval cannot move an existing comment.
 */
export function reviewHunk(db: Database, review: string, change: ChangeIdentity, head: string, reviewedAt: string | null): void {
  if (change.kind === "file") throw new Error("File completion must be derived from review units");
  db.query(`UPDATE logical_hunks SET reviewed_head=NULL,reviewed_at=NULL WHERE review_id=? AND path=? AND hash=? AND kind=?
    AND ((duplicate=0 AND ?=0) OR (old_line=? AND new_line=?))`)
    .run(review, change.path, change.hash, change.kind ?? "", Number(change.duplicate), change.oldLine, change.newLine);
  if (reviewedAt === null) return;
  const id = logicalHunk(db, review, change);
  db.query("UPDATE logical_hunks SET reviewed_head=?,reviewed_at=?,old_line=?,new_line=?,duplicate=? WHERE id=?")
    .run(head, reviewedAt, change.oldLine, change.newLine, Number(change.duplicate), id);
}

/**
 * Merge source observations, approvals, and flags before retiring a linked review lifetime.
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
    const evidence = target.reviewed_at !== null ? target : row.reviewed_at !== null ? row : target;
    db.query("UPDATE logical_hunks SET follow_up=?,local_head=?,pr_head=?,reviewed_head=?,reviewed_at=?,old_line=?,new_line=?,duplicate=?,pr_reviewable=? WHERE id=?")
      .run(Number(Boolean(target.follow_up || row.follow_up)), target.local_head ?? row.local_head, target.pr_head ?? row.pr_head,
        evidence.reviewed_head, evidence.reviewed_at, evidence.old_line, evidence.new_line, evidence.duplicate, target.pr_head !== null ? target.pr_reviewable : row.pr_reviewable, target.id);
    db.query("UPDATE thread_anchors SET hunk_id=? WHERE hunk_id=?").run(target.id, row.id);
    db.query("DELETE FROM logical_hunks WHERE id=?").run(row.id);
  }
  db.query("UPDATE reviews SET local_reconciled_head=NULL,pr_reconciled_head=NULL WHERE id=?").run(to);
}
