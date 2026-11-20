import type { ChangeContent, ContextContent, FileDiffMetadata } from "@pierre/diffs";

const maxReplacementDeletions = 4;
const minReplacementAdditions = 20;

/**
 * Partition one-sided changes and large added tails at blank lines before navigation,
 * rendering, and hashing see them.
 *
 * Keep all removed rows with the first chunk of a mixed change. Cutting only
 * after those rows are paired preserves both unified and side-by-side coordinates.
 */
export function splitSemanticChanges(files: FileDiffMetadata[]): FileDiffMetadata[] {
  for (const file of files) {
    // Binary diffs have no text hunks; all other files can use blank-line boundaries.
    for (const hunk of file.hunks) {
      hunk.hunkContent = hunk.hunkContent.flatMap((content) => splitContent(file, content));
    }
  }
  return files;
}

/** Use the same paragraph boundaries inside functions, tests, and unparseable patch fragments. */
function splitContent(file: FileDiffMetadata, content: ContextContent | ChangeContent): (ContextContent | ChangeContent)[] {
  if (content.type !== "change") return [content];
  const mixed = content.additions > 0 && content.deletions > 0;
  // The size thresholds apply only to replacements; pure additions and deletions split at any size.
  if (mixed && (content.deletions > maxReplacementDeletions || content.additions < minReplacementAdditions)) return [content];

  const side = content.additions > 0 ? "addition" : "deletion";
  const start = content[`${side}LineIndex`];
  const count = content[`${side}s`];

  // Keep edge whitespace attached to changed content rather than creating a
  // whitespace-only review stop before the first paragraph or after the last.
  const cuts = paragraphStarts(file[`${side}Lines`].slice(start, start + count));
  // A cut inside the paired rows would push the remaining additions down in split view.
  const ends = [...cuts.filter((line) => !mixed || line >= content.deletions), count];
  if (ends.length === 1) return [content];

  return ends.map((end, index) => {
    const begin = index === 0 ? 0 : ends[index - 1];
    const chunk = { ...content, [`${side}LineIndex`]: start + begin, [`${side}s`]: end - begin };
    if (mixed && index > 0) {
      chunk.deletions = 0;
      chunk.deletionLineIndex += content.deletions;
    }
    return chunk;
  });
}

/** Keep blank-line separators with the preceding text chunk so navigation lands on content. */
function paragraphStarts(lines: string[]): number[] {
  const starts: number[] = [];
  let previousContent = -1;
  for (let line = 0; line < lines.length; line++) {
    if (!lines[line].trim()) continue;
    if (previousContent >= 0 && previousContent < line - 1) starts.push(line);
    previousContent = line;
  }
  return starts;
}
