import type { Database } from "bun:sqlite";
import type { ChangeIdentity } from "../shared/progress";
import type { SinceReview } from "../shared/sinceReview";
import { findReview } from "./reviewStore";
import { hunkIdentity, logicalHunk, type LogicalHunk } from "./logicalHunks";

interface SubmittedReview {
  id: number; github_id: number; commit_sha: string | null; comparison_base_sha: string | null; submitted_at: string | null;
}

/** Copy the displayed complete inventory before publication can overlap another push. */
export function captureSinceReview(db: Database, scope: string, head: string, base: string): { base: string; units: ChangeIdentity[] } | undefined {
  const id = findReview(db, scope)?.id ?? "";
  const comparison = db.query<{ pr_reconciled_base: string | null }, [string, string]>(
    "SELECT pr_reconciled_base FROM reviews WHERE id=? AND pr_reconciled_head=?").get(id, head);
  if (!comparison?.pr_reconciled_base || base !== comparison.pr_reconciled_base) return;
  return { base: comparison.pr_reconciled_base,
    units: db.query<LogicalHunk, [string, string]>("SELECT * FROM logical_hunks WHERE review_id=? AND pr_head=?").all(id, head).map(hunkIdentity) };
}

/** Standalone inline comments create GitHub reviews too; only explicit submissions count. */
export function latestSubmittedReview(db: Database, scope: string, viewer: string): SubmittedReview | null {
  return db.query<SubmittedReview, [string, string]>(`SELECT id,github_id,commit_sha,comparison_base_sha,submitted_at FROM pr_reviews
    WHERE pr_id=? AND login=? COLLATE NOCASE AND remote_deleted_at IS NULL
      AND state IN ('APPROVED','CHANGES_REQUESTED','COMMENTED','DISMISSED')
      AND (state!='COMMENTED' OR has_body=1 OR comparison_base_sha IS NOT NULL)
    ORDER BY submitted_at DESC,github_id DESC LIMIT 1`).get(scope, viewer);
}

/** A newer external submission must not relabel membership from an older review. */
export function invalidateSinceReview(db: Database, scope: string, viewer: string): void {
  const latest = latestSubmittedReview(db, scope, viewer);
  if (!latest?.comparison_base_sha || !latest.commit_sha) {
    db.query("UPDATE logical_hunks SET since_review=NULL WHERE review_id=?").run(findReview(db, scope)?.id ?? "");
  }
}

/** Read membership only for the authenticated reader and the current complete comparison. */
export function readSinceReview(db: Database, scope: string, viewer: string): SinceReview {
  invalidateSinceReview(db, scope, viewer);
  const latest = latestSubmittedReview(db, scope, viewer);
  const id = findReview(db, scope)?.id ?? "";
  const current = db.query<{ pr_reconciled_head: string | null; pr_reconciled_base: string | null }, [string]>(
    "SELECT pr_reconciled_head,pr_reconciled_base FROM reviews WHERE id=?").get(id);
  const review = latest?.comparison_base_sha && latest.commit_sha
    ? { id: latest.github_id, head: latest.commit_sha, base: latest.comparison_base_sha, submittedAt: latest.submitted_at } : undefined;
  return { review, head: current?.pr_reconciled_head ?? null, base: current?.pr_reconciled_base ?? null,
    hunks: review ? db.query<LogicalHunk, [string]>("SELECT * FROM logical_hunks WHERE review_id=? AND since_review IS NOT NULL ORDER BY rowid").all(id)
      .map((row) => ({ ...hunkIdentity(row), sinceReview: row.since_review!, present: row.pr_head !== null && row.pr_head === current?.pr_reconciled_head })) : [] };
}

/**
 * Reset membership from the submitted inventory, never from a later reconciliation.
 *
 * A push can finish while GitHub accepts the review. Its current-only hunks stay new.
 * The receipt and reset share a transaction at the caller; retries cannot reset twice.
 */
export function recordSinceReview(db: Database, scope: string, viewer: string, githubId: number, head: string, base: string, units: ChangeIdentity[]): void {
  const row = db.query<SubmittedReview, [string, number]>("SELECT * FROM pr_reviews WHERE pr_id=? AND github_id=?").get(scope, githubId);
  if (!row || row.comparison_base_sha || row.commit_sha !== head) return;
  db.query("UPDATE pr_reviews SET comparison_base_sha=? WHERE id=?").run(base, row.id);
  if (latestSubmittedReview(db, scope, viewer)?.id !== row.id) return;
  const id = findReview(db, scope)?.id ?? "";
  db.query("UPDATE logical_hunks SET since_review=CASE WHEN pr_head IS NOT NULL THEN 'new' ELSE NULL END WHERE review_id=?").run(id);
  for (const unit of units) db.query("UPDATE logical_hunks SET since_review='existing' WHERE id=?").run(logicalHunk(db, id, unit));
}
