import { describe, expect, test } from "bun:test";
import { DiffHunksRenderer, hydratePartialDiff } from "@pierre/diffs";
import { createTwoFilesPatch } from "diff";
import { parseInput } from "../src/patches";
import { diffHighlightOptions } from "../src/diffHighlights";
import type { DiffTiming } from "../src/diffMetrics";

describe("diffHighlightCache", () => {
  test("highlighted tokens survive switching files and renderer instances", async () => {
    // Given a prepared file whose renderer has been released
    const [file] = parseInput(createTwoFilesPatch("file.ts", "file.ts", 'call(old);\n', 'call(\n  next\n);\n'));
    const warmer = new DiffHunksRenderer(diffHighlightOptions);
    await warmer.asyncRender(file);
    warmer.cleanUp();
    // And another file has since been highlighted
    const [other] = parseInput(createTwoFilesPatch("/dev/null", "other.ts", "", 'const other = 1;\n'));
    await new DiffHunksRenderer(diffHighlightOptions).asyncRender(other);

    // When a new renderer returns to the first file
    const timings: DiffTiming[] = [];
    await new DiffHunksRenderer({ ...diffHighlightOptions, onDiffTiming: (timing) => timings.push(timing) }).asyncRender(file);

    // Then it assembles rows without repeating comparisons or syntax highlighting
    expect(timings.map((timing) => timing.phase)).toEqual(["row AST assembly"]);
  });

  test("cached output preserves native source, highlighting, and line coordinates", async () => {
    // Given native output and the same file prepared for reuse
    const [file] = parseInput(createTwoFilesPatch("file.ts", "file.ts", 'call(old);\n', 'call(\n  next\n);\n'));
    const original = await new DiffHunksRenderer({ ...diffHighlightOptions, cacheHighlights: false, diffStyle: "unified" }).asyncRender(file);
    await new DiffHunksRenderer(diffHighlightOptions).asyncRender(file);

    // When building rows from cached highlighted tokens
    const cached = await new DiffHunksRenderer({ ...diffHighlightOptions, diffStyle: "unified" }).asyncRender(file);

    // Then every rendered source character and decoration stays the same
    expect(cached.unifiedContentAST).toEqual(original.unifiedContentAST);
  });

  test("changing inline-diff options recomputes the highlight", async () => {
    // Given cached block-aware word highlights
    const [file] = parseInput(createTwoFilesPatch("file.ts", "file.ts", 'call(old);\n', 'call(\n  next\n);\n'));
    await new DiffHunksRenderer(diffHighlightOptions).asyncRender(file);

    // When another renderer requests character highlights
    const timings: DiffTiming[] = [];
    await new DiffHunksRenderer({ ...diffHighlightOptions, lineDiffType: "char", onDiffTiming: (timing) => timings.push(timing) }).asyncRender(file);

    // Then stale word highlights are not reused
    expect(timings.filter((timing) => timing.phase === "highlight pipeline (inclusive)")).toMatchObject([{ outcome: "char" }]);
  });

  test("full-source hydration invalidates the partial highlight", async () => {
    // Given a cached partial file
    const oldSource = '// omitted context\n'.repeat(12) + 'call(old);\n';
    const newSource = '// omitted context\n'.repeat(12) + 'call(next);\n';
    const [file] = parseInput(createTwoFilesPatch("file.ts", "file.ts", oldSource, newSource));
    await new DiffHunksRenderer(diffHighlightOptions).asyncRender(file);
    // And context expansion upgrades the same metadata object
    hydratePartialDiff("merge", file, { oldFile: { name: file.name, contents: oldSource }, newFile: { name: file.name, contents: newSource } });

    // When highlighting the hydrated source
    const timings: DiffTiming[] = [];
    await new DiffHunksRenderer({ ...diffHighlightOptions, onDiffTiming: (timing) => timings.push(timing) }).asyncRender(file);

    // Then the new structural arrays require a fresh full-source pass
    expect(timings.filter((timing) => timing.phase === "highlight pipeline (inclusive)").map((timing) => timing.pass)).toEqual(["highlighted full"]);
  });

  test("plaintext fallback cannot poison a later syntax-highlighted render", async () => {
    // Given a file initially rendered over a deliberately tiny highlighting budget
    const [file] = parseInput(createTwoFilesPatch("file.ts", "file.ts", 'call(old);\n', 'call(\n  next\n);\n'));
    await new DiffHunksRenderer({ ...diffHighlightOptions, tokenizeMaxLength: 1 }).asyncRender(file);

    // When a renderer with the normal budget opens it
    const timings: DiffTiming[] = [];
    await new DiffHunksRenderer({ ...diffHighlightOptions, onDiffTiming: (timing) => timings.push(timing) }).asyncRender(file);

    // Then a real syntax-highlighted pass still runs
    expect(timings.filter((timing) => timing.phase === "highlight pipeline (inclusive)").map((timing) => timing.pass)).toEqual(["highlighted full"]);
  });

  test("host folds remain controlled independently of cached highlighting", async () => {
    // Given cached syntax tokens for a file with an import replacement
    const [file] = parseInput(createTwoFilesPatch("file.ts", "file.ts", 'import Old from "old";\n\nconst value = 1;\n', 'import New from "new";\n\nconst value = 2;\n'));
    await new DiffHunksRenderer(diffHighlightOptions).asyncRender(file);

    // When the visible renderer folds the changed imports
    const result = await new DiffHunksRenderer({ ...diffHighlightOptions, diffStyle: "unified", hunkSeparators: "simple", resolveFoldedRanges: () => [{ id: "imports", start: 0, end: 1, expanded: false, label: "Imports" }] }).asyncRender(file);

    // Then row assembly honors current folds rather than reusing a stale pane
    expect(result.rowCount).toBe(4);
  });

  test("replacing source arrays invalidates cached tokens even for the same file object", async () => {
    // Given cached highlighted tokens and a new source version with the same row counts
    const [file] = parseInput(createTwoFilesPatch("file.ts", "file.ts", 'call(old);\n', 'call(next);\n'));
    await new DiffHunksRenderer(diffHighlightOptions).asyncRender(file);
    // And the source arrays are replaced without replacing the metadata object
    file.additionLines = file.additionLines.map((line) => line.replace("next", "fresh"));
    const native = await new DiffHunksRenderer({ ...diffHighlightOptions, cacheHighlights: false, diffStyle: "unified" }).asyncRender(file);

    // When the cache-enabled renderer opens this source version
    const current = await new DiffHunksRenderer({ ...diffHighlightOptions, diffStyle: "unified" }).asyncRender(file);

    // Then the output contains the new source rather than stale cached tokens
    expect(current.unifiedContentAST).toEqual(native.unifiedContentAST);
  });

  test("changing the syntax theme invalidates cached highlights", async () => {
    // Given cached dark-theme tokens
    const [file] = parseInput(createTwoFilesPatch("file.ts", "file.ts", 'call(old);\n', 'call(next);\n'));
    await new DiffHunksRenderer(diffHighlightOptions).asyncRender(file);

    // When a renderer requests a different theme
    const timings: DiffTiming[] = [];
    await new DiffHunksRenderer({ ...diffHighlightOptions, theme: "pierre-light", onDiffTiming: (timing) => timings.push(timing) }).asyncRender(file);

    // Then the cached dark theme cannot suppress the new highlighting pass
    expect(timings.filter((timing) => timing.phase === "highlight pipeline (inclusive)")).toHaveLength(1);
  });
});
