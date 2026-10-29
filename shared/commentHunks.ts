import { parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs";
import { identifyChanges, type ChangeBlock } from "./changeProgress";
import { hideWhitespace } from "./hideWhitespace";
import { matchesChange } from "./progress";
import { splitSemanticChanges } from "./semanticChanges";
import type { DraftComment } from "./types";

export interface CommentHunks { files: FileDiffMetadata[]; blocks: ChangeBlock[] }

/** Use the same semantic hunk fingerprints as Biff's review marks, on both client and server. */
export async function commentHunks(patch: string): Promise<CommentHunks> {
  const files = splitSemanticChanges(parsePatchFiles(hideWhitespace(patch), undefined, true).flatMap((entry) => entry.files));
  return { files, blocks: await identifyChanges(files) };
}

/** Remember the selected line relative to its edit, not its commit or absolute line number. */
export function anchorComment(hunks: CommentHunks, comment: DraftComment, endLine = comment.line): DraftComment {
  const file = hunks.files.find((entry) => entry.name === comment.path);
  if (!file) return comment;
  const side = comment.side === "LEFT" ? "deletion" : "addition";
  const hunk = file.hunks.find((entry) => comment.line >= entry[`${side}Start`] && comment.line < entry[`${side}Start`] + entry[`${side}Count`]);
  if (!hunk) return comment;

  // Context lines use the nearest edit in their Git hunk. The exact selected text
  // must still agree after moving; a changed context line is not a safe attachment.
  const blocks = hunks.blocks.filter((block) => block.path === comment.path && block.start >= hunk.unifiedLineStart && block.end < hunk.unifiedLineStart + hunk.unifiedLineCount);
  blocks.sort((a, b) => Math.abs(comment.line - startLine(a, comment.side)) - Math.abs(comment.line - startLine(b, comment.side)));
  const block = blocks[0];
  const text = rangeText(file, comment.side, comment.line, endLine - comment.line + 1);
  if (!block || text === undefined) return comment;
  const change = { path: block.path, hash: block.hash, oldLine: block.oldLine, newLine: block.newLine, duplicate: block.duplicate };
  return { ...comment, anchor: { change, offset: comment.line - startLine(block, comment.side), text, ...(endLine > comment.line ? { lineCount: endLine - comment.line + 1 } : {}) } };
}

/** Prefer logical edits, then recover unchanged selected text within the same file. */
export function followComment(hunks: CommentHunks, comment: DraftComment): DraftComment | undefined {
  const anchor = comment.anchor;
  if (!anchor) return;
  const matches = hunks.blocks.filter((block) => matchesChange(anchor.change, block));
  if (matches.length !== 1) return recoverComment(hunks, comment);
  const block = matches[0];
  // I.e. a RIGHT comment at line 11 in an edit starting at 10 has offset 1;
  // moving that edit to line 40 places the same comment at line 41.
  const line = startLine(block, comment.side) + anchor.offset;
  const file = hunks.files[block.fileIndex];
  if (rangeText(file, comment.side, line, anchor.lineCount ?? 1) !== anchor.text) return recoverComment(hunks, comment);
  return anchorComment(hunks, { ...comment, path: block.path, line }, line + (anchor.lineCount ?? 1) - 1);
}

/** Neighboring edits may change a fingerprint without changing the commented code. */
function recoverComment(hunks: CommentHunks, comment: DraftComment): DraftComment | undefined {
  const anchor = comment.anchor!;
  // Blank lines and punctuation alone cannot identify code after an edit moves.
  if (!/[\p{L}\p{N}]/u.test(anchor.text)) return;
  const files = hunks.files.filter((file) => file.name === comment.path || file.prevName === comment.path);
  const candidates = new Map<string, DraftComment>();
  const side = comment.side === "LEFT" ? "deletion" : "addition";
  for (const file of files) for (const hunk of file.hunks) {
    for (let line = hunk[`${side}Start`]; line < hunk[`${side}Start`] + hunk[`${side}Count`]; line++) {
      if (rangeText(file, comment.side, line, anchor.lineCount ?? 1) !== anchor.text) continue;
      candidates.set(`${file.name}:${line}`, anchorComment(hunks, { ...comment, path: file.name, line }, line + (anchor.lineCount ?? 1) - 1));
    }
  }
  // Absolute line proximity must not choose between two identical occurrences.
  return candidates.size === 1 ? candidates.values().next().value : undefined;
}

/** Offsets use the chosen side even for a mixed deletion/addition block. */
function startLine(block: ChangeBlock, side: DraftComment["side"]): number { return side === "LEFT" ? block.oldLine : block.newLine; }

/** Require an actual line in the pinned patch, including for context-line attachments. */
function lineText(file: FileDiffMetadata, side: DraftComment["side"], line: number): string | undefined {
  const key = side === "LEFT" ? "deletion" : "addition";
  const hunk = file.hunks.find((entry) => line >= entry[`${key}Start`] && line < entry[`${key}Start`] + entry[`${key}Count`]);
  return hunk ? file[`${key}Lines`][hunk[`${key}LineIndex`] + line - hunk[`${key}Start`]] : undefined;
}

/** Ranges must retain every selected line, not merely their first or last endpoint. */
function rangeText(file: FileDiffMetadata, side: DraftComment["side"], start: number, count: number): string | undefined {
  const lines: string[] = [];
  for (let offset = 0; offset < count; offset++) {
    const text = lineText(file, side, start + offset);
    if (text === undefined) return;
    lines.push(text);
  }
  return lines.join("");
}
