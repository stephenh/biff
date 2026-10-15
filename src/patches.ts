import { parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs";

/** Reject empty or malformed patches instead of showing an empty review. */
export function parseInput(text: string): FileDiffMetadata[] {
  const files = parsePatchFiles(text, undefined, true).flatMap((entry) => entry.files);
  if (files.length === 0) throw new Error("No file changes found. Open a Git-style unified .diff or .patch file.");
  return files;
}
