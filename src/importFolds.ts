import type { FileDiffLoadedFiles, FileDiffMetadata } from "@pierre/diffs";
import { findImportGroups, type ImportGroup } from "./importGroups";
import { changeStarts } from "./navigation";
import { recordFileTiming } from "./diffMetrics";

interface CachedGroups { hunks: FileDiffMetadata["hunks"]; contents?: FileDiffLoadedFiles; groups: ImportGroup[] }
const cache = new WeakMap<FileDiffMetadata, CachedGroups>();

/** Classify once per metadata/source version, including native full-source hydration. */
export function importGroups(file: FileDiffMetadata, contents?: FileDiffLoadedFiles): ImportGroup[] {
  const previous = cache.get(file);
  if (previous?.hunks === file.hunks && previous.contents === contents) return previous.groups;
  const started = performance.now();
  const groups = findImportGroups(file, contents);
  recordFileTiming(file, { phase: "import classification", durationMs: performance.now() - started, outcome: contents ? "full source" : "patch" });
  cache.set(file, { hunks: file.hunks, contents, groups });
  return groups;
}

/** Source coordinates keep expansion stable when hydration changes unified row indexes. */
export function importGroupId(group: ImportGroup): string {
  return group.keys[0];
}

/** Find a hidden region directly in metadata, without inspecting rendered rows. */
export function foldedImportAt(groups: ImportGroup[], expanded: ReadonlySet<string>, index: number): ImportGroup | undefined {
  return groups.find((group) => index >= group.start && index <= group.end && !group.keys.some((key) => expanded.has(key)));
}

/** Locate business changes in source metadata, including mixed import/business edits. */
export function firstNonImportChange(file: FileDiffMetadata, groups: ImportGroup[], expanded: ReadonlySet<string>, fromHunk: number, direction: 1 | -1 = 1): { index: number; hunkIndex: number } | undefined {
  const starts = changeStarts(file, false);
  const blocks: { start: number; deletions: number; additions: number }[] = [];
  for (const hunk of file.hunks) {
    let index = hunk.unifiedLineStart;
    for (const content of hunk.hunkContent) {
      if (content.type === "context") index += content.lines;
      else {
        blocks.push({ start: index, deletions: content.deletions, additions: content.additions });
        index += content.deletions + content.additions;
      }
    }
  }
  for (let hunkIndex = fromHunk; hunkIndex >= 0 && hunkIndex < starts.length; hunkIndex += direction) {
    const block = blocks[hunkIndex];
    for (const range of [[block.start + block.deletions, block.additions], [block.start, block.deletions]]) {
      for (let index = range[0]; index < range[0] + range[1]; index++) if (!foldedImportAt(groups, expanded, index)) return { index, hunkIndex };
    }
  }
}
