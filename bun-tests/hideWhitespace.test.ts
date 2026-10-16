import { describe, expect, test } from "bun:test";
import { hideWhitespace } from "../shared/hideWhitespace";
import { parseInput } from "../src/patches";
import { lineLocation } from "../src/navigation";

const header = "diff --git a/file.ts b/file.ts\nindex 1234567..abcdef0 100644\n--- a/file.ts\n+++ b/file.ts\n";

describe("hideWhitespace", () => {
  test("drops a file with only indentation and spacing changes", () => {
    // Given changes to indentation, internal spaces, tabs, and trailing whitespace
    const patch = header + "@@ -1,2 +1,2 @@\n-  const first = 1;\n-\tconst second=2;  \n+const first=1;\n+const second = 2;\n";

    // When whitespace is hidden
    const result = hideWhitespace(patch);

    // Then the file contributes no changes to the review
    expect(result).toBe("");
  });

  test("keeps real edits in a replacement block with whitespace-only edits", () => {
    // Given a formatting edit beside a value change and insertion
    const patch = header + "@@ -1,3 +1,4 @@\n-  const first = 1;\n-const value = 1;\n+const first=1;\n+const value = 2;\n+const added = 3;\n tail\n";

    // When whitespace is hidden
    const result = hideWhitespace(patch);

    // Then formatting becomes context without altering hunk coordinates
    expect(result).toBe(header + "@@ -1,3 +1,4 @@\n const first=1;\n-const value = 1;\n+const value = 2;\n+const added = 3;\n tail\n");
  });

  test("removed whitespace hunks do not shift GitHub comment coordinates", () => {
    // Given a whitespace-only hunk before a real edit farther down the file
    const patch = header + "@@ -1 +1 @@\n- first\n+first\n@@ -20 +20 @@\n-old\n+new\n";

    // When the filtered patch is mapped to a comment location
    const file = parseInput(patch)[0];
    const location = lineLocation(file, file.hunks[0].unifiedLineStart + 1);

    // Then the comment still targets new-file line 20
    expect(location).toEqual({ path: "file.ts", line: 20, side: "RIGHT" });
  });

  test("preserves renamed files even when their edits are only whitespace", () => {
    // Given a rename accompanied by reformatting
    const metadata = "diff --git a/old.ts b/new.ts\nsimilarity index 90%\nrename from old.ts\nrename to new.ts\n--- a/old.ts\n+++ b/new.ts\n";
    const patch = metadata + "@@ -1 +1 @@\n-old ()\n+old()\n";

    // When whitespace is hidden
    const result = hideWhitespace(patch);

    // Then the rename is still shown
    expect(result).toBe(metadata);
  });

  test("preserves EOF newline changes", () => {
    // Given identical text with a newly added final newline
    const patch = header + "@@ -1 +1 @@\n-same\n\\ No newline at end of file\n+same\n";

    // When whitespace is hidden
    const result = hideWhitespace(patch);

    // Then the newline edit remains a real line-ending change
    expect(result).toBe(patch);
  });
});
