import { describe, expect, test } from "bun:test";
import { createTwoFilesPatch } from "diff";
import { parseInput } from "../src/patches";
import { selectedSourceText, textPointIndex } from "../src/selectedSourceText";
import { lineLocation } from "../src/navigation";

describe("selectedSourceText", () => {
  test("copies inclusive word boundaries with original indentation and line breaks", () => {
    // Given new code with an intervening blank line
    const [file] = parseInput(createTwoFilesPatch("file.ts", "file.ts", "", "  const alpha = 1;\n\n  const omega = 2;\n"));
    // When copying from alpha through omega
    const text = selectedSourceText(file, { line: 1, side: "RIGHT", column: 8 }, { line: 3, side: "RIGHT", column: 13 });
    // Then only endpoint indentation is sliced away
    expect(text).toEqual("alpha = 1;\n\n  const omega");
  });

  test("normalizes a backward range within one row", () => {
    // Given one added row
    const [file] = parseInput(createTwoFilesPatch("file.ts", "file.ts", "", "const alpha = omega;\n"));
    // When the second word is the anchor
    const text = selectedSourceText(file, { line: 1, side: "RIGHT", column: 19 }, { line: 1, side: "RIGHT", column: 6 });
    // Then the same forward source text is copied
    expect(text).toEqual("alpha = omega");
  });

  test("new-side copying excludes replacement deletions", () => {
    // Given a replacement between unchanged endpoints
    const [file] = parseInput(createTwoFilesPatch("file.ts", "file.ts", "const alpha = 1;\nconst removed = 2;\nconst omega = 3;\n", "const alpha = 1;\nconst replacement = 2;\nconst omega = 3;\n"));
    // When both endpoints are in the new revision
    const text = selectedSourceText(file, { line: 1, side: "RIGHT", column: 6 }, { line: 3, side: "RIGHT", column: 11 });
    // Then old code is not mixed into the copied snippet
    expect(text).toEqual("alpha = 1;\nconst replacement = 2;\nconst omega");
  });

  test("old-side copying retains old context coordinates", () => {
    // Given an unequal replacement followed by unchanged context
    const [file] = parseInput(createTwoFilesPatch("file.ts", "file.ts", "const removed = 1;\nconst omega = 2;\n", "const first = 1;\nconst second = 2;\nconst omega = 2;\n"));
    // When copying from old code into its following context
    const text = selectedSourceText(file, { line: 1, side: "LEFT", column: 6 }, { line: 2, side: "LEFT", column: 11 });
    // Then the old revision is copied without additions
    expect(text).toEqual("removed = 1;\nconst omega");
  });

  test("cross-revision endpoints copy unified display order", () => {
    // Given removed and added rows
    const [file] = parseInput(createTwoFilesPatch("file.ts", "file.ts", "const removed = 1;\n", "const replacement = 2;\n"));
    // When the range crosses from old to new code
    const text = selectedSourceText(file, { line: 1, side: "LEFT", column: 6 }, { line: 1, side: "RIGHT", column: 17 });
    // Then both revisions appear in their displayed order
    expect(text).toEqual("removed = 1;\nconst replacement");
  });

  test("refuses to claim a complete copy across omitted partial-patch context", () => {
    // Given distant edits whose intervening source is unavailable
    const original = Array.from({ length: 30 }, (_, index) => `line ${index}\n`).join("");
    const changed = original.replace("line 0\n", "first\n").replace("line 29\n", "last\n");
    const [file] = parseInput(createTwoFilesPatch("file.ts", "file.ts", original, changed));
    // When a range crosses the omitted lines
    // Then the caller gets an actionable error instead of an incomplete clipboard
    expect(() => selectedSourceText(file, { line: 1, side: "RIGHT", column: 0 }, { line: 30, side: "RIGHT", column: 4 })).toThrow("Cannot copy omitted source lines. Show unmodified lines first.");
  });

  test("source-to-renderer coordinates round-trip through unequal replacements", () => {
    // Given old and new rows with different counts
    const [file] = parseInput(createTwoFilesPatch("file.ts", "file.ts", "before\nold\nafter\n", "before\nfirst\nsecond\nafter\n"));
    // When each displayed source coordinate is mapped back to its renderer index
    const indexes = Array.from({ length: file.unifiedLineCount }, (_, index) => textPointIndex(file, { ...lineLocation(file, index)!, column: 0 }));
    // Then no old/new coordinate aliases a different row
    expect(indexes).toEqual([0, 1, 2, 3, 4]);
  });
});
