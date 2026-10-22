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
    expect(blocks).toEqual(['export class Example {\n', '  value = 1;\n\n', '  /** First method. */\n  @cached\n  first() { return this.value; }\n\n', '  second() { return 2; }\n', '}\n']);
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

  test("trailing added blanks stay with the last added function before unchanged code", () => {
    // Given added functions separated from an unchanged function by added blank lines
    const existing = 'function existing() {}\n';
    const added = 'function first() {}\nfunction second() {}\n\n  \n';
    const patch = createTwoFilesPatch("file.ts", "file.ts", existing, added + existing);

    // When the unchanged function contributes a boundary after the added whitespace
    const blocks = changedText(parseInput(patch)[0]);

    // Then the last function owns all trailing added whitespace without an extra review unit
    expect(blocks).toEqual(['function first() {}\n', 'function second() {}\n\n  \n']);
  });

  test("trailing deleted blanks stay with the last removed function before unchanged code", () => {
    // Given removed functions followed by removed blank lines and an unchanged function
    const existing = 'function existing() {}\n';
    const removed = 'function first() {}\nfunction second() {}\n\n';
    const patch = createTwoFilesPatch("file.ts", "file.ts", removed + existing, existing);

    // When the unchanged function contributes a boundary after the deleted whitespace
    const blocks = changedText(parseInput(patch)[0]);

    // Then the last removed function owns the trailing blank rather than a separate review unit
    expect(blocks).toEqual(['function first() {}\n', 'function second() {}\n\n']);
  });

  test("Markdown additions split at blank lines, not wrapped paragraph lines", () => {
    // Given a README containing a heading and two paragraphs
    const source = '# Guide\n\nFirst paragraph\ncontinued on another line.\n\nSecond paragraph.\n';
    const patch = createTwoFilesPatch("/dev/null", "README.md", "", source);

    // When its pure addition is partitioned
    const blocks = changedText(parseInput(patch)[0]);

    // Then each paragraph retains its trailing separator and wrapped lines
    expect(blocks).toEqual(['# Guide\n\n', 'First paragraph\ncontinued on another line.\n\n', 'Second paragraph.\n']);
  });

  test("Markdown deletions split at whitespace-only lines without blank review units", () => {
    // Given a deleted document with repeated separators and trailing blanks
    const source = '\r\nFirst paragraph.\r\n  \r\n\r\nSecond paragraph.\r\n\r\n';
    const patch = createTwoFilesPatch("docs/guide.markdown", "/dev/null", source, "");

    // When its pure deletion is partitioned
    const blocks = changedText(parseInput(patch)[0]);

    // Then separators stay with the preceding paragraph without isolating the file's leading blank
    expect(blocks).toEqual(['\r\nFirst paragraph.\r\n  \r\n\r\n', 'Second paragraph.\r\n\r\n']);
  });

  test("Markdown paragraphs added inside existing context split independently", () => {
    // Given new paragraphs between unchanged paragraphs
    const existing = '# Guide\n\nExisting paragraph.\n';
    const added = 'First added paragraph.\n\nSecond added paragraph.\n\n';
    const patch = createTwoFilesPatch("README.md", "README.md", existing, existing.replace("Existing paragraph.", added + "Existing paragraph."));

    // When the hunk includes unchanged paragraphs on either side
    const blocks = changedText(parseInput(patch)[0]);

    // Then only the added paragraphs become review units, without a trailing blank unit
    expect(blocks).toEqual(['First added paragraph.\n\n', 'Second added paragraph.\n\n']);
  });

  test("mixed Markdown replacements keep their original metadata", () => {
    // Given adjacent old and new versions of two paragraphs
    const patch = createTwoFilesPatch("README.md", "README.md", 'Old first.\n\nOld second.\n', 'New first.\n\nNew second.\n');
    const files = parsePatchFiles(patch, undefined, true).flatMap((entry) => entry.files);
    const original = structuredClone(files);

    // When semantic splitting is requested
    splitSemanticChanges(files);

    // Then replacement rows and metadata remain unchanged
    expect(files).toEqual(original);
  });

  test("editing one Markdown paragraph preserves approval of the other paragraphs", async () => {
    // Given three independently reviewed paragraphs
    const source = 'First paragraph.\n\nSecond paragraph.\n\nThird paragraph.\n';
    const saved = await identifyChanges(parseInput(createTwoFilesPatch("/dev/null", "README.md", "", source)));
    // And a longer replacement for only the middle paragraph
    const changed = source.replace("Second paragraph.", "Second paragraph, expanded\nonto another line.");

    // When the next snapshot is matched against the saved approvals
    const current = await identifyChanges(parseInput(createTwoFilesPatch("/dev/null", "README.md", "", changed)));
    const reviewed = current.map((block) => saved.some((entry) => matchesChange(entry, block)));

    // Then only the edited paragraph loses approval
    expect(reviewed).toEqual([true, false, true]);
  });

  test("Markdown addition navigation lands on each paragraph's first content line", () => {
    // Given added paragraphs separated by repeated blank and whitespace-only lines
    const source = 'First paragraph\ncontinued.\n\n  \nSecond paragraph.\n';
    const file = parseInput(createTwoFilesPatch("/dev/null", "README.md", "", source))[0];

    // When navigating between semantic hunks
    const locations = changeStarts(file).map((row) => lineLocation(file, row));

    // Then each stop selects content rather than the preceding separator
    expect(locations).toEqual([{ path: "README.md", line: 1, side: "RIGHT" }, { path: "README.md", line: 5, side: "RIGHT" }]);
  });

  test("Markdown deletion navigation lands on each paragraph's first content line", () => {
    // Given removed paragraphs separated by a blank line
    const source = 'First paragraph.\n\nSecond paragraph.\n';
    const file = parseInput(createTwoFilesPatch("docs/guide.md", "/dev/null", source, ""))[0];

    // When navigating between semantic hunks on the old side
    const locations = changeStarts(file).map((row) => lineLocation(file, row));

    // Then the next stop selects the removed paragraph rather than its separator
    expect(locations).toEqual([{ path: "docs/guide.md", line: 1, side: "LEFT" }, { path: "docs/guide.md", line: 3, side: "LEFT" }]);
  });

  test("TypeScript additions keep separator blanks with the preceding declaration", () => {
    // Given added functions with leading, repeated, whitespace-only, and trailing blanks
    const source = '\nfunction first() {}\n\n  \n/** Second function. */\nfunction second() {}\n\n';

    // When its pure addition is partitioned
    const blocks = changedText(parseInput(addition(source))[0]);

    // Then separators stay with the previous function and documentation stays with the next
    expect(blocks).toEqual(['\nfunction first() {}\n\n  \n', '/** Second function. */\nfunction second() {}\n\n']);
  });

  test("TypeScript addition navigation lands on documentation rather than separator blanks", () => {
    // Given functions separated by a blank line before the second function's documentation
    const source = 'function first() {}\n\n/** Second function. */\nfunction second() {}\n';
    const file = parseInput(addition(source))[0];

    // When navigating between semantic hunks
    const locations = changeStarts(file).map((row) => lineLocation(file, row));

    // Then the next stop selects the documentation's first content line
    expect(locations).toEqual([{ path: "file.ts", line: 1, side: "RIGHT" }, { path: "file.ts", line: 3, side: "RIGHT" }]);
  });

  test("TypeScript deletion navigation skips blank separators", () => {
    // Given removed functions separated by repeated blank and whitespace-only lines
    const source = 'function first() {}\n\n  \nfunction second() {}\n';
    const file = parseInput(createTwoFilesPatch("file.ts", "file.ts", source, ""))[0];

    // When navigating between semantic hunks on the old side
    const locations = changeStarts(file).map((row) => lineLocation(file, row));

    // Then each stop selects a function rather than its separator
    expect(locations).toEqual([{ path: "file.ts", line: 1, side: "LEFT" }, { path: "file.ts", line: 4, side: "LEFT" }]);
  });

  test("GraphQL additions split at blank lines between definitions", () => {
    // Given two added GraphQL definitions in a single Git hunk
    const source = 'type Author {\n  id: ID!\n  name: String!\n}\n\ntype Book {\n  title: String!\n}\n';
    const patch = createTwoFilesPatch("/dev/null", "schema.graphql", "", source);

    // When no language-specific semantic splitter is available
    const blocks = changedText(parseInput(patch)[0]);

    // Then the blank line separates definitions without splitting their fields
    expect(blocks).toEqual(['type Author {\n  id: ID!\n  name: String!\n}\n\n', 'type Book {\n  title: String!\n}\n']);
  });

  test("extensionless text uses blank-line chunking", () => {
    // Given an extensionless file containing two paragraphs
    const source = 'First section\ncontinued.\n\nSecond section.\n';
    const patch = createTwoFilesPatch("/dev/null", "NOTICE", "", source);

    // When partitioning its pure addition
    const blocks = changedText(parseInput(patch)[0]);

    // Then no filename or syntax-highlighting recognition is required
    expect(blocks).toEqual(['First section\ncontinued.\n\n', 'Second section.\n']);
  });

  test("plain-text deletions retain repeated separators without blank review units", () => {
    // Given deleted text with leading, whitespace-only, repeated, and trailing CRLF blanks
    const source = '\r\nFirst chunk.\r\n  \r\n\r\nSecond chunk.\r\n\r\n';
    const patch = createTwoFilesPatch("notes.txt", "/dev/null", source, "");

    // When partitioning its pure deletion
    const blocks = changedText(parseInput(patch)[0]);

    // Then blank separators stay with their text rather than becoming review stops
    expect(blocks).toEqual(['\r\nFirst chunk.\r\n  \r\n\r\n', 'Second chunk.\r\n\r\n']);
  });

  test("fallback chunk navigation selects the next chunk's original line", () => {
    // Given Python functions separated by blank lines and no Python-specific splitter
    const source = 'def first():\n    return 1\n\n\ndef second():\n    return 2\n';
    const file = parseInput(createTwoFilesPatch("functions.py", "/dev/null", source, ""))[0];

    // When navigating between removed chunks
    const locations = changeStarts(file).map((row) => lineLocation(file, row));

    // Then navigation skips separators and preserves old-side comment coordinates
    expect(locations).toEqual([{ path: "functions.py", line: 1, side: "LEFT" }, { path: "functions.py", line: 5, side: "LEFT" }]);
  });

  test("mixed fallback replacements retain their original metadata", () => {
    // Given a mixed replacement of GraphQL definitions separated by blanks
    const patch = createTwoFilesPatch("schema.graphql", "schema.graphql", 'type OldFirst { id: ID! }\n\ntype OldSecond { id: ID! }\n', 'type NewFirst { id: ID! }\n\ntype NewSecond { id: ID! }\n');
    const files = parsePatchFiles(patch, undefined, true).flatMap((entry) => entry.files);
    const original = structuredClone(files);

    // When blank-line splitting is applied
    splitSemanticChanges(files);

    // Then mixed replacements are not rearranged or re-paired
    expect(files).toEqual(original);
  });

  test("binary patches remain unchanged", () => {
    // Given an actual Git binary-file marker rather than source lines
    const patch = 'diff --git a/image.png b/image.png\nindex 1234567..abcdef0 100644\nBinary files a/image.png and b/image.png differ\n';
    const files = parsePatchFiles(patch, undefined, true).flatMap((entry) => entry.files);
    const original = structuredClone(files);

    // When splitting text chunks
    splitSemanticChanges(files);

    // Then no text hunks or review chunks are invented for binary data
    expect(files).toEqual(original);
  });

  test("editing one GraphQL chunk preserves approval of the others", async () => {
    // Given independently reviewed definitions from a newly added schema
    const source = 'type First { id: ID! }\n\ntype Second { id: ID! }\n\ntype Third { id: ID! }\n';
    const saved = await identifyChanges(parseInput(createTwoFilesPatch("/dev/null", "schema.graphql", "", source)));
    // And a longer replacement for only the middle definition
    const changed = source.replace('type Second { id: ID! }', 'type Second {\n  id: ID!\n  name: String!\n}');

    // When the next schema snapshot is matched against the saved approvals
    const current = await identifyChanges(parseInput(createTwoFilesPatch("/dev/null", "schema.graphql", "", changed)));
    const reviewed = current.map((block) => saved.some((entry) => matchesChange(entry, block)));

    // Then only the edited chunk loses approval
    expect(reviewed).toEqual([true, false, true]);
  });

  test("fallback chunks preserve rendered source and line anchors", async () => {
    // Given an added schema rendered without chunking
    const patch = createTwoFilesPatch("/dev/null", "schema.graphql", "", 'type First { id: ID! }\n\ntype Second { id: ID! }\n');
    const original = parsePatchFiles(patch, undefined, true)[0].files[0];
    const before = await new DiffHunksRenderer({ diffStyle: "unified", hunkSeparators: "simple" }).asyncRender(original);

    // When the same source is rendered as separate review chunks
    const after = await new DiffHunksRenderer({ diffStyle: "unified", hunkSeparators: "simple" }).asyncRender(parseInput(patch)[0]);

    // Then only review boundaries change, not the rendered diff or its coordinates
    expect(after.unifiedContentAST).toEqual(before.unifiedContentAST);
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
