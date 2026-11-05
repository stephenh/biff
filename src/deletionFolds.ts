import type { FileDiffMetadata, FileDiffOptions } from "@pierre/diffs";
import type { ReviewLine } from "../shared/types";

export type FoldedRange = ReturnType<NonNullable<FileDiffOptions<undefined, undefined>["resolveFoldedRanges"]>>[number];
export interface DeletionFold extends FoldedRange { oldLine: number; newLine: number }

/**
 * Fold only replacement deletions, subtracting import ranges so their controls stay independent.
 *
 * Use complete metadata, not mounted rows. I.e. a 105-line deletion occupies one
 * projected strip even when its replacement is in a different virtual window.
 */
export function deletionFolds(file: FileDiffMetadata, imports: readonly { start: number; end: number }[]): DeletionFold[] {
  const folds: DeletionFold[] = [];
  for (const hunk of file.hunks) {
    let index = hunk.unifiedLineStart;
    let oldLine = hunk.deletionStart;
    let newLine = hunk.additionStart;
    for (const content of hunk.hunkContent) {
      if (content.type === "context") {
        index += content.lines; oldLine += content.lines; newLine += content.lines;
        continue;
      }

      if (content.deletions && content.additions) {
        let start = index;
        const end = index + content.deletions - 1;
        for (const range of imports) {
          if (range.end < start) continue;
          if (range.start > end) break;
          if (range.start > start) folds.push(createFold(start, range.start - 1, oldLine + start - index, newLine));
          start = Math.max(start, range.end + 1);
        }
        if (start <= end) folds.push(createFold(start, end, oldLine + start - index, newLine));
      }

      index += content.deletions + content.additions;
      oldLine += content.deletions;
      newLine += content.additions;
    }
  }
  return folds;
}

/**
 * Resolve nearby groups from source coordinates, including blocks outside the mounted window.
 *
 * Keep old-side selection readable even after its hover or temporary peek ends.
 */
export function revealedDeletions(folds: DeletionFold[], near?: ReviewLine, reveal?: ReviewLine): Set<string> {
  const result = new Set<string>();
  if (near) {
    const before = folds.filter((fold) => near.side === "LEFT" ? fold.oldLine + fold.end - fold.start < near.line : fold.newLine <= near.line);
    const after = folds.filter((fold) => near.side === "LEFT" ? fold.oldLine > near.line : fold.newLine > near.line);
    for (const fold of [...before.slice(-3), ...after.slice(0, 3)]) result.add(fold.id);
    if (near.side === "LEFT") for (const fold of folds) {
      if (fold.oldLine <= near.line && fold.oldLine + fold.end - fold.start >= near.line) result.add(fold.id);
    }
  }

  if (reveal?.side === "LEFT") for (const fold of folds) {
    if (fold.oldLine <= reveal.line && fold.oldLine + fold.end - fold.start >= reveal.line) result.add(fold.id);
  }
  return result;
}

/** Old-side source identity survives hydration changing unified row indexes. */
function createFold(start: number, end: number, oldLine: number, newLine: number): DeletionFold {
  const count = end - start + 1;
  return { id: `deletion:${oldLine}`, start, end, oldLine, newLine, label: `${count} deleted ${count === 1 ? "line" : "lines"}`, expanded: false, kind: "deletion" };
}
