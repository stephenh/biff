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

/** Keep identifiers whole, including private JavaScript names and mentions in comments and strings. */
export function symbolWords(text: string, path = ""): { name: string; start: number; end: number }[] {
  // In other languages, # can start a comment rather than belong to the name.
  // Do not alias #foo to foo: they can be different members of the same class.
  const pattern = /\.(?:[cm]?[jt]s|[jt]sx)$/i.test(path)
    ? /(?<![#$_\p{ID_Continue}])#?[$_\p{ID_Start}][$_\p{ID_Continue}]*/gu
    : /(?<![$_\p{ID_Continue}])[$_\p{ID_Start}][$_\p{ID_Continue}]*/gu;
  return Array.from(text.matchAll(pattern), (match) => ({
    name: match[0], start: match.index, end: match.index + match[0].length,
  }));
}
