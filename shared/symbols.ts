import type { ReviewLine } from "./types";

export interface ReviewSymbol extends ReviewLine {
  name: string;
  kind: string;
  scope?: string;
}

export interface SymbolIndex {
  symbols: ReviewSymbol[];
  completed: number;
  total: number;
  state: "indexing" | "complete" | "failed";
  errors: string[];
}

export interface SymbolFile { path: string; oldPath: string }

/** Keep identifiers whole, including names mentioned in comments and strings. */
export function symbolWords(text: string): { name: string; start: number; end: number }[] {
  return Array.from(text.matchAll(/(?<![$_\p{ID_Continue}])[$_\p{ID_Start}][$_\p{ID_Continue}]*/gu), (match) => ({
    name: match[0], start: match.index, end: match.index + match[0].length,
  }));
}
