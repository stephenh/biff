import type { Database } from "bun:sqlite";
import type { ChangeIdentity, ReviewedChange } from "../shared/progress";

interface ApprovalRow { path: string; hash: string; old_line: number; new_line: number; duplicate: number; kind: string; head: string; reviewed_at: string }

/** Store approval evidence without retaining diffs or hunk contents. */
export class HunkApprovals {
  constructor(private db: Database) {}

  /** Read only one lifetime; aliases are resolved by the review domain. */
  get(review: string): ReviewedChange[] {
    return this.db.query<ApprovalRow, [string]>("SELECT * FROM hunk_approvals WHERE review_id=? ORDER BY rowid").all(review).map(fromRow);
  }

  /** Replace matching evidence while preserving duplicate-aware coordinate matching. */
  update(review: string, identity: ChangeIdentity, reviewed: boolean, head: string) {
    this.db.query(`DELETE FROM hunk_approvals WHERE review_id=? AND path=? AND hash=? AND kind=?
      AND ((duplicate=0 AND ?=0) OR (old_line=? AND new_line=?))`)
      .run(review, identity.path, identity.hash, identity.kind ?? "", Number(identity.duplicate), identity.oldLine, identity.newLine);
    if (reviewed) this.insert(review, { ...identity, head, reviewedAt: new Date().toISOString() });
  }

  /** Registry merges use the caller's transaction to move approvals with aliases atomically. */
  replace(review: string, records: ReviewedChange[]) {
    this.db.query("DELETE FROM hunk_approvals WHERE review_id=?").run(review);
    for (const record of records) this.insert(review, record);
  }

  /** Preserve original review timestamps when importing or merging evidence. */
  insert(review: string, record: ReviewedChange) {
    if (record.kind === "file") throw new Error("File completion must be derived from hunk approvals");
    this.db.query("INSERT OR REPLACE INTO hunk_approvals(review_id,path,hash,old_line,new_line,duplicate,kind,head,reviewed_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(review, record.path, record.hash, record.oldLine, record.newLine, Number(record.duplicate), record.kind ?? "", record.head, record.reviewedAt);
  }
}

/** Keep SQL representation out of the shared approval contract. */
function fromRow(row: ApprovalRow): ReviewedChange {
  return { path: row.path, hash: row.hash, oldLine: row.old_line, newLine: row.new_line, duplicate: Boolean(row.duplicate), ...(row.kind === "metadata" ? { kind: "metadata" as const } : {}), head: row.head, reviewedAt: row.reviewed_at };
}
