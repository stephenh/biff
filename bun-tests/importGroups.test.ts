import { describe, expect, test } from "bun:test";
import { findImportGroups } from "../src/importGroups";
import { parseInput } from "../src/patches";

describe("importGroups", () => {
  test("multiple import edits and unchanged imports form one stanza", () => {
    // Given added, unchanged, deleted, replacement, and changed imports before business code
    const file = patchFile('@@ -1,5 +1,6 @@\n+import { Added } from "added";\n import { Unchanged } from "unchanged";\n-import { Removed } from "removed";\n+import { Replacement } from "replacement";\n import { Last } from "last";\n-import { Before } from "changed";\n+import { After } from "changed";\n const body = true;\n');

    // When import stanzas are classified
    const groups = findImportGroups(file);

    // Then all five changed import lines share one fold, excluding business code
    expect(groups).toMatchObject([{ start: 0, end: 6, changes: 5 }]);
  });

  test("multiline import specifier edits include their unchanged declaration boundaries", () => {
    // Given one changed specifier within a multiline import
    const file = patchFile('@@ -1,4 +1,4 @@\n import {\n-  Before,\n+  After,\n } from "module";\n const body = true;\n');

    // When import stanzas are classified
    const groups = findImportGroups(file);

    // Then the fold includes the complete declaration and both changed specifiers
    expect(groups).toMatchObject([{ start: 0, end: 3, changes: 2 }]);
  });

  test("type-only, side-effect, and TypeScript require imports are recognized", () => {
    // Given TypeScript's supported static import forms
    const file = patchFile('@@ -1 +1,3 @@\n-import Old from "old";\n+import type { Shape } from "types";\n+import "setup";\n+import Legacy = require("legacy");\n');

    // When import stanzas are classified
    const groups = findImportGroups(file);

    // Then all static import forms belong to one group
    expect(groups).toMatchObject([{ start: 0, end: 3, changes: 4 }]);
  });

  test("changed business code separates import groups within the same hunk", () => {
    // Given imports on both sides of a changed statement
    const file = patchFile('@@ -1,3 +1,3 @@\n-import A from "a";\n+import A2 from "a";\n-const business = 1;\n+const business = 2;\n-import B from "b";\n+import B2 from "b";\n');

    // When import stanzas are classified
    const groups = findImportGroups(file);

    // Then old and new business rows remain outside every fold in unified order
    expect(groups).toMatchObject([{ start: 0, end: 0, changes: 1 }, { start: 2, end: 3, changes: 2 }, { start: 5, end: 5, changes: 1 }]);
  });

  test("dynamic imports and strings containing import syntax remain visible", () => {
    // Given executable code rather than static import declarations
    const file = patchFile('@@ -1,2 +1,2 @@\n-const module = import("before");\n+const module = import("after");\n-const example = "import X from x";\n+const example = "import Y from y";\n');

    // When import stanzas are classified
    const groups = findImportGroups(file);

    // Then these statements are not folded
    expect(groups).toEqual([]);
  });

  test("full source identifies a multiline import whose opening is missing from the patch", () => {
    // Given a patch with only a specifier and the end of its declaration
    const file = patchFile('@@ -2,2 +2,2 @@\n-  Before,\n+  After,\n } from "module";\n');
    // And the complete sources prove those lines belong to an import
    const contents = { oldFile: { name: file.name, contents: 'import {\n  Before,\n} from "module";\n' }, newFile: { name: file.name, contents: 'import {\n  After,\n} from "module";\n' } };

    // When the complete sources are available
    const groups = findImportGroups(file, contents);

    // Then the fragment can fold together with its native leading context separator
    expect(groups).toMatchObject([{ start: 0, end: 3, changes: 2, leading: true }]);
  });

  test("unknown gaps between hunks are not assumed to contain only imports", () => {
    // Given two import changes separated by omitted source
    const file = patchFile('@@ -1 +1 @@\n-import A from "a";\n+import A2 from "a";\n@@ -10 +10 @@\n-import B from "b";\n+import B2 from "b";\n');

    // When only the patch is available
    const groups = findImportGroups(file);

    // Then the unknown gap remains a boundary
    expect(groups).toMatchObject([{ start: 0, end: 1 }, { start: 10, end: 11 }]);
  });

  test("full source joins import edits across omitted unchanged imports", () => {
    // Given two hunks separated by eight unchanged imports
    const file = patchFile('@@ -1 +1 @@\n-import A from "a";\n+import A2 from "a";\n@@ -10 +10 @@\n-import B from "b";\n+import B2 from "b";\n');
    const middle = Array.from({ length: 8 }, (_, index) => `import I${index} from "i${index}";`).join("\n");
    // And complete sources establish what the gap contains
    const contents = { oldFile: { name: file.name, contents: `import A from "a";\n${middle}\nimport B from "b";` }, newFile: { name: file.name, contents: `import A2 from "a";\n${middle}\nimport B2 from "b";` } };

    // When import stanzas are classified against those sources
    const groups = findImportGroups(file, contents);

    // Then all edits share one fold across the native unchanged gap
    expect(groups).toMatchObject([{ start: 0, end: 11, changes: 4 }]);
  });

  test("full source never joins imports across unchanged business code", () => {
    // Given two import edits surrounding an omitted business statement
    const file = patchFile('@@ -1 +1 @@\n-import A from "a";\n+import A2 from "a";\n@@ -3 +3 @@\n-import B from "b";\n+import B2 from "b";\n');
    const contents = { oldFile: { name: file.name, contents: 'import A from "a";\nconst business = 1;\nimport B from "b";' }, newFile: { name: file.name, contents: 'import A2 from "a";\nconst business = 1;\nimport B2 from "b";' } };

    // When import stanzas are classified
    const groups = findImportGroups(file, contents);

    // Then the business statement prevents merging
    expect(groups).toMatchObject([{ start: 0, end: 1 }, { start: 3, end: 4 }]);
  });

  test("an incomplete import fragment stays visible until its source is known", () => {
    // Given the opening of a multiline import is missing
    const file = patchFile('@@ -2,2 +2,2 @@\n-  Before,\n+  After,\n } from "module";\n');

    // When no full source can confirm the declaration
    const groups = findImportGroups(file);

    // Then uncertain lines remain visible
    expect(groups).toEqual([]);
  });
});

/** Build a TypeScript patch while keeping each scenario's actual hunk text visible. */
function patchFile(body: string) {
  return parseInput(`diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n${body}`)[0];
}
