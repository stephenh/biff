import type { FileDiffLoadedFiles, FileDiffMetadata } from "@pierre/diffs";
import { searchLines, type SearchLine } from "./search";

export interface FileSearchMatch extends SearchLine { start: number; end: number }
interface MatchRange { start: number; end: number }

/** Find every literal, case-sensitive occurrence, including removed and omitted lines. */
export function fileSearchMatches(file: FileDiffMetadata, query: string, contents?: FileDiffLoadedFiles): FileSearchMatch[] {
  if (!query) return [];
  return searchLines(file, contents).flatMap((line) => literalMatches(line.text, query).map((match) => ({ ...line, ...match })));
}

/** Paint source text across syntax tokens without changing Pierre's DOM or line coordinates. */
export function paintFileSearch(container: HTMLElement, query: string): void {
  CSS.highlights.delete("biff-file-search");
  const root = container.shadowRoot;
  if (!root || !query) return;

  if (!root.querySelector("[data-file-search-style]")) {
    const style = document.createElement("style");
    style.dataset.fileSearchStyle = "";
    style.textContent = "::highlight(biff-file-search) { background-color: #f6d365; color: #1b1b1f; }";
    root.append(style);
  }

  const highlight = new Highlight();
  for (const row of root.querySelectorAll<HTMLElement>("[data-content] > [data-line]")) {
    const matches = literalMatches(row.textContent ?? "", query);
    if (!matches.length) continue;
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    while (walker.nextNode()) nodes.push(walker.currentNode as Text);
    for (const match of matches) highlight.add(textRange(nodes, match));
  }
  CSS.highlights.set("biff-file-search", highlight);
}

/** Treat punctuation as text, not regular expressions, and keep occurrence offsets. */
function literalMatches(text: string, query: string): MatchRange[] {
  if (!query) return [];
  const matches: MatchRange[] = [];
  let start = text.indexOf(query);
  while (start >= 0) {
    matches.push({ start, end: start + query.length });
    start = text.indexOf(query, start + query.length);
  }
  return matches;
}

/** A symbol can span multiple syntax spans; DOM ranges preserve their original styling. */
function textRange(nodes: Text[], match: MatchRange): Range {
  const range = document.createRange();
  let offset = 0;
  for (const node of nodes) {
    const end = offset + node.length;
    if (match.start >= offset && match.start < end) range.setStart(node, match.start - offset);
    if (match.end > offset && match.end <= end) {
      range.setEnd(node, match.end - offset);
      break;
    }
    offset = end;
  }
  return range;
}
