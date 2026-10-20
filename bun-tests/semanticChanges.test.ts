import { describe, expect, test } from "bun:test";
import { DiffHunksRenderer, hydratePartialDiff, parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs";
import { createTwoFilesPatch } from "diff";
import { splitSemanticChanges } from "../shared/semanticChanges";
import { matchesChange } from "../shared/progress";
import { identifyChanges, isImportOnly } from "../src/changeProgress";
import { findImportGroups } from "../src/importGroups";
import { changeStarts, lineLocation } from "../src/navigation";
import { parseInput } from "../src/patches";
import { Progress } from "../server/progress";
import { Storage } from "../server/storage";

describe("semanticChanges", () => {
  test("only the fifth added function loses approval after its body grows", async () => {
    // Given ten independently reviewed functions in one new file
    const source = Array.from({ length: 10 }, (_, index) => `export function f${index + 1}() { return ${index}; }\n`).join("\n");
    const saved = await identifyChanges(parseInput(addition(source)));
    // And a longer replacement for only the fifth function
    const changed = source.replace("return 4;", "\n  const value = 40;\n  return value;\n");

    // When the next snapshot is matched against the saved approvals
    const current = await identifyChanges(parseInput(addition(changed)));
    const reviewed = current.map((block) => saved.some((entry) => matchesChange(entry, block)));

    // Then the other nine approvals survive their line shifts
    expect(reviewed).toEqual([true, true, true, true, false, true, true, true, true, true]);
  });

  test("a suite exposes tests and hooks without splitting their callback bodies", () => {
    // Given a suite containing a hook, nested test statements, and a parameterized test
    const source = 'describe("suite", () => {\n  beforeEach(() => { setup(); });\n  it("first", () => {\n    const value = 1;\n    expect(value).toBe(1);\n  });\n  test.each([1, 2])("second", (value) => { expect(value).toBe(value); });\n});\n';

    // When its single addition is partitioned
    const blocks = changedText(parseInput(addition(source))[0]);

    // Then suite edges, the hook, and the two complete tests are separate units
    expect(blocks).toEqual(['describe("suite", () => {\n', '  beforeEach(() => { setup(); });\n', '  it("first", () => {\n    const value = 1;\n    expect(value).toBe(1);\n  });\n', '  test.each([1, 2])("second", (value) => { expect(value).toBe(value); });\n', '});\n']);
  });

  test("class methods retain decorators and documentation", () => {
    // Given an exported class with documented, decorated methods
    const source = 'export class Example {\n  value = 1;\n\n  /** First method. */\n  @cached\n  first() { return this.value; }\n\n  second() { return 2; }\n}\n';

    // When partitioning the new class
    const blocks = changedText(parseInput(addition(source))[0]);

    // Then methods own their leading documentation, independently of the class closure
    expect(blocks).toEqual(['export class Example {\n', '  value = 1;\n', '\n  /** First method. */\n  @cached\n  first() { return this.value; }\n', '\n  second() { return 2; }\n', '}\n']);
  });

  test("consecutive imports remain one import-only review block", async () => {
    // Given two imports followed by a function
    const files = parseInput(addition('import A from "a";\nimport B from "b";\n\nexport function first() {}\n'));

    // When applying the existing import exclusion to semantic blocks
    const blocks = await identifyChanges(files);
    const excluded = blocks.map((block) => isImportOnly(block, findImportGroups(files[0])));

    // Then only the grouped imports are excluded from completion counts
    expect(excluded).toEqual([true, false]);
  });

  test("pure deletions retain left-side navigation and comment coordinates", () => {
    // Given two functions removed from an existing file
    const source = 'function first() {}\nfunction second() {}\n';
    const file = parseInput(createTwoFilesPatch("file.ts", "file.ts", source, ""))[0];

    // When navigation resolves the new semantic stops
    const locations = changeStarts(file).map((row) => lineLocation(file, row));

    // Then each function selects its actual old-file line
    expect(locations).toEqual([{ path: "file.ts", line: 1, side: "LEFT" }, { path: "file.ts", line: 2, side: "LEFT" }]);
  });

  test("mixed replacements keep their original metadata", () => {
    // Given adjacent old and new versions of two functions
    const patch = createTwoFilesPatch("file.ts", "file.ts", 'function a() { return 1; }\nfunction b() { return 2; }\n', 'function a() { return 3; }\nfunction b() { return 4; }\n');
    const files = parsePatchFiles(patch, undefined, true).flatMap((entry) => entry.files);
    const original = structuredClone(files);

    // When semantic splitting is requested
    splitSemanticChanges(files);

    // Then no replacement rows or metadata change
    expect(files).toEqual(original);
  });

  test("fragment recovery trims suite edges without dropping their rows", () => {
    // Given a hunk starting with an earlier suite's closure and ending with a new suite opener
    const source = '});\n  it("first", () => {});\n  it("second", () => {});\ndescribe("next", () => {\n';

    // When recovering the complete tests in the middle
    const blocks = changedText(parseInput(addition(source))[0]);

    // Then all source survives, with separate stops for both complete tests
    expect(blocks).toEqual(['});\n', '  it("first", () => {});\n', '  it("second", () => {});\ndescribe("next", () => {\n']);
  });

  test("method fragments can parse without their class header", () => {
    // Given a patch containing complete methods and only the class's closing brace
    const source = '  first(): number { return 1; }\n  second(): number { return 2; }\n}\n';

    // When the missing class context is supplied only to the parser
    const blocks = changedText(parseInput(addition(source))[0]);

    // Then both methods are independently reviewable without synthesized diff text
    expect(blocks).toEqual(['  first(): number { return 1; }\n', '  second(): number { return 2; }\n}\n']);
  });

  test("unparseable partial comments remain unsplit", () => {
    // Given an unterminated comment containing code-looking lines
    const source = '/* unfinished\nfunction first() {}\nfunction second() {}\n';

    // When fragment recovery cannot establish syntax boundaries
    const blocks = changedText(parseInput(addition(source))[0]);

    // Then it retains the original change block
    expect(blocks).toEqual([source]);
  });

  test("renderer coordinates are unchanged by adjacent semantic blocks", async () => {
    // Given a new file with imports, a class, and top-level functions
    const patch = addition('import A from "a";\nclass Example {\n  first() {}\n  second() {}\n}\nfunction third() {}\n');
    const original = parsePatchFiles(patch, undefined, true)[0].files[0];
    const renderer = new DiffHunksRenderer({ diffStyle: "unified", hunkSeparators: "simple" });
    const before = await renderer.asyncRender(original);

    // When the same diff is rendered with semantic blocks
    const after = await new DiffHunksRenderer({ diffStyle: "unified", hunkSeparators: "simple" }).asyncRender(parseInput(patch)[0]);

    // Then its rendered source and line anchors are identical
    expect(after.unifiedContentAST).toEqual(before.unifiedContentAST);
  });

  test("full-source hydration preserves semantic block identities", async () => {
    // Given a partial patch with two added functions after omitted context
    const oldSource = '// context\n'.repeat(12);
    const newSource = oldSource + 'function first() {}\nfunction second() {}\n';
    const file = parseInput(createTwoFilesPatch("file.ts", "file.ts", oldSource, newSource))[0];
    const saved = await identifyChanges([file]);

    // When Pierre hydrates the patch for context expansion
    hydratePartialDiff("merge", file, { oldFile: { name: "file.ts", contents: oldSource }, newFile: { name: "file.ts", contents: newSource } });
    const current = await identifyChanges([file]);

    // Then both review identities survive the renderer's metadata rewrite
    expect(current.map((block, index) => matchesChange(saved[index], block))).toEqual([true, true]);
  });

  test("server reconciliation retains a flagged semantic block", async () => {
    // Given a flag created from the browser's semantic partition
    const storage = new Storage();
    try {
      const progress = new Progress(storage);
      const patch = addition('function first() {}\nfunction second() {}\n');
      const [, second] = await identifyChanges(parseInput(patch));
      await progress.followUpHunk("example/project/12", second, "old", true);

      // When the server reconciles the same patch at a new head
      await progress.reconcileFollowUps("example/project/12", patch, "new", "pr");

      // Then its independently computed identities preserve the flag
      expect(progress.followUps("example/project/12")).toMatchObject([{ hash: second.hash }]);
    } finally { await storage.close(); }
  });

  test("known function context keeps an added body atomic", () => {
    // Given two statements added inside a function whose braces are patch context
    const patch = createTwoFilesPatch("file.ts", "file.ts", 'function first() {\n}\n', 'function first() {\n  const one = 1;\n  const two = 2;\n}\n');

    // When the hunk supplies a complete enclosing function
    const blocks = changedText(parseInput(patch)[0]);

    // Then the body is not reparsed as separate top-level declarations
    expect(blocks).toEqual(['  const one = 1;\n  const two = 2;\n']);
  });

  test("TSX function-valued declarations remain whole review units", () => {
    // Given adjacent components with multiline JSX
    const source = 'export const First = () => (\n  <div>first</div>\n);\nexport const Second = () => <div>second</div>;\n';

    // When parsing a TSX addition
    const blocks = changedText(parseInput(addition(source).replaceAll("file.ts", "file.tsx"))[0]);

    // Then component bodies remain attached to their declarations
    expect(blocks).toEqual(['export const First = () => (\n  <div>first</div>\n);\n', 'export const Second = () => <div>second</div>;\n']);
  });

  test("a trailing comment stays with its preceding function", () => {
    // Given a trailing comment followed by documentation for the next function
    const source = 'function first() {} // first only\n/** Second function. */\nfunction second() {}\n';

    // When Babel reports both comments as leading comments for the second function
    const blocks = changedText(parseInput(addition(source))[0]);

    // Then only the whole-line documentation moves with the second function
    expect(blocks).toEqual(['function first() {} // first only\n', '/** Second function. */\nfunction second() {}\n']);
  });
});

/** Build an all-green patch while retaining real new-file metadata. */
function addition(source: string): string {
  return createTwoFilesPatch("/dev/null", "file.ts", "", source);
}

/** Read the exact text assigned to each review unit. */
function changedText(file: FileDiffMetadata): string[] {
  return file.hunks.flatMap((hunk) => hunk.hunkContent.flatMap((content) => content.type === "context" ? [] : [
    file.deletionLines.slice(content.deletionLineIndex, content.deletionLineIndex + content.deletions).join("") + file.additionLines.slice(content.additionLineIndex, content.additionLineIndex + content.additions).join(""),
  ]));
}
