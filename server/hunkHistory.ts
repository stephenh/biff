import type { Database } from "bun:sqlite";
import { parsePatchFiles } from "@pierre/diffs";
import { identifyChanges, identifyMetadata } from "../shared/changeProgress";
import { captureHunkTexts, type HunkText } from "../shared/hunkText";
import type { HunkHistory, HunkObservation } from "../shared/hunkHistory";
import { matchesChange } from "../shared/progress";
import { splitSemanticChanges } from "../shared/semanticChanges";
import { findReview } from "./reviewStore";
import { hunkIdentity, type LogicalHunk } from "./logicalHunks";

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
export function readHunkHistory(db: Database, scope: string, path: string): HunkHistory {
  const review = findReview(db, scope)?.id ?? "";
  const observations = db.query<HunkObservation, [string, string]>(`SELECT o.id,h.id AS hunkId,h.path,h.kind,h.diff_text AS diffText,
    o.comparison_head_sha AS head,o.comparison_base_sha AS base,o.observed_at AS observedAt,o.old_line AS oldLine,o.new_line AS newLine
    FROM logical_hunks h JOIN logical_hunk_observations o ON o.logical_hunk_id=h.id
    WHERE h.review_id=? AND h.path=? AND h.pr_head IS NULL AND h.diff_text IS NOT NULL ORDER BY o.observed_at,o.id`).all(review, path);
  const missing = db.query<{ count: number }, [string, string]>(`SELECT count(*) AS count FROM logical_hunks h
    WHERE h.review_id=? AND h.path=? AND h.since_review='existing' AND h.pr_head IS NULL
      AND (h.diff_text IS NULL OR NOT EXISTS (SELECT 1 FROM logical_hunk_observations o WHERE o.logical_hunk_id=h.id))`).get(review, path)!.count;
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
