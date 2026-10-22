import { describe, expect, test } from "bun:test";
import { DiffHunksRenderer, type FileDiffMetadata, type HunksRenderResult, type LineDiffTypes } from "@pierre/diffs";
import { createTwoFilesPatch } from "diff";
import { parseInput } from "../src/patches";
import type { DiffTiming } from "../src/diffMetrics";

type DiffNode = NonNullable<HunksRenderResult["unifiedContentAST"]>[number];
const before = 'const cellElement = renderFn(columnIndex, cellCss, content, row, rowStyle, undefined, cellOnClick, tooltip);\n';
const after = 'const cellElement = renderFn(\n  columnIndex,\n  cellCss,\n  renderedContent,\n  row,\n  rowStyle,\n  undefined,\n  cellOnClick,\n  tooltip,\n);\n';

describe("blockWordDiff", () => {
  test("a reformatted call highlights only the removed argument", async () => {
    // Given one old line expanded into a multiline call with a renamed argument
    const file = patchFile(before, after);

    // When Pierre renders the block-aware word diff
    const result = await render(file);

    // Then unchanged arguments are not marked as deleted symbols
    expect(highlights(result, "deletion")).toEqual(["content"]);
  });

  test("a reformatted call highlights the new argument and added trailing comma", async () => {
    // Given the screenshot's renamed argument and a newly added trailing comma
    const file = patchFile(before, after);

    // When Pierre renders the block-aware word diff
    const result = await render(file);

    // Then only the new symbol and punctuation receive stronger addition highlights
    expect(highlights(result, "addition")).toEqual(["renderedContent", ","]);
  });

  test("collapsing a multiline call back to one line retains token highlighting", async () => {
    // Given the same change in the many-to-one direction
    const file = patchFile(after, before);

    // When the replacement is rendered
    const result = await render(file);

    // Then the new single-line argument is highlighted at its actual column
    expect(highlights(result, "addition")).toEqual(["content"]);
  });

  test("ordinary same-sized edits keep Pierre's existing word-alt rendering", async () => {
    // Given a normal single-line replacement
    const file = patchFile('const answer = previous(value);\n', 'const answer = next(value);\n');
    const original = await render(file, "word-alt");

    // When rendering with the optional block mode
    const current = await render(file);

    // Then native inline highlighting and source rows are unchanged
    expect(current.unifiedContentAST).toEqual(original.unifiedContentAST);
  });

  test("large replacement blocks fall back to native line highlighting", async () => {
    // Given a replacement exceeding the small-block line budget
    const file = patchFile(before, Array.from({ length: 65 }, (_, index) => `call${index}();\n`).join(""));
    const original = await render(file, "word-alt");

    // When block highlighting declines the expensive comparison
    const current = await render(file);

    // Then native rendering is retained rather than running an unbounded block diff
    expect(current.unifiedContentAST).toEqual(original.unifiedContentAST);
  });

  test("partial patches retain source-coordinate offsets when mapping new symbols", async () => {
    // Given omitted context before the changed call
    const context = '// earlier context\n'.repeat(12);
    const file = patchFile(context + before, context + after);

    // When the visible hunk is highlighted
    const result = await render(file);

    // Then token offsets still address the call, not the preceding context
    expect(highlights(result, "addition")).toEqual(["renderedContent", ","]);
  });

  test("highlighting does not change source line anchors", async () => {
    // Given the same replacement rendered by native Pierre
    const file = patchFile(before, after);
    const original = await render(file, "word-alt");

    // When token highlights span the replacement's line breaks
    const current = await render(file);

    // Then source coordinates used by navigation and comments remain identical
    expect(rows(current).map((row) => row.type === "element" ? row.properties : undefined)).toEqual(rows(original).map((row) => row.type === "element" ? row.properties : undefined));
  });

  test("highlighting preserves every original source character", async () => {
    // Given original CRLF text without final newlines
    const file = patchFile(before.trimEnd(), after.replaceAll("\n", "\r\n").trimEnd());
    const original = await render(file, "word-alt");

    // When only highlight decorations change
    const current = await render(file);

    // Then the actual rendered source text is untouched
    expect(rows(current).map(text)).toEqual(rows(original).map(text));
  });

  test("format-only line wrapping adds no stronger token highlights", async () => {
    // Given line wrapping without any changed identifiers or punctuation
    const file = patchFile('call(first, second);\n', 'call(\n  first,\n  second\n);\n');

    // When comparing tokens across the replacement
    const result = await render(file);

    // Then the addition's line background remains sufficient to show the reformatting
    expect(highlights(result, "addition")).toEqual([]);
  });

  test("separate replacement blocks do not match tokens across unchanged context", async () => {
    // Given two reformatted calls separated by unchanged source
    const separator = '// unchanged separator\n';
    const file = patchFile(before + separator + before, after + separator + after);

    // When each native replacement block is highlighted independently
    const result = await render(file);

    // Then both calls retain their own changed-token ranges
    expect(highlights(result, "addition")).toEqual(["renderedContent", ",", "renderedContent", ","]);
  });

  test("pure additions retain Pierre's native rendering", async () => {
    // Given a complete added file with no old-side counterpart
    const file = patchFile("", after);
    const original = await render(file, "word-alt");

    // When using the optional block-aware mode
    const current = await render(file);

    // Then one-sided hunks are not token-matched against unrelated source
    expect(current.unifiedContentAST).toEqual(original.unifiedContentAST);
  });

  test("block comparison timings identify their native hunk and outcome", async () => {
    // Given the reformatted call and a local timing sink
    const file = patchFile(before, after);
    const timings: DiffTiming[] = [];

    // When the real renderer highlights it
    await new DiffHunksRenderer({ lineDiffType: "word-block", onDiffTiming: (timing) => timings.push(timing) }).asyncRender(file);

    // Then the measured block belongs to the highlighted pass and first hunk
    expect(timings.filter((timing) => timing.phase === "block word comparison")).toMatchObject([{ hunk: 0, block: 0, pass: "highlighted full", outcome: "highlighted", durationMs: expect.any(Number) }]);
  });

  test("oversized block timings explain why native highlighting was used", async () => {
    // Given a replacement above the block line budget
    const file = patchFile(before, Array.from({ length: 65 }, (_, index) => `call${index}();\n`).join(""));
    const timings: DiffTiming[] = [];

    // When the renderer declines the cross-line comparison
    await new DiffHunksRenderer({ lineDiffType: "word-block", onDiffTiming: (timing) => timings.push(timing) }).asyncRender(file);

    // Then the report names the fallback instead of claiming a successful block match
    expect(timings.filter((timing) => timing.phase === "block word comparison")).toMatchObject([{ hunk: 0, outcome: "line limit", lines: 66 }]);
  });

  test("instrumentation preserves the renderer output", async () => {
    // Given the existing uninstrumented output
    const file = patchFile(before, after);
    const original = await render(file);

    // When diagnostics are enabled
    const measured = await new DiffHunksRenderer({ diffStyle: "unified", hunkSeparators: "simple", lineDiffType: "word-block", onDiffTiming: () => {} }).asyncRender(file);

    // Then diagnostics do not change the diff AST
    expect(measured.unifiedContentAST).toEqual(original.unifiedContentAST);
  });

  test("renderer phases keep inclusive pipeline time separate from child phases", async () => {
    // Given a real replacement and a timing sink
    const file = patchFile(before, after);
    const timings: DiffTiming[] = [];

    // When rendering through syntax highlighting and row assembly
    await new DiffHunksRenderer({ lineDiffType: "word-block", onDiffTiming: (timing) => timings.push(timing) }).asyncRender(file);

    // Then all measured phases are reported independently
    expect(timings.map((timing) => timing.phase)).toEqual(["block word comparison", "line decorations and bucketing", "syntax rendering", "highlight pipeline (inclusive)", "row AST assembly"]);
  });

  test("plaintext fallback timings are distinct from syntax-highlighted timings", async () => {
    // Given a file over an intentionally small syntax-highlighting limit
    const file = patchFile(before, after);
    const timings: DiffTiming[] = [];

    // When Pierre chooses its plaintext path
    await new DiffHunksRenderer({ lineDiffType: "word-block", tokenizeMaxLength: 1, onDiffTiming: (timing) => timings.push(timing) }).asyncRender(file);

    // Then the pipeline is labeled plaintext rather than counted as syntax highlighting
    expect(timings.filter((timing) => timing.phase === "highlight pipeline (inclusive)").map((timing) => timing.pass)).toEqual(["plaintext full"]);
  });

  test("cached renders do not report another highlight pipeline", async () => {
    // Given a renderer with a ready highlighter and cached rendered tokens
    const file = patchFile(before, after);
    const timings: DiffTiming[] = [];
    const renderer = new DiffHunksRenderer({ lineDiffType: "word-block", onDiffTiming: (timing) => timings.push(timing) });
    await renderer.asyncRender(file);
    renderer.renderDiff(file);
    timings.length = 0;

    // When rendering the same file from cache
    renderer.renderDiff(file);

    // Then only row assembly runs again, not token comparison or syntax highlighting
    expect(timings.map((timing) => timing.phase)).toEqual(["row AST assembly"]);
  });
});

/** Create a real patch without changing its native mixed replacement blocks. */
function patchFile(oldSource: string, newSource: string): FileDiffMetadata {
  return parseInput(createTwoFilesPatch("file.ts", "file.ts", oldSource, newSource))[0];
}

/** Exercise the real Pierre renderer and its existing Shiki decoration pipeline. */
async function render(file: FileDiffMetadata, mode: LineDiffTypes = "word-block"): Promise<HunksRenderResult> {
  return new DiffHunksRenderer({ diffStyle: "unified", hunkSeparators: "simple", lineDiffType: mode }).asyncRender(file);
}

/** Read highlights from their rendered source rows, not from the new helper's implementation. */
function highlights(result: HunksRenderResult, side: "addition" | "deletion"): string[] {
  return rows(result).filter((row) => row.type === "element" && row.properties["data-line-type"] === `change-${side}`).flatMap(markedText);
}

/** Exclude separators and other non-source decorations. */
function rows(result: HunksRenderResult): DiffNode[] {
  return (result.unifiedContentAST ?? []).filter((node) => node.type === "element" && node.properties["data-line"] !== undefined);
}

/** Decorations can contain multiple syntax-colored spans. */
function markedText(node: DiffNode): string[] {
  if (node.type !== "element") return [];
  return node.properties["data-diff-span"] !== undefined ? [text(node)] : node.children.flatMap(markedText);
}

/** Read original characters across syntax and diff wrappers. */
function text(node: DiffNode): string {
  return node.type === "text" ? node.value : node.type === "element" ? node.children.map(text).join("") : "";
}
