import { describe, expect, test } from "bun:test";
import { matchingChangedLines } from "../src/movedLines";
import { parseInput } from "../src/patches";

describe("movedLines", () => {
  test("the deleted and added copies of a long line match across indentation changes", () => {
    // Given unchanged code relocated past two context lines
    const file = parseInput("diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n@@ -1,3 +1,3 @@\n-const movedValue = 123;\n const firstContext = 1;\n const secondContext = 2;\n+  const movedValue = 123;\n")[0];

    // When changed lines are compared
    const indices = matchingChangedLines(file);

    // Then only the new location is highlighted, leaving the deletion and context unchanged
    expect([...indices]).toEqual([3]);
  });

  test("short punctuation does not match even with more than ten spaces of indentation", () => {
    // Given an indented brace deleted and added elsewhere
    const file = parseInput("diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n@@ -1,2 +1,2 @@\n-                {\n const context = 1;\n+  {\n")[0];

    // When changed lines are compared
    const indices = matchingChangedLines(file);

    // Then padding cannot make a short line qualify
    expect([...indices]).toEqual([]);
  });

  test("a new copy of unchanged context is not treated as deleted-and-added text", () => {
    // Given a repeated long line that was not deleted
    const file = parseInput("diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n@@ -1 +1,2 @@\n const repeatedValue = 123;\n+const repeatedValue = 123;\n")[0];

    // When changed lines are compared
    const indices = matchingChangedLines(file);

    // Then the new copy retains its normal addition color
    expect([...indices]).toEqual([]);
  });

  test("edited long lines do not match merely because both sides are long", () => {
    // Given an actual value change
    const file = parseInput("diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-const changedValue = 123;\n+const changedValue = 456;\n")[0];

    // When changed lines are compared
    const indices = matchingChangedLines(file);

    // Then the changed text retains its normal deletion and addition colors
    expect([...indices]).toEqual([]);
  });
});
