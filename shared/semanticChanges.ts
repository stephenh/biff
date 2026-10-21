import { parse } from "@babel/parser";
import type { ChangeContent, ContextContent, FileDiffMetadata } from "@pierre/diffs";

type Statement = ReturnType<typeof parse>["program"]["body"][number];
interface LocatedNode {
  loc?: { start: { line: number; column: number }; end: { line: number; column: number } } | null;
  leadingComments?: readonly LocatedNode[] | null;
}

/**
 * Partition one-sided changes before navigation, rendering, and hashing see them.
 *
 * Adjacent change entries preserve every row and both coordinate systems. Mixed
 * replacements cannot be partitioned this way without rearranging old/new rows.
 */
export function splitSemanticChanges(files: FileDiffMetadata[]): FileDiffMetadata[] {
  for (const file of files) {
    if (!/\.(?:[cm]?ts|tsx|md|markdown)$/i.test(file.name)) continue;
    for (const hunk of file.hunks) {
      if (!hunk.hunkContent.some((content) => content.type === "change" && (content.additions === 0 || content.deletions === 0) && content.additions + content.deletions > 1)) continue;
      const boundaries = new Map<"addition" | "deletion", number[] | undefined>();
      for (const side of ["addition", "deletion"] as const) {
        const start = hunk[`${side}LineIndex`];
        const lines = file[`${side}Lines`].slice(start, start + hunk[`${side}Count`]);
        boundaries.set(side, semanticStarts(lines, file.name)?.map((line) => start + line));
      }
      hunk.hunkContent = hunk.hunkContent.flatMap((content) => splitContent(file, content, boundaries));
    }
  }
  return files;
}

/** Prefer parsed hunk context so a change inside a known function does not become top-level statements. */
function splitContent(file: FileDiffMetadata, content: ContextContent | ChangeContent, boundaries: Map<"addition" | "deletion", number[] | undefined>): (ContextContent | ChangeContent)[] {
  if (content.type !== "change" || content.additions > 0 && content.deletions > 0) return [content];
  const side = content.additions > 0 ? "addition" : "deletion";
  const start = content[`${side}LineIndex`];
  const count = content[`${side}s`];

  // A complete added test/function batch can parse even when its surrounding
  // context starts halfway through unrelated syntax.
  const candidates = boundaries.get(side) ?? semanticStarts(file[`${side}Lines`].slice(start, start + count), file.name)?.map((line) => start + line) ?? [];

  // The next unchanged declaration can claim leading blanks inside this change.
  // Keep that whitespace with the last changed declaration, not a review stop of its own.
  let end = start + count;
  while (end > start && !file[`${side}Lines`][end - 1].trim()) end--;
  const cuts = candidates.filter((line) => line > start && line < end);
  if (!cuts.length) return [content];
  const ends = [...cuts, start + count];
  return ends.map((end, index) => {
    const begin = index === 0 ? start : ends[index - 1];
    return { ...content, [`${side}LineIndex`]: begin, [`${side}s`]: end - begin };
  });
}

/**
 * Recover complete declarations from patch fragments without requesting source.
 *
 * Only recognizable container edges may be trimmed, and trimmed text remains in
 * the original change. Bound the search rather than trying every substring of a
 * large malformed hunk. Unknown partial statements/comments stay unsplit.
 */
function semanticStarts(lines: string[], name: string): number[] | undefined {
  if (/\.(?:md|markdown)$/i.test(name)) return paragraphStarts(lines);

  const source = lines.map((line) => line.replace(/\r?\n$/, ""));
  const pending: [number, number][] = [[0, source.length]];
  const visited = new Set<string>();
  for (let attempt = 0; pending.length && attempt < 32; attempt++) {
    const [start, end] = pending.shift()!;
    const key = `${start}:${end}`;
    if (visited.has(key) || start >= end) continue;
    visited.add(key);
    const fragment = source.slice(start, end).join("\n");
    const starts = parseStarts(fragment, name, source, start);
    if (starts !== undefined) return starts;
    if (containerEdge(source[start])) pending.push([start + 1, end]);
    if (containerEdge(source[end - 1])) pending.push([start, end - 1]);
  }
  return undefined;
}

/** Parse ordinary declarations first, then methods whose class header is outside the patch. */
function parseStarts(fragment: string, name: string, lines: string[], offset: number): number[] | undefined {
  for (const wrapped of [false, true]) {
    try {
      const program = parse(wrapped ? `class __BiffFragment {\n${fragment}\n}` : fragment, {
        sourceType: "module",
        plugins: /\.tsx$/i.test(name) ? ["typescript", "jsx", "decorators"] : ["typescript", "decorators"],
      }).program;
      const starts = new Set<number>();
      const adjustment = offset - (wrapped ? 1 : 0);
      if (wrapped) {
        const container = program.body[0];
        if (container.type !== "ClassDeclaration") continue;
        for (const member of container.body.body) addStart(member, lines, adjustment, starts);
      } else collectStatements(program.body, lines, adjustment, starts);
      return [...starts].filter((line) => line >= 0 && line < lines.length).sort((a, b) => a - b);
    } catch { /* Uncertain syntax keeps its original review block. */ }
  }
  return undefined;
}

/** Descend into classes and test suites, but keep function and test bodies atomic. */
function collectStatements(statements: Statement[], lines: string[], offset: number, starts: Set<number>): void {
  let previousImport = false;
  for (const statement of statements) {
    const isImport = statement.type === "ImportDeclaration" || statement.type === "TSImportEqualsDeclaration";
    if (!isImport || !previousImport) addStart(statement, lines, offset, starts);
    previousImport = isImport;
    const node = statement.type === "ExportNamedDeclaration" || statement.type === "ExportDefaultDeclaration" ? statement.declaration : statement;
    if (node?.type === "ClassDeclaration") {
      for (const member of node.body.body) addStart(member, lines, offset, starts);
      addClosingStart(node.body, lines, offset, starts);
    } else if (node?.type === "ExpressionStatement" && node.expression.type === "CallExpression" && suiteCall(node.expression.callee)) {
      const callback = node.expression.arguments.at(-1);
      if ((callback?.type === "ArrowFunctionExpression" || callback?.type === "FunctionExpression") && callback.body.type === "BlockStatement") {
        collectStatements(callback.body.body, lines, offset, starts);
        addClosingStart(callback.body, lines, offset, starts);
      }
    }
  }
}

/** Recognize describe modifiers and describe.each without depending on a test framework. */
function suiteCall(node: { type: string; name?: string; object?: unknown; callee?: unknown; tag?: unknown }): boolean {
  if (node.type === "Identifier") return node.name === "describe" || node.name === "suite";
  const parent = node.type === "MemberExpression" ? node.object : node.type === "CallExpression" ? node.callee : node.type === "TaggedTemplateExpression" ? node.tag : undefined;
  return typeof parent === "object" && parent !== null && "type" in parent && typeof parent.type === "string" && suiteCall(parent as Parameters<typeof suiteCall>[0]);
}

/** Include leading documentation and blanks, but never split two nodes on the same line. */
function addStart(node: LocatedNode, lines: string[], offset: number, starts: Set<number>): void {
  // Babel also attaches the previous declaration's trailing comment as a leading
  // comment. Only whole-line comments can belong to this declaration's block.
  const leading = node.leadingComments?.find((comment) => {
    const start = comment.loc?.start;
    return start && lines[start.line - 1 + offset]?.slice(0, start.column).trim() === "";
  });
  const location = leading?.loc?.start ?? node.loc?.start;
  if (!location) return;
  let line = location.line - 1 + offset;
  if (line < 0 || line >= lines.length || lines[line].slice(0, location.column).trim()) return;
  while (line > 0 && !lines[line - 1].trim()) line--;
  starts.add(line);
}

/** Keep container closures separate so appending a method does not change the previous method's hash. */
function addClosingStart(node: LocatedNode, lines: string[], offset: number, starts: Set<number>): void {
  if (!node.loc) return;
  const line = node.loc.end.line - 1 + offset;
  if (line >= 0 && line < lines.length && /^\s*}/.test(lines[line])) starts.add(line);
}

/** Recovery discards only syntax at fragment edges, never arbitrary statement or string contents. */
function containerEdge(line: string): boolean {
  return !line.trim() || /^\s*[});]+\s*;?\s*$/.test(line) || /^\s*(?:(?:export\s+)?(?:abstract\s+)?class\s+\w[^;]*|(?:describe|suite)(?:\.(?:only|skip))?\s*\([^;]*)\{\s*$/.test(line);
}

/** Keep Markdown separators with the preceding paragraph so navigation lands on content. */
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
