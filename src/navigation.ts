import type { FileDiffMetadata } from "@pierre/diffs";

export interface HunkPosition {
  fileIndex: number;
  hunkIndex: number;
  lineIndex?: number;
}

/** Move through change blocks across files, stopping at the ends of the review. */
export function nextHunk(files: FileDiffMetadata[], current: HunkPosition, direction: 1 | -1): HunkPosition {
  const hunkIndex = current.hunkIndex + direction;
  if (hunkIndex >= 0 && hunkIndex < changeStarts(files[current.fileIndex]).length) {
    return { fileIndex: current.fileIndex, hunkIndex };
  }

  // Binary or mode-only changes have no text hunks; they remain in the file picker.
  for (let fileIndex = current.fileIndex + direction; fileIndex >= 0 && fileIndex < files.length; fileIndex += direction) {
    const count = changeStarts(files[fileIndex]).length;
    if (count > 0) return { fileIndex, hunkIndex: direction === 1 ? 0 : count - 1 };
  }
  return current;
}

/**
 * Locate each change block's first new line, or first deletion for removal-only blocks.
 *
 * Git can put several edits inside one @@ hunk. Context separates navigation stops.
 * Set preferAdditions to false when locating which block contains a deleted row.
 * I.e. two deletions followed by an addition at unified row 8 focuses row 10.
 */
export function changeStarts(file: FileDiffMetadata, preferAdditions = true): number[] {
  const starts: number[] = [];
  for (const hunk of file.hunks) {
    let line = hunk.unifiedLineStart;
    for (const content of hunk.hunkContent) {
      if (content.type === "context") {
        line += content.lines;
      } else {
        starts.push(line + (preferAdditions && content.additions > 0 ? content.deletions : 0));
        line += content.deletions + content.additions;
      }
    }
  }
  return starts;
}
