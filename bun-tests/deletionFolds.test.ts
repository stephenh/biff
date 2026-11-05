import { describe, expect, test } from "bun:test";
import { createTwoFilesPatch } from "diff";
import { deletionFolds, revealedDeletions } from "../src/deletionFolds";
import { importGroups } from "../src/importFolds";
import { parseInput } from "../src/patches";

describe("deletionFolds", () => {
  test("standalone deletions do not become folds", () => {
    // Given a deletion-only block
    const file = parseInput(createTwoFilesPatch("file.ts", "file.ts", "const removed = 1;\n", ""))[0];
    // When replacement folds are resolved
    const folds = deletionFolds(file, []);
    // Then the deletion remains ordinary source
    expect(folds).toEqual([]);
  });

  test("fold counts come from complete metadata", () => {
    // Given a replacement much larger than a virtual window
    const oldSource = Array.from({ length: 105 }, (_, index) => `const old${index} = ${index};\n`).join("");
    const file = parseInput(createTwoFilesPatch("file.ts", "file.ts", oldSource, "const replacement = 1;\n"))[0];
    // When its deletion is folded
    const folds = deletionFolds(file, []);
    // Then the fold covers every old row with a stable source identity
    expect(folds).toEqual([{ id: "deletion:1", start: 0, end: 104, oldLine: 1, newLine: 1, label: "105 deleted lines", expanded: false, kind: "deletion" }]);
  });

  test("import folds take precedence over overlapping replacement deletions", () => {
    // Given imports and business code replaced in one continuous change
    const file = parseInput(createTwoFilesPatch("file.ts", "file.ts", 'import Old from "old";\nconst body = 1;\n', 'import New from "new";\nconst body = 2;\n'))[0];
    // When deletions are resolved alongside the import fold
    const folds = deletionFolds(file, importGroups(file));
    // Then only the business deletion receives a separate strip
    expect(folds).toEqual([{ id: "deletion:2", start: 1, end: 1, oldLine: 2, newLine: 1, label: "1 deleted line", expanded: false, kind: "deletion" }]);
  });

  test("nearby expansion includes complete blocks outside the mounted window", () => {
    // Given nine replacements whose middle deletion is selected
    const oldSource = Array.from({ length: 9 }, (_, index) => `const old${index} = 0;\nconst keep${index} = 1;\n`).join("");
    const newSource = oldSource.replaceAll("old", "new");
    const file = parseInput(createTwoFilesPatch("file.ts", "file.ts", oldSource, newSource))[0];
    // When nearby deletions are resolved without any DOM
    const expanded = revealedDeletions(deletionFolds(file, []), { path: "file.ts", line: 9, side: "LEFT" });
    // Then the current deletion and three complete blocks on each side are included
    expect([...expanded].sort()).toEqual(["deletion:11", "deletion:13", "deletion:15", "deletion:3", "deletion:5", "deletion:7", "deletion:9"]);
  });
});
