import type { Database } from "bun:sqlite";
import type { Storage } from "./storage";
import type { ViewedFiles } from "../shared/types";
import { findReview } from "./reviewStore";
import { needsPrComparison } from "./logicalHunks";
import { currentReconciliation, type HunkReconciliation } from "./reconciliation";
export interface ViewedSync {
  head: string;
  base: string | null;
  ready: boolean;
  files: { path: string; githubViewed: boolean; desired: boolean; error?: string }[];
}

/** Derive completion from current canonical units; the file row stores only remote receipts. */
export function readViewedSync(db: Database, review: string, path?: string): ViewedSync | undefined {
  const row = db.query<{ viewed_sync_head: string | null; viewed_sync_base: string | null; pr_reconciled_head: string | null; pr_reconciled_base: string | null }, [string]>(
    "SELECT viewed_sync_head,viewed_sync_base,pr_reconciled_head,pr_reconciled_base FROM reviews WHERE id=?").get(review);
  if (!row?.viewed_sync_head) return;
  const files = db.query<{ path: string; github_viewed: number; sync_error: string | null; desired: number }, string[]>(`SELECT f.path,f.github_viewed,f.sync_error,
    NOT EXISTS (SELECT 1 FROM logical_hunks h WHERE h.review_id=f.review_id AND h.path=f.path AND h.pr_head=?
      AND h.pr_reviewable=1 AND h.reviewed_at IS NULL) AS desired
    FROM review_files f WHERE f.review_id=? ${path === undefined ? "" : "AND f.path=?"} ORDER BY f.id`).all(row.viewed_sync_head, review, ...(path === undefined ? [] : [path]));
  return { head: row.viewed_sync_head, base: row.viewed_sync_base,
    ready: row.viewed_sync_base !== null && row.pr_reconciled_head === row.viewed_sync_head && row.pr_reconciled_base === row.viewed_sync_base,
    files: files.map((file) => ({ path: file.path, githubViewed: Boolean(file.github_viewed), desired: Boolean(file.desired), ...(file.sync_error ? { error: file.sync_error } : {}) })) };
}

/** Move the PR's authoritative file receipts before deleting its retired review identity. */
export function mergeViewedSync(db: Database, from: string, to: string): void {
  const source = db.query<{ viewed_sync_head: string | null; viewed_sync_base: string | null }, [string]>("SELECT viewed_sync_head,viewed_sync_base FROM reviews WHERE id=?").get(from);
  if (!source?.viewed_sync_head) return;
  db.query("DELETE FROM review_files WHERE review_id=?").run(to);
  db.query("UPDATE review_files SET review_id=? WHERE review_id=?").run(to, from);
  db.query("UPDATE reviews SET viewed_sync_head=?,viewed_sync_base=? WHERE id=?").run(source.viewed_sync_head, source.viewed_sync_base, to);
}

/** File completion is derived from canonical approvals, never separately persisted intent. */
export function viewedSync(storage: Storage, scope: string, path?: string): ViewedSync | undefined {
  return readViewedSync(storage.db, findReview(storage.db, scope)?.id ?? "", path);
}

/** Resume registered PRs without requiring a browser to reopen them. */
export function viewedSyncScopes(storage: Storage): string[] {
  return storage.db.query<{ pr: string }, []>("SELECT pr FROM reviews WHERE viewed_sync_head IS NOT NULL AND pr IS NOT NULL").all().map((row) => row.pr);
}

/**
 * Observe GitHub's flags against an already reconciled comparison.
 *
 * A user action during the fetch invalidates its token. Import only once per head so an old remote
 * Viewed flag cannot overwrite newer local intent during retries or classification upgrades.
 */
export function observeGitHubViewed(storage: Storage, scope: string, head: string, base: string, remote: ViewedFiles,
  token: HunkReconciliation, importRemote: boolean): Promise<boolean> {
  return storage.serialize("review", async () => storage.db.transaction(() => {
    const db = storage.db;
    const review = findReview(db, scope)?.id;
    if (!review) return false;
    if (!currentReconciliation(storage, review, "pr", token) || needsPrComparison(storage, scope, head, base)) {
      deferViewedSync(storage, scope, head);
      return false;
    }
    const previous = viewedSync(storage, scope);
    for (const [path, state] of Object.entries(remote.files)) {
      const githubViewed = state === "VIEWED";
      db.query(`INSERT INTO review_files (review_id,path,github_viewed) VALUES (?,?,?)
        ON CONFLICT(review_id,path) DO UPDATE SET github_viewed=excluded.github_viewed,sync_error=NULL`).run(review, path, Number(githubViewed));
      if (importRemote && previous?.head !== head && githubViewed) {
        db.query(`UPDATE logical_hunks SET reviewed_head=?,reviewed_at=?
          WHERE review_id=? AND path=? AND pr_head=? AND pr_reviewable=1 AND reviewed_at IS NULL`).run(head, new Date().toISOString(), review, path, head);
      }
    }
    const paths = new Set(Object.keys(remote.files));
    for (const row of db.query<{ id: number; path: string }, [string]>("SELECT id,path FROM review_files WHERE review_id=?").all(review)) {
      if (!paths.has(row.path)) db.query("DELETE FROM review_files WHERE id=?").run(row.id);
    }
    db.query("UPDATE reviews SET pr=?,viewed_sync_head=?,viewed_sync_base=? WHERE id=?").run(scope, head, base, review);
    return true;
  })());
}

/** Interrupted initial observations remain retryable without importing stale remote flags. */
export function deferViewedSync(storage: Storage, scope: string, head: string): void {
  storage.db.query("UPDATE reviews SET viewed_sync_head=COALESCE(viewed_sync_head,?),viewed_sync_base=NULL WHERE id=?").run(head, findReview(storage.db, scope)?.id ?? "");
}

/** Save GitHub's confirmed flag only for the comparison that was sent. */
export function saveGitHubViewed(storage: Storage, scope: string, head: string, base: string | null, path: string, githubViewed: boolean | undefined, error?: string): void {
  storage.db.query(`UPDATE review_files SET github_viewed=COALESCE(?,github_viewed),sync_error=?
    WHERE review_id=? AND path=? AND EXISTS (SELECT 1 FROM reviews WHERE id=review_files.review_id AND viewed_sync_head=? AND viewed_sync_base IS ?)`)
    .run(githubViewed === undefined ? null : Number(githubViewed), error ?? null, findReview(storage.db, scope)?.id ?? "", path, head, base);
}

/** Failed remote reads retain local approvals and the last confirmed GitHub flags. */
export function failViewedSync(storage: Storage, scope: string, error: string): void {
  storage.db.query("UPDATE review_files SET sync_error=? WHERE review_id=?").run(error, findReview(storage.db, scope)?.id ?? "");
}

/** A write racing a push must not import its accidental Viewed flag at the new head. */
export function invalidateViewedSync(storage: Storage, scope: string, previous: ViewedSync, head: string): void {
  storage.db.query("UPDATE reviews SET viewed_sync_head=?,viewed_sync_base=NULL WHERE id=? AND viewed_sync_head=? AND viewed_sync_base IS ?")
    .run(head, findReview(storage.db, scope)?.id ?? "", previous.head, previous.base);
  failViewedSync(storage, scope, "PR changed while synchronizing Viewed flags; retrying on the next refresh");
}
