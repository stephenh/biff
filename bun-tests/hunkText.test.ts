import { describe, expect, test } from "bun:test";
import { parsePatchFiles } from "@pierre/diffs";
import { identifyChanges, identifyMetadata } from "../shared/changeProgress";
import { captureHunkTexts } from "../shared/hunkText";
import { splitSemanticChanges } from "../shared/semanticChanges";

describe("hunkText", () => {
  test("captures a replacement without surrounding context", async () => {
    // Given a replacement between unchanged lines
    const patch = textPatch("@@ -10,3 +20,3 @@\n context\n-old\n+new\n tail\n");
    // When capturing the parsed changes
    const texts = await capture(patch);
    // Then only the changed text and its actual coordinates are retained
    expect(texts).toEqual([{ diffText: "-old\n+new\n", oldLine: 11, newLine: 21 }]);
  });

  test("uses the old-side insertion point inside a context-bearing hunk", async () => {
    // Given an insertion between two unchanged lines
    const patch = textPatch("@@ -10,2 +20,3 @@\n context\n+added\n tail\n");
    // When capturing the insertion
    const texts = await capture(patch);
    // Then the empty old-side range points after the preceding line
    expect(texts).toEqual([{ diffText: "+added\n", oldLine: 10, newLine: 21 }]);
  });

  test("uses the new-side deletion point inside a context-bearing hunk", async () => {
    // Given a deletion between two unchanged lines
    const patch = textPatch("@@ -10,3 +20,2 @@\n context\n-removed\n tail\n");
    // When capturing the deletion
    const texts = await capture(patch);
    // Then the empty new-side range points after the preceding line
    expect(texts).toEqual([{ diffText: "-removed\n", oldLine: 11, newLine: 20 }]);
  });

  test("preserves a zero-context deletion's empty-side coordinate", async () => {
    // Given deleted lines after new line 5
    const patch = textPatch("@@ -6,2 +5,0 @@\n-one\n-two\n");
    // When capturing the deletion
    const texts = await capture(patch);
    // Then the already-correct empty-side coordinate is not decremented
    expect(texts).toEqual([{ diffText: "-one\n-two\n", oldLine: 6, newLine: 5 }]);
  });

  test("keeps changes matched across context, hunks, and files", async () => {
    // Given multiple changes and a second file whose unified row indexes restart
    const patch = textPatch("@@ -1,3 +1,3 @@\n-a\n+A\n context\n-b\n+B\n@@ -20 +20 @@\n-c\n+C\n")
      + textPatch("@@ -1 +1 @@\n-d\n+D\n", "second.ts");
    // When capturing all changes
    const texts = await capture(patch);
    // Then each block receives its own source text and position
    expect(texts).toEqual([
      { diffText: "-a\n+A\n", oldLine: 1, newLine: 1 },
      { diffText: "-b\n+B\n", oldLine: 3, newLine: 3 },
      { diffText: "-c\n+C\n", oldLine: 20, newLine: 20 },
      { diffText: "-d\n+D\n", oldLine: 1, newLine: 1 },
    ]);
  });

  test("captures blank-line-separated additions as separate semantic edits", async () => {
    // Given two inserted paragraphs within unchanged context
    const patch = textPatch("@@ -5,2 +5,5 @@\n context\n+first\n+\n+second\n tail\n");
    // When production semantic splitting precedes capture
    const texts = await capture(patch);
    // Then the blank separator stays attached to the first edit
    expect(texts).toEqual([
      { diffText: "+first\n+\n", oldLine: 5, newLine: 6 },
      { diffText: "+second\n", oldLine: 5, newLine: 8 },
    ]);
  });

  test("captures blank-line-separated deletions as separate semantic edits", async () => {
    // Given two removed paragraphs within unchanged context
    const patch = textPatch("@@ -5,5 +5,2 @@\n context\n-first\n-\n-second\n tail\n");
    // When production semantic splitting precedes capture
    const texts = await capture(patch);
    // Then both edits share the same empty new-side insertion point
    expect(texts).toEqual([
      { diffText: "-first\n-\n", oldLine: 6, newLine: 5 },
      { diffText: "-second\n", oldLine: 8, newLine: 5 },
    ]);
  });

  test("captures absent final newlines on both sides", async () => {
    // Given old and new source that both end without a newline
    const patch = textPatch("@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n");
    // When capturing source text from the parser
    const texts = await capture(patch);
    // Then both missing-newline markers survive capture
    expect(texts).toEqual([{ diffText: "-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n", oldLine: 1, newLine: 1 }]);
  });

  test("does not add a missing-newline marker to the other side", async () => {
    // Given only the new source lacks its final newline
    const patch = textPatch("@@ -1 +1 @@\n-old\n+new\n\\ No newline at end of file\n");
    // When capturing the replacement
    const texts = await capture(patch);
    // Then the old source retains its normal newline
    expect(texts).toEqual([{ diffText: "-old\n+new\n\\ No newline at end of file\n", oldLine: 1, newLine: 1 }]);
  });

  test("preserves tabs and trailing spaces in captured text", async () => {
    // Given whitespace-sensitive source changes
    const patch = textPatch("@@ -1 +1 @@\n-\told  \n+\tnew \t\n");
    // When capturing the replacement
    const texts = await capture(patch);
    // Then capture does not normalize source whitespace
    expect(texts).toEqual([{ diffText: "-\told  \n+\tnew \t\n", oldLine: 1, newLine: 1 }]);
  });

  test("captures a rename-only change", async () => {
    // Given a file renamed without text changes
    const patch = "diff --git a/old.ts b/new.ts\nsimilarity index 100%\nrename from old.ts\nrename to new.ts\n";
    // When capturing metadata identities
    const texts = await capture(patch);
    // Then the rename is retained independently of source coordinates
    expect(texts).toEqual([{ diffText: "rename from old.ts\nrename to new.ts\n", oldLine: 0, newLine: 0 }]);
  });

  test("captures executable-mode changes", async () => {
    // Given a file made executable without text changes
    const patch = "diff --git a/script.sh b/script.sh\nold mode 100644\nnew mode 100755\n";
    // When capturing metadata identities
    const texts = await capture(patch);
    // Then both modes are retained
    expect(texts).toEqual([{ diffText: "old mode 100644\nnew mode 100755\n", oldLine: 0, newLine: 0 }]);
  });

  test("captures an empty new file's metadata and blob identity", async () => {
    // Given a newly added empty file
    const patch = "diff --git a/empty.ts b/empty.ts\nnew file mode 100644\nindex 0000000..e69de29\n";
    // When capturing metadata identities
    const texts = await capture(patch);
    // Then file creation remains representable without text hunks
    expect(texts).toEqual([{ diffText: "new file mode 100644\nindex 0000000..e69de29\n", oldLine: 0, newLine: 0 }]);
  });

  test("captures an empty deleted file's metadata and blob identity", async () => {
    // Given a deleted empty file
    const patch = "diff --git a/empty.ts b/empty.ts\ndeleted file mode 100644\nindex e69de29..0000000\n";
    // When capturing metadata identities
    const texts = await capture(patch);
    // Then file deletion remains representable without text hunks
    expect(texts).toEqual([{ diffText: "deleted file mode 100644\nindex e69de29..0000000\n", oldLine: 0, newLine: 0 }]);
  });
});

/** Exercise the production parser, semantic boundaries, and identity matching before capture. */
async function capture(patch: string) {
  const files = splitSemanticChanges(parsePatchFiles(patch, undefined, true).flatMap((entry) => entry.files));
  const blocks = await identifyChanges(files);
  const metadata = await identifyMetadata(files, "head");
  const texts = captureHunkTexts(files, blocks, metadata);
  return [...blocks, ...metadata].map((unit) => texts.get(unit));
}

/** Wrap real unified hunk text in a regular file patch. */
function textPatch(hunks: string, path = "example.ts"): string {
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${hunks}`;
}
