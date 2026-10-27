import type { Database } from "bun:sqlite";
import type { ReviewIdentity } from "../shared/progress";

export interface ReviewMetadata extends ReviewIdentity {
  commits: string[];
  changes: string[];
  bookmarkTips?: string[];
  prHeads?: string[];
  discussionVersion?: number;
  commentReads?: string[];
}
interface ReviewRow {
  id: string; pr: string | null; local_workspace: string | null; local_bookmark: string | null;
  closed: number; discussion_version: number;
}
interface CommitRow { commit_sha: string; commit_position: number | null; bookmark_tip_position: number | null; pr_head_position: number | null }

/** Persist identity and linking evidence in the caller's atomic review transaction. */
export class ReviewStore {
  constructor(private db: Database) {}

  /** Reconstruct history in its original order, including tips outside the selected commit range. */
  get(id: string): ReviewMetadata {
    const row = this.db.query<ReviewRow, [string]>("SELECT * FROM reviews WHERE id=?").get(id)!;
    const commits = this.db.query<CommitRow, [string]>("SELECT * FROM review_commits WHERE review_id=?").all(id);
    return { id: row.id, closed: Boolean(row.closed), ...(row.pr === null ? {} : { pr: row.pr }),
      ...(row.local_workspace === null ? {} : { local: { workspace: row.local_workspace, bookmark: row.local_bookmark! } }),
      discussionVersion: row.discussion_version,
      commits: commitHistory(commits, "commit_position"), bookmarkTips: commitHistory(commits, "bookmark_tip_position"), prHeads: commitHistory(commits, "pr_head_position"),
      changes: this.db.query<{ change_id: string }, [string]>("SELECT change_id FROM review_changes WHERE review_id=? ORDER BY position").all(id).map((entry) => entry.change_id),
      commentReads: this.reads(id) };
  }

  /** Receipts remain valid even when their remote message has not been fetched or was deleted. */
  reads(id: string): string[] {
    return this.db.query<{ receipt_key: string }, [string]>("SELECT receipt_key FROM review_comment_reads WHERE review_id=? ORDER BY position").all(id).map((row) => row.receipt_key);
  }

  /**
   * Keep synthetic child IDs stable while replacing each collection's current membership.
   *
   * The caller owns the transaction so metadata, aliases, and discussion changes commit together.
   */
  save(review: ReviewMetadata): void {
    this.db.query(`INSERT INTO reviews (id,pr,local_workspace,local_bookmark,closed,discussion_version) VALUES (?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET pr=excluded.pr,local_workspace=excluded.local_workspace,
      local_bookmark=excluded.local_bookmark,closed=excluded.closed,discussion_version=excluded.discussion_version`)
      .run(review.id, review.pr ?? null, review.local?.workspace ?? null, review.local?.bookmark ?? null, Number(review.closed), review.discussionVersion ?? 0);

    const commits = new Set([...review.commits, ...(review.bookmarkTips ?? []), ...(review.prHeads ?? [])]);
    for (const sha of commits) this.db.query(`INSERT INTO review_commits (review_id,commit_sha,commit_position,bookmark_tip_position,pr_head_position) VALUES (?,?,?,?,?)
      ON CONFLICT(review_id,commit_sha) DO UPDATE SET commit_position=excluded.commit_position,bookmark_tip_position=excluded.bookmark_tip_position,pr_head_position=excluded.pr_head_position`)
      .run(review.id, sha, position(review.commits, sha), position(review.bookmarkTips ?? [], sha), position(review.prHeads ?? [], sha));
    for (const row of this.db.query<{ id: number; commit_sha: string }, [string]>("SELECT id,commit_sha FROM review_commits WHERE review_id=?").all(review.id)) {
      if (!commits.has(row.commit_sha)) this.db.query("DELETE FROM review_commits WHERE id=?").run(row.id);
    }
    this.saveKeys("review_changes", "change_id", review.id, review.changes);
    this.saveKeys("review_comment_reads", "receipt_key", review.id, review.commentReads ?? []);
  }

  /** Domain keys are unique within a review; row IDs survive unrelated saves. */
  private saveKeys(table: "review_changes" | "review_comment_reads", column: "change_id" | "receipt_key", review: string, keys: string[]): void {
    const unique = [...new Set(keys)];
    for (const [index, key] of unique.entries()) this.db.query(`INSERT INTO ${table} (review_id,${column},position) VALUES (?,?,?)
      ON CONFLICT(review_id,${column}) DO UPDATE SET position=excluded.position`).run(review, key, index);
    const retained = new Set(unique);
    for (const row of this.db.query<{ id: number; key: string }, [string]>(`SELECT id,${column} AS key FROM ${table} WHERE review_id=?`).all(review)) {
      if (!retained.has(row.key)) this.db.query(`DELETE FROM ${table} WHERE id=?`).run(row.id);
    }
  }
}

/** NULL means this SHA was never observed in this particular history. */
function position(values: string[], value: string): number | null {
  const index = values.indexOf(value);
  return index < 0 ? null : index;
}

/** A bookmark tip can be outside a selected range, so membership cannot be inferred from another role. */
function commitHistory(rows: CommitRow[], column: "commit_position" | "bookmark_tip_position" | "pr_head_position"): string[] {
  return rows.filter((row) => row[column] !== null).sort((a, b) => a[column]! - b[column]!).map((row) => row.commit_sha);
}
