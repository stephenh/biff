import { parse } from "@babel/parser";
import type { FileDiffLoadedFiles, FileDiffMetadata } from "@pierre/diffs";

type LineKind = "import" | "blank" | "code";
type SourceLines = Map<number, LineKind>;
interface ImportRow { index: number; keys: string[]; kind: LineKind; changed: boolean }
export interface ImportGroup { start: number; end: number; changes: number; keys: string[]; leading: boolean }

/** Restrict import folding to TypeScript files, including module and declaration variants. */
export function isTypeScriptFile(name: string): boolean {
  return /\.(?:[cm]?ts|tsx)$/i.test(name);
}

/** Request complete source only when a changed line could belong to a static import. */
export function importSourceMayHelp(file: FileDiffMetadata): boolean {
  if (!file.isPartial || !isTypeScriptFile(file.name)) return false;
  const candidate = /^\s*(?:import(?=\s|['"{*])|}\s*from\s*['"]|(?:type\s+)?[\w$]+(?:\s+as\s+[\w$]+)?\s*,?\s*(?:\/\/.*)?$)/;
  return file.hunks.some((hunk) => hunk.hunkContent.some((content) => content.type === "change" && [
    ...file.deletionLines.slice(content.deletionLineIndex, content.deletionLineIndex + content.deletions),
    ...file.additionLines.slice(content.additionLineIndex, content.additionLineIndex + content.additions),
  ].some((line) => candidate.test(line.trimEnd()))));
}

/**
 * Group consecutive import declarations and their intervening blank/context lines.
 *
 * Parse old and new sources independently so multiline imports remain recognizable
 * when only their specifiers change. A missing patch gap is a boundary unless full
 * source proves it contains only imports. Changed business code is always a boundary.
 */
export function findImportGroups(file: FileDiffMetadata, contents?: FileDiffLoadedFiles): ImportGroup[] {
  if (!isTypeScriptFile(file.name)) return [];
  const oldSource = sourceLines(file, "old", contents?.oldFile?.contents);
  const newSource = sourceLines(file, "new", contents?.newFile?.contents);
  const groups: ImportGroup[] = [];
  let rows: ImportRow[] = [];
  let previousOldEnd = 0;
  let previousNewEnd = 0;

  for (const hunk of file.hunks) {
    // Full-source context participates in the same metadata group even if the
    // native renderer currently represents it as an unchanged-lines separator.
    const gap = hunk.deletionStart - previousOldEnd - 1;
    if (gap > 0 && gap === hunk.additionStart - previousNewEnd - 1) {
      for (let offset = 1; offset <= gap; offset++) appendContext(previousOldEnd + offset, previousNewEnd + offset, hunk.unifiedLineStart - gap + offset - 1);
    } else if (!onlyImports(oldSource, previousOldEnd + 1, hunk.deletionStart - 1) || !onlyImports(newSource, previousNewEnd + 1, hunk.additionStart - 1)) flush();
    let oldLine = hunk.deletionStart;
    let newLine = hunk.additionStart;
    let index = hunk.unifiedLineStart;
    for (const content of hunk.hunkContent) {
      if (content.type === "context") {
        for (let offset = 0; offset < content.lines; offset++) {
          const oldKind = oldSource.get(oldLine);
          const newKind = newSource.get(newLine);
          append({ index: index++, keys: [`LEFT:${oldLine++}`, `RIGHT:${newLine++}`], kind: oldKind === newKind ? oldKind ?? "code" : "code", changed: false });
        }
      } else {
        for (let offset = 0; offset < content.deletions; offset++) append({ index: index++, keys: [`LEFT:${oldLine}`], kind: oldSource.get(oldLine++) ?? "code", changed: true });
        for (let offset = 0; offset < content.additions; offset++) append({ index: index++, keys: [`RIGHT:${newLine}`], kind: newSource.get(newLine++) ?? "code", changed: true });
      }
    }
    previousOldEnd = oldLine - 1;
    previousNewEnd = newLine - 1;
  }
  const lastHunk = file.hunks.at(-1);
  const oldTail = oldSource.size - previousOldEnd;
  const newTail = newSource.size - previousNewEnd;
  if (lastHunk && oldTail > 0 && oldTail === newTail) {
    for (let offset = 1; offset <= oldTail; offset++) appendContext(previousOldEnd + offset, previousNewEnd + offset, lastHunk.unifiedLineStart + lastHunk.unifiedLineCount + offset - 1);
  }
  flush();
  return groups;

  /** Classify unchanged context by both source coordinates, never by rendered HTML. */
  function appendContext(oldLine: number, newLine: number, index: number) {
    const oldKind = oldSource.get(oldLine);
    const newKind = newSource.get(newLine);
    append({ index, keys: [`LEFT:${oldLine}`, `RIGHT:${newLine}`], kind: oldKind === newKind ? oldKind ?? "code" : "code", changed: false });
  }

  /** A stanza may span multiple change blocks, but never crosses business code. */
  function append(row: ImportRow) {
    if (row.kind === "code") flush();
    else rows.push(row);
  }

  /** Exclude surrounding blank lines and stanzas with no changed imports. */
  function flush() {
    const first = rows.findIndex((row) => row.kind === "import");
    let last = rows.length - 1;
    while (last >= 0 && rows[last].kind !== "import") last--;
    const stanza = first < 0 ? [] : rows.slice(first, last + 1);
    const changes = stanza.filter((row) => row.changed && row.kind === "import").length;
    if (changes) {
      const start = stanza[0].index;
      const hunk = file.hunks[0];
      groups.push({ start, end: stanza.at(-1)!.index, changes, keys: stanza.flatMap((row) => row.keys), leading: start <= hunk.unifiedLineStart && onlyImports(oldSource, 1, hunk.deletionStart - 1) && onlyImports(newSource, 1, hunk.additionStart - 1) });
    }
    rows = [];
  }
}

/** Classify complete sources when available, otherwise only each supplied patch segment. */
function sourceLines(file: FileDiffMetadata, side: "old" | "new", contents?: string): SourceLines {
  const result: SourceLines = new Map();
  const lines = side === "old" ? file.deletionLines : file.additionLines;
  if (contents !== undefined || !file.isPartial) {
    classifyLines(result, contents === undefined ? lines : contents.split(/\r?\n/), 1, file.name);
  } else {
    for (const hunk of file.hunks) {
      const start = side === "old" ? hunk.deletionLineIndex : hunk.additionLineIndex;
      const count = side === "old" ? hunk.deletionCount : hunk.additionCount;
      classifyLines(result, lines.slice(start, start + count), side === "old" ? hunk.deletionStart : hunk.additionStart, file.name);
    }
  }
  return result;
}

/** Use syntax nodes instead of guessing whether braces, comments, or strings are imports. */
function classifyLines(result: SourceLines, lines: string[], start: number, name: string) {
  const imports = importLines(lines, name);
  for (const [index, text] of lines.entries()) result.set(start + index, imports.has(index) ? "import" : text.trim() ? "code" : "blank");
}

/**
 * Recognize complete imports in a full source or an incomplete patch fragment.
 *
 * Partial hunks can start in the middle of unrelated syntax. If whole-fragment
 * parsing fails, isolate only syntactically complete static import declarations.
 */
function importLines(lines: string[], name: string): Set<number> {
  const result = new Set<number>();
  const program = parseSource(lines, name);
  if (program) {
    for (const node of program.body) {
      if ((node.type === "ImportDeclaration" || node.type === "TSImportEqualsDeclaration") && node.loc) {
        for (let line = node.loc.start.line - 1; line < node.loc.end.line; line++) result.add(line);
      }
    }
    return result;
  }
  for (let start = 0; start < lines.length; start++) {
    if (!/^\s*import(?=\s|['"{*])/.test(lines[start])) continue;
    for (let end = start; end < lines.length; end++) {
      if (end > start && /^\s*import\b/.test(lines[end])) break;
      if (!/['";})]\s*(?:\/\/.*)?$/.test(lines[end].trim())) continue;
      const candidate = parseSource(lines.slice(start, end + 1), name)?.body[0];
      if ((candidate?.type !== "ImportDeclaration" && candidate?.type !== "TSImportEqualsDeclaration") || !candidate.loc) continue;
      const last = start + candidate.loc.end.line - 1;
      for (let line = start; line <= last; line++) result.add(line);
      start = last;
      break;
    }
  }
  return result;
}

/** Keep unsupported or incomplete syntax visible rather than folding uncertain rows. */
function parseSource(lines: string[], name: string) {
  try {
    return parse(lines.map((line) => line.replace(/\r?\n$/, "")).join("\n"), { sourceType: "module", plugins: /\.tsx$/i.test(name) ? ["typescript", "jsx", "decorators"] : ["typescript", "decorators"] }).program;
  } catch { return undefined; }
}

/** Omitted code is never assumed to be an import just because both ends are imports. */
function onlyImports(source: SourceLines, start: number, end: number): boolean {
  for (let line = start; line <= end; line++) {
    const kind = source.get(line);
    if (kind !== "import" && kind !== "blank") return false;
  }
  return true;
}
