import type { FileDiffMetadata } from "@pierre/diffs";
import { lineLocation, lineText } from "./navigation";

export interface TextPoint { line: number; side: "LEFT" | "RIGHT"; column: number }

/**
 * Copy one revision's source, or unified display order when a range crosses revisions.
 *
 * Reading source avoids mixing folded deletions and comment previews into a snippet.
 */
export function selectedSourceText(file: FileDiffMetadata, anchor: TextPoint, target: TextPoint): string {
  const sameSide = anchor.side === target.side;
  const anchorIndex = sameSide ? anchor.line : textPointIndex(file, anchor);
  const targetIndex = sameSide ? target.line : textPointIndex(file, target);
  const forward = anchorIndex < targetIndex || anchorIndex === targetIndex && anchor.column <= target.column;
  const start = forward ? anchor : target;
  const end = forward ? target : anchor;
  const first = Math.min(anchorIndex, targetIndex);
  const last = Math.max(anchorIndex, targetIndex);
  const lines: string[] = [];

  for (let index = first; index <= last; index++) {
    const location = sameSide ? { path: file.name, line: index, side: start.side } : lineLocation(file, index);
    const text = location && lineText(file, location);
    if (text === undefined) throw new Error("Cannot copy omitted source lines. Show unmodified lines first.");
    lines.push(text.slice(index === first ? start.column : 0, index === last ? end.column : undefined));
  }
  return lines.join("\n");
}

/**
 * Reverse source coordinates without depending on the current virtual window.
 *
 * Old/new file lines stay stable when hydration inserts omitted context rows.
 */
export function textPointIndex(file: FileDiffMetadata, point: TextPoint): number {
  const old = point.side === "LEFT";
  for (const hunk of file.hunks) {
    let index = hunk.unifiedLineStart;
    let line = old ? hunk.deletionStart : hunk.additionStart;
    if (!file.isPartial && point.line >= line - hunk.collapsedBefore && point.line < line) return index - (line - point.line);
    for (const content of hunk.hunkContent) {
      const count = content.type === "context" ? content.lines : old ? content.deletions : content.additions;
      if (point.line >= line && point.line < line + count) return index + point.line - line + (content.type === "change" && !old ? content.deletions : 0);
      index += content.type === "context" ? content.lines : content.deletions + content.additions;
      line += count;
    }
    if (!file.isPartial && hunk === file.hunks.at(-1) && point.line >= line) return index + point.line - line;
  }
  throw new Error("That word is no longer in this diff.");
}
