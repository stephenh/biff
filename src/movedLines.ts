import type { FileDiffMetadata } from "@pierre/diffs";

interface MatchingLines { deleted: number[]; added: number[] }

/**
 * Find added lines whose unchanged text also appears among this file's deletions.
 *
 * Compare trimmed lines longer than ten characters, excluding unchanged context.
 * I.e. a deleted `const value = 123;` at unified index 0 and an indented addition
 * at index 8 marks only index 8; a `{` never qualifies, regardless of indentation.
 */
export function matchingChangedLines(file: FileDiffMetadata): Set<number> {
  const matches = new Map<string, MatchingLines>();
  for (const hunk of file.hunks) {
    let oldIndex = hunk.deletionLineIndex;
    let newIndex = hunk.additionLineIndex;
    let unifiedIndex = hunk.unifiedLineStart;
    for (const content of hunk.hunkContent) {
      if (content.type === "context") {
        oldIndex += content.lines;
        newIndex += content.lines;
        unifiedIndex += content.lines;
        continue;
      }
      for (let offset = 0; offset < content.deletions; offset++) recordLine(matches, file.deletionLines[oldIndex + offset], "deleted", unifiedIndex + offset);
      for (let offset = 0; offset < content.additions; offset++) recordLine(matches, file.additionLines[newIndex + offset], "added", unifiedIndex + content.deletions + offset);
      oldIndex += content.deletions;
      newIndex += content.additions;
      unifiedIndex += content.deletions + content.additions;
    }
  }
  return new Set([...matches.values()].flatMap((lines) => lines.deleted.length ? lines.added : []));
}

/** Mark rendered code and gutters without changing text, coordinates, or row sizes. */
export function highlightMovedLines(container: HTMLElement, file: FileDiffMetadata) {
  const root = container.shadowRoot;
  if (!root) return;
  const indices = matchingChangedLines(file);
  if (!root.querySelector("[data-biff-moved-style]")) {
    const style = document.createElement("style");
    style.dataset.biffMovedStyle = "";
    style.textContent = `
      [data-biff-moved] { background-color: #15304b !important; }
      [data-gutter] > [data-biff-moved] { color: #8dc7ff !important; }
    `;
    root.append(style);
  }
  for (const row of root.querySelectorAll<HTMLElement>("[data-content] > [data-line], [data-gutter] > [data-line-index]")) {
    row.toggleAttribute("data-biff-moved", indices.has(Number(row.dataset.lineIndex!.split(",")[0])));
  }
}

/** Short punctuation and blank lines are too common to suggest a moved line. */
function recordLine(matches: Map<string, MatchingLines>, text: string, side: "deleted" | "added", index: number) {
  const key = text.trim();
  if (key.length <= 10) return;
  const lines = matches.get(key) ?? { deleted: [], added: [] };
  lines[side].push(index);
  matches.set(key, lines);
}
