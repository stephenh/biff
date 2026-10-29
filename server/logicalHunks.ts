import type { Database } from "bun:sqlite";
import { matchesChange, type ChangeIdentity, type ReviewedChange } from "../shared/progress";
import type { Storage } from "./storage";
import { ensureReview, findReview } from "./reviewStore";
import { beginReconciliation, currentReconciliation, invalidateReconciliations, type HunkReconciliation } from "./reconciliation";
import { parsePatchFiles } from "@pierre/diffs";
import { identifyChanges, identifyMetadata } from "../shared/changeProgress";
import { splitSemanticChanges } from "../shared/semanticChanges";
import { recordReviewableChanges } from "./reviewChanges";

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
  db.query("INSERT INTO logical_hunks (id,review_id,path,hash,old_line,new_line,duplicate,kind) VALUES (?,?,?,?,?,?,?,?)")
    .run(id, review, change.path, change.hash, change.oldLine, change.newLine, Number(change.duplicate), change.kind ?? "");
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

/** Count only a complete, classified PR comparison that still matches GitHub's head and base. */
export function prHunkProgress(db: Database, scope: string, head: string, base: string): { reviewed: number; total: number } | undefined {
  const review = findReview(db, scope)?.id;
  if (!review) return;

  // Old approvals and local-only units remain durable, but must not inflate this PR's progress.
  return db.query<{ reviewed: number; total: number }, [string, string, string]>(`SELECT
    count(h.id) AS total, count(h.reviewed_at) AS reviewed
    FROM reviews r LEFT JOIN logical_hunks h ON h.review_id=r.id AND h.pr_head=r.pr_reconciled_head AND h.pr_reviewable=1
    WHERE r.id=? AND r.pr_reconciled_head=? AND r.pr_reconciled_base=? GROUP BY r.id`).get(review, head, base) ?? undefined;
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

/** Read approvals through local/PR aliases after previously admitted writes. */
export function hunkApprovals(storage: Storage, scope: string): Promise<ReviewedChange[]> {
  return storage.serialize("review", async () => reviewedHunks(storage.db, findReview(storage.db, scope)?.id ?? ""));
}

/** A whole-file action changes its constituent units, never a separate file approval. */
export function updateHunkApproval(storage: Storage, scope: string, identity: ChangeIdentity, reviewed: boolean, head: string, blocks: ChangeIdentity[] = []): Promise<ReviewedChange[]> {
  return updateHunkApprovals(storage, scope, (identity.kind === "file" ? blocks : [identity]).map((entry) => ({ identity: entry, reviewed })), head);
}

/** Commit a batch atomically and invalidate remote imports captured before this user action. */
export function updateHunkApprovals(storage: Storage, scope: string, changes: { identity: ChangeIdentity; reviewed: boolean }[], head: string): Promise<ReviewedChange[]> {
  return storage.serialize("review", async () => storage.db.transaction(() => {
    const id = ensureReview(storage.db, scope).id;
    for (const change of changes) {
      if (change.identity.kind === "file") throw new Error("Expected a hunk or metadata unit");
      reviewHunk(storage.db, id, change.identity, head, change.reviewed ? new Date().toISOString() : null);
    }
    invalidateReconciliations(storage, id);
    return reviewedHunks(storage.db, id);
  })());
}

/** Capture the shared generation before fetching comparison evidence. */
export function beginHunkReconciliation(storage: Storage, scope: string, source: "local" | "pr"): HunkReconciliation {
  return beginReconciliation(storage, findReview(storage.db, scope)?.id ?? "", source);
}

/** Only complete comparisons can establish source presence and clear disconnected flags. */
export async function reconcileFollowUps(storage: Storage, scope: string, patch: string, head: string, source: "pr" | "local", token = beginHunkReconciliation(storage, scope, source)): Promise<void> {
  const files = patch.trim() ? parsePatchFiles(patch, undefined, true).flatMap((entry) => entry.files) : [];
  if (patch.trim() && !files.length) throw new Error("Could not identify follow-up hunks from this diff");
  const semantic = splitSemanticChanges(files);
  const units = [...await identifyChanges(semantic), ...await identifyMetadata(semantic, head)];
  await reconcileHunks(storage, scope, units, head, source, token);
}

/**
 * Advance one source without erasing presence in the other source.
 *
 * Generations reject stale fetches and same-head flag reversals. Durable comparison heads resume
 * reconciliation after restart, when no in-flight network requests can survive.
 */
export function reconcileHunks(storage: Storage, scope: string, blocks: (ChangeIdentity & { reviewable?: boolean })[], head: string,
  source: "local" | "pr", token: HunkReconciliation, base?: string): Promise<boolean> {
  return storage.serialize("review", async () => storage.db.transaction(() => {
    const db = storage.db;
    const review = findReview(db, scope)?.id ?? "";
    if (!currentReconciliation(storage, review, source, token)) return false;
    const column = source === "local" ? "local_head" : "pr_head";
    const previous = db.query<{ pr_reconciled_head: string | null; pr_reconciled_base: string | null; closed: number }, [string]>("SELECT pr_reconciled_head,pr_reconciled_base,closed FROM reviews WHERE id=?").get(review);
    const previousUnits = new Set(db.query<{ id: string }, [string, string | null]>("SELECT id FROM logical_hunks WHERE review_id=? AND pr_head=? AND pr_reviewable=1").all(review, previous?.pr_reconciled_head ?? null).map((row) => row.id));
    // Completion must include units nobody has interacted with yet.
    const present = new Set<string>();
    let newReviewableChanges = false;
    for (const block of blocks) {
      const id = logicalHunk(db, review, block);
      present.add(id);
      if (block.reviewable && !previousUnits.has(id)) newReviewableChanges = true;
      if (source === "pr" && block.reviewable !== undefined) db.query("UPDATE logical_hunks SET pr_reviewable=? WHERE id=?").run(Number(block.reviewable), id);
    }
    for (const row of db.query<LogicalHunk, [string]>("SELECT * FROM logical_hunks WHERE review_id=?").all(review)) {
      db.query(`UPDATE logical_hunks SET ${column}=? WHERE id=?`).run(present.has(row.id) ? head : null, row.id);
    }
    db.query("UPDATE logical_hunks SET follow_up=0 WHERE review_id=? AND local_head IS NULL AND pr_head IS NULL").run(review);
    const cursor = source === "local" ? "local_reconciled_head" : "pr_reconciled_head";
    db.query(`UPDATE reviews SET ${cursor}=? WHERE id=?`).run(head, review);
    if (source === "pr") db.query("UPDATE reviews SET pr_reconciled_base=? WHERE id=?").run(base ?? null, review);
    // Only complete, classified PR comparisons can create attention. A first inventory is not a change.
    if (source === "pr" && base && previous?.pr_reconciled_base && !previous.closed && newReviewableChanges) {
      recordReviewableChanges(db, findReview(db, scope)?.pr ?? scope);
    }
    return true;
  })());
}

/** Classification covers both sides of the complete PR comparison. */
export function needsPrComparison(storage: Storage, scope: string, head: string, base: string): boolean {
  return !storage.db.query("SELECT id FROM reviews WHERE id=? AND pr_reconciled_head=? AND pr_reconciled_base=?").get(findReview(storage.db, scope)?.id ?? "", head, base);
}

/** Background follow-up refreshes need a diff only when the flagged PR head changed. */
export function needsFollowUpDiff(storage: Storage, scope: string, head: string): boolean {
  return Boolean(storage.db.query(`SELECT id FROM reviews WHERE id=? AND pr_reconciled_head IS NOT ?
    AND EXISTS (SELECT 1 FROM logical_hunks WHERE review_id=reviews.id AND follow_up=1)`).get(findReview(storage.db, scope)?.id ?? "", head));
}

/** A source cursor covers every unit, including unapproved and unflagged hunks. */
export function needsHunkReconciliation(storage: Storage, scope: string, source: "local" | "pr", head: string): boolean {
  const column = source === "local" ? "local_reconciled_head" : "pr_reconciled_head";
  return Boolean(storage.db.query(`SELECT id FROM reviews WHERE id=? AND ${column} IS NOT ?`).get(findReview(storage.db, scope)?.id ?? "", head));
}
