import type { ChangeContent, ContextContent, FileDiffMetadata } from "@pierre/diffs";

/**
 * Partition addition-only and deletion-only changes at blank lines before navigation,
 * rendering, and hashing see them.
 *
 * Adjacent change entries preserve every row and both coordinate systems. Mixed
 * replacements cannot be partitioned this way without rearranging old/new rows.
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
  if (content.type !== "change" || content.additions > 0 && content.deletions > 0) return [content];
  const side = content.additions > 0 ? "addition" : "deletion";
  const start = content[`${side}LineIndex`];
  const count = content[`${side}s`];

  // Keep edge whitespace attached to changed content rather than creating a
  // whitespace-only review stop before the first paragraph or after the last.
  const cuts = paragraphStarts(file[`${side}Lines`].slice(start, start + count)).map((line) => start + line);
  if (!cuts.length) return [content];
  const ends = [...cuts, start + count];
  return ends.map((end, index) => {
    const begin = index === 0 ? start : ends[index - 1];
    return { ...content, [`${side}LineIndex`]: begin, [`${side}s`]: end - begin };
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
