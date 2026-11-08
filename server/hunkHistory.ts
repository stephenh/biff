import type { Database } from "bun:sqlite";
import { parsePatchFiles } from "@pierre/diffs";
import { identifyChanges, identifyMetadata } from "../shared/changeProgress";
import { captureHunkTexts, hunkLineCounts, type HunkText } from "../shared/hunkText";
import type { HunkComparison, HunkHistory, HunkObservation, SeenHunks } from "../shared/hunkHistory";
import { matchesChange, type ChangeIdentity } from "../shared/progress";
import { splitSemanticChanges } from "../shared/semanticChanges";
import { findReview } from "./reviewStore";
import { hunkIdentity, type LogicalHunk } from "./logicalHunks";
import type { Storage } from "./storage";

type SeenHunkRow = Pick<LogicalHunk, "id" | "path" | "hash" | "old_line" | "new_line" | "duplicate" | "kind" | "seen_at">;
type ObservedHunkRow = SeenHunkRow & Pick<LogicalHunk, "diff_text"> & { observed_old: number; observed_new: number };

/** Presence belongs to the displayed comparison, not whichever linked source refreshed last. */
export function readSeenHunks(db: Database, scope: string, comparison: HunkComparison): SeenHunks {
  const review = findReview(db, scope)?.id ?? "";
  // Summary polling must not load every retained hunk body in a large review.
  const rows = db.query<SeenHunkRow & { present: number }, [string, string, string]>(`SELECT h.id,h.path,h.hash,h.old_line,h.new_line,h.duplicate,h.kind,h.seen_at,
    EXISTS (SELECT 1 FROM logical_hunk_observations o WHERE o.logical_hunk_id=h.id
      AND o.comparison_head_sha=? AND o.comparison_base_sha=?) AS present
    FROM logical_hunks h WHERE h.review_id=? AND h.seen_at IS NOT NULL ORDER BY h.rowid`)
    .all(comparison.head, comparison.base, review);
  return { ...comparison, hunks: rows.map((row) => ({ ...hunkIdentity(row), seenAt: row.seen_at!, present: Boolean(row.present) })) };
}

/** Admit delayed focus saves only for identities in a server-observed comparison. */
export function seeHunk(storage: Storage, scope: string, identity: ChangeIdentity, comparison: HunkComparison): Promise<{ seenAt: string }> {
  return storage.serialize("review", async () => storage.db.transaction(() => {
    const db = storage.db;
    const rows = db.query<ObservedHunkRow, [string, string, string, string, string]>(`SELECT h.id,h.path,h.hash,h.old_line,h.new_line,h.duplicate,h.kind,h.seen_at,h.diff_text,o.old_line AS observed_old,o.new_line AS observed_new
      FROM logical_hunks h JOIN logical_hunk_observations o ON o.logical_hunk_id=h.id
      WHERE h.review_id=? AND h.path=? AND h.hash=? AND o.comparison_head_sha=? AND o.comparison_base_sha=?`)
      .all(findReview(db, scope)?.id ?? "", identity.path, identity.hash, comparison.head, comparison.base);
    const row = rows.find((row) => matchesHunkObservation(row, identity));
    if (!row) throw new Error("This hunk is not in the captured comparison. Refresh the review and try again.");
    const seenAt = row.seen_at ?? new Date().toISOString();
    db.query("UPDATE logical_hunks SET seen_at=? WHERE id=?").run(seenAt, row.id);
    return { seenAt };
  })());
}

/** Missing legacy text can be filled from an already-fetched comparison without invalidating progress. */
export function needsHunkHistory(db: Database, scope: string, head: string, base: string): boolean {
  return Boolean(db.query(`SELECT h.id FROM logical_hunks h WHERE h.review_id=? AND h.pr_head=?
    AND (h.diff_text IS NULL OR NOT EXISTS (SELECT 1 FROM logical_hunk_observations o WHERE o.logical_hunk_id=h.id AND o.comparison_head_sha=? AND o.comparison_base_sha=?)) LIMIT 1`)
    .get(findReview(db, scope)?.id ?? "", head, head, base));
}

/** Store content once and retain each comparison's position without rewriting earlier observations. */
export function observeHunk(db: Database, id: string, head: string, base: string, text: HunkText, observedAt: string | null): void {
  db.query("UPDATE logical_hunks SET diff_text=COALESCE(diff_text,?) WHERE id=?").run(text.diffText, id);
  db.query(`INSERT INTO logical_hunk_observations (logical_hunk_id,comparison_head_sha,comparison_base_sha,observed_at,old_line,new_line)
    VALUES (?,?,?,?,?,?) ON CONFLICT(logical_hunk_id,comparison_head_sha,comparison_base_sha) DO NOTHING`)
    .run(id, head, base, observedAt, text.oldLine, text.newLine);
}

/** Historical reads use the path index; other files' bodies are not loaded into the pane. */
export function readHunkHistory(db: Database, scope: string, path: string, comparison?: HunkComparison): HunkHistory {
  const review = findReview(db, scope)?.id ?? "";
  // Coordinates group nearby edits for browsing; they never establish hunk ancestry.
  const absent = comparison ? `NOT EXISTS (SELECT 1 FROM logical_hunk_observations current WHERE current.logical_hunk_id=h.id
    AND current.comparison_head_sha=? AND current.comparison_base_sha=?)` : "h.pr_head IS NULL";
  const parameters = [review, path, ...(comparison ? [comparison.head, comparison.base] : [])];
  const observations = db.query<HunkObservation, string[]>(`SELECT o.id,h.id AS hunkId,h.path,h.kind,h.diff_text AS diffText,
    o.comparison_head_sha AS head,o.comparison_base_sha AS base,o.observed_at AS observedAt,o.old_line AS oldLine,o.new_line AS newLine
    FROM logical_hunks h JOIN logical_hunk_observations o ON o.logical_hunk_id=h.id
    WHERE h.review_id=? AND h.path=? AND h.seen_at IS NOT NULL AND ${absent} AND h.diff_text IS NOT NULL ORDER BY o.observed_at,o.id`).all(...parameters);
  const missing = db.query<{ count: number }, string[]>(`SELECT count(*) AS count FROM logical_hunks h
    WHERE h.review_id=? AND h.path=? AND h.seen_at IS NOT NULL AND ${absent}
      AND (h.diff_text IS NULL OR NOT EXISTS (SELECT 1 FROM logical_hunk_observations o WHERE o.logical_hunk_id=h.id))`).get(...parameters)!.count;
  return { observations, missing };
}

/**
 * Recover text from a known comparison without treating backfill time as appearance time.
 *
 * A submitted review supplies historical observation evidence. Rows not in that
 * exact patch are left alone; neither flags nor current source presence advance.
 */
export async function backfillHunkHistory(db: Database, scope: string, patch: string, head: string, base: string, submittedAt: string | null): Promise<void> {
  const files = splitSemanticChanges(parsePatchFiles(patch, undefined, true).flatMap((entry) => entry.files));
  const blocks = await identifyChanges(files);
  const metadata = await identifyMetadata(files, head);
  const texts = captureHunkTexts(files, blocks, metadata);
  db.transaction(() => {
    const review = findReview(db, scope)?.id ?? "";
    for (const [unit, text] of texts) {
      const candidates = db.query<LogicalHunk, [string, string, string]>("SELECT * FROM logical_hunks WHERE review_id=? AND path=? AND hash=?").all(review, unit.path, unit.hash);
      const row = candidates.find((candidate) => matchesChange(hunkIdentity(candidate), unit));
      if (row) observeHunk(db, row.id, head, base, text, submittedAt);
    }
  })();
}

/** Match duplicate occurrences by changed source lines, not the empty side's patch insertion point. */
function matchesHunkObservation(row: ObservedHunkRow, identity: ChangeIdentity): boolean {
  const observed = { ...hunkIdentity(row), oldLine: row.observed_old, newLine: row.observed_new };
  const counts = hunkLineCounts(row.diff_text ?? "");

  // A zero-length patch range points before the edit, whereas the identity points
  // at the next source line. Only the side containing changed lines identifies
  // the occurrence. I.e. +text at new line 92 can have @@ -90,0 +92,1 @@.
  if (counts.old === 0 && counts.new > 0) observed.oldLine = identity.oldLine;
  if (counts.new === 0 && counts.old > 0) observed.newLine = identity.newLine;
  return matchesChange(observed, identity);
}
