import type { FileDiffLoadedFiles, FileDiffMetadata } from "@pierre/diffs";
import { searchLines, type SearchLine } from "./search";

export interface FileSearchMatch extends SearchLine { start: number; end: number }
interface MatchRange { start: number; end: number }

/** Find literal occurrences with Vim-style smart case, including removed and omitted lines. */
export function fileSearchMatches(file: FileDiffMetadata, query: string, contents?: FileDiffLoadedFiles): FileSearchMatch[] {
  if (!query) return [];
  const pattern = literalPattern(query);
  return searchLines(file, contents).flatMap((line) => literalMatches(line.text, pattern).map((match) => ({ ...line, ...match })));
}

/** Paint source text across syntax tokens without changing Pierre's DOM or line coordinates. */
export function paintFileSearch(container: HTMLElement, query: string): void {
  CSS.highlights.delete("biff-file-search");
  const root = container.shadowRoot;
  if (!root || !query) return;
  const pattern = literalPattern(query);

  if (!root.querySelector("[data-file-search-style]")) {
    const style = document.createElement("style");
    style.dataset.fileSearchStyle = "";
    style.textContent = "::highlight(biff-file-search) { background-color: #f6d365; color: #1b1b1f; }";
    root.append(style);
  }

  const highlight = new Highlight();
  for (const row of root.querySelectorAll<HTMLElement>("[data-content] > [data-line]")) {
    const matches = literalMatches(row.textContent ?? "", pattern);
    if (!matches.length) continue;
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    while (walker.nextNode()) nodes.push(walker.currentNode as Text);
    for (const match of matches) highlight.add(textRange(nodes, match));
  }
  CSS.highlights.set("biff-file-search", highlight);
}

/** Uppercase letters opt into exact case; punctuation stays literal in either mode. */
function literalPattern(query: string): RegExp {
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(escaped, query === query.toLowerCase() ? "giu" : "gu");
}

/** Match original text: lowercasing Unicode source can change its length and corrupt DOM offsets. */
function literalMatches(text: string, pattern: RegExp): MatchRange[] {
  return Array.from(text.matchAll(pattern), (match) => ({ start: match.index, end: match.index + match[0].length }));
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
