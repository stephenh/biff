import { describe, expect, test } from "bun:test";
import { createTwoFilesPatch } from "diff";
import { fileSearchMatches } from "../src/fileSearchMatches";
import { parseInput } from "../src/patches";

describe("fileSearch", () => {
  test("counts each literal, case-sensitive occurrence without interpreting punctuation", () => {
    // Given a line containing repeated symbols and a differently cased name
    const file = parseInput(createTwoFilesPatch("/dev/null", "file.ts", "", 'use($foo, $foo, $Foo);\n'))[0];

    // When searching for the exact symbol
    const matches = fileSearchMatches(file, "$foo");

    // Then both occurrences retain their own column offsets
    expect(matches).toMatchObject([{ line: 1, side: "RIGHT", start: 4, end: 8 }, { line: 1, side: "RIGHT", start: 10, end: 14 }]);
  });

  test("includes removed uses and does not duplicate unchanged context", () => {
    // Given a replacement next to an unchanged use of the same variable
    const file = parseInput(createTwoFilesPatch("file.ts", "file.ts", 'use(foo);\nold(foo);\n', 'use(foo);\nnext(foo);\n'))[0];

    // When searching the file's patch lines
    const matches = fileSearchMatches(file, "foo");

    // Then unchanged context appears once and each changed side remains addressable
    expect(matches).toMatchObject([{ line: 1, side: "RIGHT" }, { line: 2, side: "LEFT" }, { line: 2, side: "RIGHT" }]);
  });

  test("full source includes omitted uses without duplicating visible additions", () => {
    // Given a use outside a zero-context patch
    const oldSource = 'const foo = 1;\nkeep();\nreturn 0;\n';
    const newSource = oldSource.replace("return 0", "return foo");
    const file = parseInput(createTwoFilesPatch("file.ts", "file.ts", oldSource, newSource, undefined, undefined, { context: 0 }))[0];
    // And full old and new sources are available
    const contents = { oldFile: { name: "file.ts", contents: oldSource }, newFile: { name: "file.ts", contents: newSource } };

    // When searching both the patch and full new source
    const matches = fileSearchMatches(file, "foo", contents);

    // Then both uses appear once, with the omitted one marked for context expansion
    expect(matches).toMatchObject([{ line: 1, side: "RIGHT", hidden: true }, { line: 3, side: "RIGHT", hidden: false }]);
  });

  test("an empty query produces no matches", () => {
    // Given a file with searchable content
    const file = parseInput(createTwoFilesPatch("/dev/null", "file.ts", "", 'use(foo);\n'))[0];

    // When the query is empty
    const matches = fileSearchMatches(file, "");

    // Then there are no empty-text occurrences
    expect(matches).toEqual([]);
  });
});
