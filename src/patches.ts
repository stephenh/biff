import { parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs";
import { hideWhitespace } from "../shared/hideWhitespace";

/** Reject empty or malformed patches instead of showing an empty review. */
export function parseInput(text: string, whitespaceHidden = false): FileDiffMetadata[] {
  const filtered = whitespaceHidden ? text : hideWhitespace(text);
  if (text.trim() && !filtered.trim()) throw new Error("No non-whitespace changes in this patch.");
  const files = parsePatchFiles(filtered, undefined, true).flatMap((entry) => entry.files);
  if (files.length === 0) throw new Error("No file changes found. Open a Git-style unified .diff or .patch file.");
  return files;
}
