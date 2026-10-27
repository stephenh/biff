import type { Database } from "bun:sqlite";
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
