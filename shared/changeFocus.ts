import type { ChangeContent, FileDiffMetadata } from "@pierre/diffs";

/** Prefer non-blank additions, or deletions when no additions are visible; keep blank-only edits reachable. */
export function firstChangeLine(file: FileDiffMetadata, content: ChangeContent, start: number, visible?: (index: number) => boolean): number | undefined {
  const ranges = [
    { start: start + content.deletions, count: content.additions, lines: file.additionLines, source: content.additionLineIndex },
    { start, count: content.deletions, lines: file.deletionLines, source: content.deletionLineIndex },
  ];
  for (const range of ranges) {
    let first: number | undefined;
    for (let offset = 0; offset < range.count; offset++) {
      const index = range.start + offset;
      if (visible && !visible(index)) continue;
      first ??= index;
      if (range.lines[range.source + offset].trim()) return index;
    }
    // Do not jump into collapsed deletions just because the additions are all blank.
    if (first !== undefined) return first;
  }
}
