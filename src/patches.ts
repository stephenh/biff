import { parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs";
import { hideWhitespace } from "../shared/hideWhitespace";
import { splitSemanticChanges } from "../shared/semanticChanges";
import { diffMetrics, trackDiffFile } from "./diffMetrics";

/** Reject empty or malformed patches instead of showing an empty review. */
export function parseInput(text: string, whitespaceHidden = false, reviewLabel?: string): FileDiffMetadata[] {
  const review = reviewLabel === undefined ? undefined : diffMetrics.begin(reviewLabel);
  const started = performance.now();
  let phaseStarted = started;
  const filtered = whitespaceHidden ? text : hideWhitespace(text);
  if (review !== undefined) diffMetrics.record(review, { phase: "whitespace filtering", durationMs: performance.now() - phaseStarted, outcome: whitespaceHidden ? "already filtered" : "filtered" });
  if (text.trim() && !filtered.trim()) throw new Error("No non-whitespace changes in this patch.");
  phaseStarted = performance.now();
  const files = parsePatchFiles(filtered, undefined, true).flatMap((entry) => entry.files);
  if (review !== undefined) diffMetrics.record(review, { phase: "patch parsing", durationMs: performance.now() - phaseStarted });
  if (files.length === 0) throw new Error("No file changes found. Open a Git-style unified .diff or .patch file.");
  for (const file of files) {
    phaseStarted = performance.now();
    splitSemanticChanges([file]);
    if (review !== undefined) {
      trackDiffFile(file, review);
      diffMetrics.record(review, { phase: "semantic splitting", file: file.name, durationMs: performance.now() - phaseStarted });
    }
  }
  if (review !== undefined) {
    diffMetrics.files(review, files.length);
    diffMetrics.record(review, { phase: "review preparation (inclusive)", durationMs: performance.now() - started, characters: text.length });
  }
  return files;
}
