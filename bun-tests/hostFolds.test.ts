import { describe, expect, test } from "bun:test";
import { DiffHunksRenderer } from "@pierre/diffs";
import { parseInput } from "../src/patches";
import { firstNonImportChange, importGroups } from "../src/importFolds";

const patch = 'diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n@@ -1,3 +1,3 @@\n-import Old from "old";\n+import New from "new";\n \n-const value = 1;\n+const value = 2;\n';

describe("hostFolds", () => {
  test("the renderer emits one separator instead of the folded source rows", async () => {
    // Given a fold around the first deleted and added lines
    const file = parseInput(patch)[0];
    const renderer = new DiffHunksRenderer({ diffStyle: "unified", hunkSeparators: "simple", resolveFoldedRanges: () => [{ id: "imports", start: 0, end: 1, expanded: false, label: "Imports" }] });

    // When the renderer builds its output without any browser DOM
    const result = await renderer.asyncRender(file);

    // Then only the fold separator and the remaining three lines are counted
    expect(result.rowCount).toBe(4);
  });

  test("fold expansion restores original line coordinates", async () => {
    // Given an expanded host-controlled fold
    const file = parseInput(patch)[0];
    const renderer = new DiffHunksRenderer({ diffStyle: "unified", hunkSeparators: "simple", resolveFoldedRanges: () => [{ id: "imports", start: 0, end: 1, expanded: true, label: "Imports" }] });

    // When the renderer emits its syntax tree
    const result = await renderer.asyncRender(file);
    const coordinates = result.unifiedContentAST!.flatMap((node) => node.type === "element" && node.properties["data-line"] !== undefined ? [node.properties["data-line-index"]] : []);

    // Then the separator has not renumbered the real diff rows
    expect(coordinates).toEqual(["0,0", "1,0", "2,1", "3,2", "4,2"]);
  });

  test("overlapping host ranges are rejected instead of silently dropping code", async () => {
    // Given two overlapping folds
    const file = parseInput(patch)[0];
    const renderer = new DiffHunksRenderer({ diffStyle: "unified", resolveFoldedRanges: () => [{ id: "a", start: 0, end: 2, expanded: false, label: "a" }, { id: "b", start: 2, end: 3, expanded: false, label: "b" }] });

    // When those folds reach the renderer
    const rendering = renderer.asyncRender(file);

    // Then the unsupported range configuration fails explicitly
    await expect(rendering).rejects.toThrow("sorted, disjoint ranges");
  });

  test("split mode is explicitly outside this focused dependency patch", async () => {
    // Given folds requested in split mode
    const file = parseInput(patch)[0];
    const renderer = new DiffHunksRenderer({ diffStyle: "split", resolveFoldedRanges: () => [{ id: "imports", start: 0, end: 1, expanded: false, label: "Imports" }] });

    // When the renderer is asked to produce split output
    const rendering = renderer.asyncRender(file);

    // Then it reports the limitation rather than corrupting paired rows
    await expect(rendering).rejects.toThrow("read-only unified FileDiff");
  });

  test("an import-only trailing hunk keeps the native context expansion affordance", async () => {
    // Given a partial patch consisting entirely of imports
    const file = parseInput('diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-import A from "a";\n+import B from "b";\n')[0];
    const options: ConstructorParameters<typeof DiffHunksRenderer>[0] = { diffStyle: "unified", hunkSeparators: "line-info", loadDiffFiles: async () => ({ oldFile: { name: file.name, contents: "" }, newFile: { name: file.name, contents: "" } }), resolveFoldedRanges: () => [{ id: "imports", start: 0, end: 1, expanded: false, label: "Imports" }] };
    const renderer = new DiffHunksRenderer(options);

    // When the entire hunk is folded
    const result = await renderer.asyncRender(file);

    // Then the Imports row and trailing native context control both remain
    expect(result.rowCount).toBe(2);
  });

  test("import classification is cached for an unchanged source revision", () => {
    // Given the same immutable file metadata used in repeated renders
    const file = parseInput(patch)[0];
    const initial = importGroups(file);

    // When the fold resolver runs again
    const repeated = importGroups(file);

    // Then it reuses the parsed classification instead of parsing TypeScript again
    expect(repeated).toBe(initial);
  });

  test("navigation locates the first non-import edit without a document or rendered rows", () => {
    // Given source metadata for an import replacement and a business change
    const file = parseInput(patch)[0];

    // When collapsed imports are skipped using metadata alone
    const target = firstNonImportChange(file, importGroups(file), new Set(), 0);

    // Then navigation points to the business addition
    expect(target).toEqual({ index: 4, hunkIndex: 1 });
  });

  test("navigation skips an import block's trailing blank separators", () => {
    // Given added imports and a function separated by changed blank lines
    const file = parseInput('diff --git a/file.ts b/file.ts\n--- /dev/null\n+++ b/file.ts\n@@ -0,0 +1,5 @@\n+import A from "a";\n+\n+  \n+/** Business code. */\n+function first() {}\n')[0];

    // When collapsed imports are skipped using metadata alone
    const target = firstNonImportChange(file, importGroups(file), new Set(), 0);

    // Then navigation lands on the function's documentation, not an import separator
    expect(target).toEqual({ index: 3, hunkIndex: 1 });
  });

  test("a virtual window after a folded range retains source coordinates", async () => {
    // Given imports occupy one projected row instead of two source rows
    const file = parseInput(patch)[0];
    const renderer = new DiffHunksRenderer({ diffStyle: "unified", hunkSeparators: "simple", resolveFoldedRanges: () => [{ id: "imports", start: 0, end: 1, expanded: false, label: "Imports" }] });

    // When the window begins after the import summary
    const result = await renderer.asyncRender(file, { startingLine: 1, totalLines: 2, bufferBefore: 32, bufferAfter: 35 });
    const coordinates = result.unifiedContentAST!.flatMap((node) => node.type === "element" && node.properties["data-line"] !== undefined ? [node.properties["data-line-index"]] : []);

    // Then its rows keep their original unified and split indexes
    expect(coordinates).toEqual(["2,1", "3,2"]);
  });

  test("a window inside expanded imports does not repeat the fold header", async () => {
    // Given the fold header belongs to the first import row
    const file = parseInput(patch)[0];
    const renderer = new DiffHunksRenderer({ diffStyle: "unified", hunkSeparators: "simple", resolveFoldedRanges: () => [{ id: "imports", start: 0, end: 1, expanded: true, label: "Imports" }] });

    // When only the second import is in the window
    const result = await renderer.asyncRender(file, { startingLine: 1, totalLines: 1, bufferBefore: 67, bufferAfter: 105 });

    // Then no extra separator changes the native window's height
    expect(result.rowCount).toBe(1);
  });
});
