import type { Database } from "bun:sqlite";
import type { Storage } from "./storage";
import type { PullRequestStatus } from "../shared/types";
import { findReview } from "./reviewStore";

interface Attention { new_changes: number; changes_version: number; last_review_id: number | null }
export interface ReviewChangesReceipt { head: string; version: number }

/** Register the authenticated reader without inheriting another account's review attention. */
export function registerReviewChanges(db: Database, scope: string, viewer: string): void {
  db.query(`INSERT INTO pr_user_state (id,changes_viewer) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET
    new_changes=CASE WHEN changes_viewer=? COLLATE NOCASE THEN new_changes ELSE 0 END,
    last_review_id=CASE WHEN changes_viewer=? COLLATE NOCASE THEN last_review_id ELSE NULL END,
    changes_viewer=excluded.changes_viewer`).run(scope, viewer, viewer, viewer);
}

/** Project the durable boolean and the previous review's context onto all PR surfaces. */
export function reviewChangesStatus(db: Database, scope: string, viewer: string): Partial<PullRequestStatus> {
  const row = db.query<Attention & { state: string | null }, [string, string]>(`SELECT s.new_changes,s.changes_version,s.last_review_id,r.state
    FROM pr_user_state s LEFT JOIN pr_reviews r ON r.id=s.last_review_id WHERE s.id=? AND s.changes_viewer=? COLLATE NOCASE`).get(scope, viewer);
  if (!row) return {};
  if (!row.new_changes && row.changes_version === 0) return {};
  return { viewerNewChanges: Boolean(row.new_changes), newChangesVersion: row.changes_version, previousReviewState: row.state ?? undefined };
}

/** Imported completed reviews need one quiet inventory before future changes can be detected. */
export function needsReviewChangesBaseline(db: Database, scope: string): boolean {
  return Boolean(db.query(`SELECT s.id FROM pr_user_state s JOIN reviews r ON r.id=?
    WHERE s.id=? AND s.last_review_id IS NOT NULL AND r.pr_reconciled_base IS NULL`).get(findReview(db, scope)?.id ?? "", scope));
}

/**
 * Observe each submitted review once; an old receipt must never clear a newer push.
 *
 * Head identity protects older commits; the admission version also protects base changes at the same head.
 */
export function observeReviewChanges(db: Database, scope: string, viewer: string, receipt?: ReviewChangesReceipt, submittedReview?: number): void {
  const attention = db.query<Attention, [string, string]>("SELECT * FROM pr_user_state WHERE id=? AND changes_viewer=? COLLATE NOCASE").get(scope, viewer);
  if (!attention) return;
  // GitHub also creates empty COMMENTED reviews for standalone inline comments. Only a summary,
  // an explicit Biff submission, or its retained receipt proves a completed comment-only review.
  const latest = db.query<{ id: number; github_id: number; commit_sha: string | null }, [string, string, number | null, number | null]>(`SELECT id,github_id,commit_sha FROM pr_reviews
    WHERE pr_id=? AND login=? COLLATE NOCASE AND state IN ('APPROVED','CHANGES_REQUESTED','COMMENTED','DISMISSED') AND remote_deleted_at IS NULL
      AND (state!='COMMENTED' OR has_body=1 OR github_id=? OR id=?)
    ORDER BY github_id DESC LIMIT 1`).get(scope, viewer, submittedReview ?? null, attention.last_review_id);
  if (!latest || latest.id === attention.last_review_id) return;
  const previous = attention.last_review_id === null ? undefined : db.query<{ github_id: number }, [number]>("SELECT github_id FROM pr_reviews WHERE id=?").get(attention.last_review_id);
  if (previous && previous.github_id >= latest.github_id) return;

  const comparison = db.query<{ pr_reconciled_head: string | null }, [string]>("SELECT pr_reconciled_head FROM reviews WHERE id=?").get(findReview(db, scope)?.id ?? "");
  const head = receipt?.head ?? latest.commit_sha;
  const covered = Boolean(head && head === comparison?.pr_reconciled_head && (!receipt || receipt.version === attention.changes_version));
  db.query("UPDATE pr_user_state SET last_review_id=?,new_changes=CASE WHEN ? THEN 0 ELSE new_changes END WHERE id=?")
    .run(latest.id, Number(covered), scope);
}

/** Record a classified comparison delta atomically with canonical hunk presence. */
export function recordReviewableChanges(db: Database, scope: string): void {
  // A checked box is not a submitted review. Unreviewed PRs keep their ordinary request status.
  db.query(`UPDATE pr_user_state SET new_changes=1,changes_version=changes_version+1,
    snooze_until=CASE WHEN archived=0 THEN 0 ELSE snooze_until END
    WHERE id=? AND last_review_id IS NOT NULL`).run(scope);
}

/** Acknowledge only the displayed version; retries are harmless until another change is discovered. */
export function acknowledgeReviewChanges(storage: Storage, scope: string, viewer: string, receipt: ReviewChangesReceipt): Promise<void> {
  return storage.serialize("review", async () => storage.db.transaction(() => {
    const status = reviewChangesStatus(storage.db, scope, viewer);
    const comparison = storage.db.query<{ pr_reconciled_head: string | null }, [string]>("SELECT pr_reconciled_head FROM reviews WHERE id=?").get(findReview(storage.db, scope)?.id ?? "");
    if (status.newChangesVersion !== receipt.version || comparison?.pr_reconciled_head !== receipt.head) {
      throw new Error("The PR changed. Refresh it before marking its changes reviewed.");
    }
    storage.db.query("UPDATE pr_user_state SET new_changes=0 WHERE id=?").run(scope);
  })());
}
