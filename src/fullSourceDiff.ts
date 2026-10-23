import { hydratePartialDiff, type FileDiffLoadedFiles, type FileDiffMetadata } from "@pierre/diffs";
import { inheritDiffTracking } from "./diffMetrics";

const hydratedFiles = new WeakMap<FileDiffMetadata, { contents: FileDiffLoadedFiles; file: FileDiffMetadata }>();

/** Only native two-sided diffs can acquire omitted source without reparsing their change blocks. */
export function canLoadDiffSource(file: FileDiffMetadata): boolean {
  return Boolean(file.isPartial) && file.hunks.length > 0 && (file.type === "change" || file.type === "rename-changed");
}

/**
 * Share full syntax context without changing the review's canonical change blocks.
 *
 * A partial hunk may start inside a template literal or comment. Pierre must tokenize
 * the full source, even when its native viewport keeps unchanged lines collapsed.
 */
export function fullSourceDiff(file: FileDiffMetadata, contents?: FileDiffLoadedFiles): FileDiffMetadata {
  if (!canLoadDiffSource(file) || !contents?.newFile || !contents.oldFile) return file;
  const cached = hydratedFiles.get(file);
  if (cached?.contents === contents) return cached.file;

  const hydrated = hydratePartialDiff("clone", file, contents);
  inheritDiffTracking(file, hydrated);
  hydratedFiles.set(file, { contents, file: hydrated });
  return hydrated;
}
