import { beforeAll, describe, expect, test } from "bun:test";
import { hydratePartialDiff, type FileDiffMetadata } from "@pierre/diffs";
import { changeStarts, closestDiffLine, lineLocation, nextHunk } from "../src/navigation";
import { parseInput } from "../src/patches";

describe("navigation", () => {
  let files: FileDiffMetadata[];
  beforeAll(async () => {
    files = parseInput(await Bun.file(new URL("../fixtures/graphql-service-9658.diff", import.meta.url)).text());
  });

  test("stops at the start of a review", () => {
    // Given the first hunk of the first file
    const position = { fileIndex: 0, hunkIndex: 0 };

    // When navigating backward
    const next = nextHunk(files, position, -1);

    // Then the position stays at the start
    expect(next).toEqual(position);
  });

  test("stops at the end of a review", () => {
    // Given the last hunk of the last file
    const position = { fileIndex: 1, hunkIndex: changeStarts(files[1]).length - 1 };

    // When navigating forward
    const next = nextHunk(files, position, 1);

    // Then the position stays at the end
    expect(next).toEqual(position);
  });

  test("skips mode-only files when looking for a hunk", () => {
    // Given a mode-only change between two files with text hunks
    const modeOnly = parseInput("diff --git a/script.sh b/script.sh\nold mode 100644\nnew mode 100755\n");
    const review = [files[0], ...modeOnly, files[1]];

    // When advancing from the first file's last hunk
    const next = nextHunk(review, { fileIndex: 0, hunkIndex: changeStarts(files[0]).length - 1 }, 1);

    // Then the next file with a text hunk is selected
    expect(next).toEqual({ fileIndex: 2, hunkIndex: 0 });
  });

  test("separates edits inside one Git hunk and focuses their new code", async () => {
    // Given the demo's three separate edits within a single @@ hunk
    const demo = parseInput(await Bun.file(new URL("../fixtures/demo.diff", import.meta.url)).text());

    // When navigation stops are calculated
    const starts = changeStarts(demo[0]);

    // Then each stop points to the first added row after its deletions
    expect(starts).toEqual([3, 10, 17]);
  });

  test("removal-only changes focus the first deleted row", () => {
    // Given a patch containing only a removed line
    const removed = parseInput("diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1 @@\n const keep = 1;\n-const remove = 2;\n");

    // When navigation stops are calculated
    const starts = changeStarts(removed[0]);

    // Then the deletion itself is the navigation stop
    expect(starts).toEqual([1]);
  });

  test("inline comments use new-file numbers after deleted rows", async () => {
    // Given the demo where unified row 10 is new line 8
    const demo = parseInput(await Bun.file(new URL("../fixtures/demo.diff", import.meta.url)).text());

    // When the focused renderer row is mapped to a GitHub location
    const location = lineLocation(demo[0], 10);

    // Then the new-file coordinate is preserved
    expect(location).toEqual({ path: "src/reviews.ts", line: 8, side: "RIGHT" });
  });

  test("deleted lines map to old-file comment coordinates", async () => {
    // Given a deleted row in the demo
    const demo = parseInput(await Bun.file(new URL("../fixtures/demo.diff", import.meta.url)).text());

    // When its comment location is calculated
    const location = lineLocation(demo[0], 8);

    // Then the old-file coordinate is used
    expect(location).toEqual({ path: "src/reviews.ts", line: 8, side: "LEFT" });
  });

  test("expanded context retains its real new-file line number", () => {
    // Given omitted context before a changed line
    const partial = parseInput("diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -3 +3 @@\n-old\n+new\n")[0];
    const full = hydratePartialDiff("clone", partial, { oldFile: { name: "a.ts", contents: "first\nsecond\nold\nlast\n" }, newFile: { name: "a.ts", contents: "first\nsecond\nnew\nlast\n" } });

    // When a newly revealed context row is selected
    const location = lineLocation(full, 1);

    // Then it maps to the original file rather than a compact patch offset
    expect(location).toEqual({ path: "a.ts", line: 2, side: "RIGHT" });
  });

  test("approximate navigation keeps a line included in a current hunk", () => {
    // Given an outdated coordinate that still falls inside the patch
    const file = parseInput("diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -10,3 +10,3 @@\n before\n-old\n+new\n after\n")[0];

    // When locating the closest current line
    const location = closestDiffLine(file, { path: "a.ts", line: 11, side: "RIGHT" });

    // Then the same coordinate is used as a best-effort destination
    expect(location).toEqual({ path: "a.ts", line: 11, side: "RIGHT" });
  });

  test("approximate navigation chooses the nearest hunk across omitted context", () => {
    // Given an outdated line between two current hunks
    const file = parseInput("diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -10 +10 @@\n-old first\n+new first\n@@ -45 +45 @@\n-old last\n+new last\n")[0];

    // When locating a nearby destination
    const location = closestDiffLine(file, { path: "a.ts", line: 42, side: "RIGHT" });

    // Then navigation clamps to the nearer hunk rather than loading unchanged source
    expect(location).toEqual({ path: "a.ts", line: 45, side: "RIGHT" });
  });

  test("approximate navigation clamps beyond EOF on the original side", () => {
    // Given an outdated deletion coordinate beyond the current file's hunks
    const file = parseInput("diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -10,2 +20 @@\n-old first\n-old last\n+new\n")[0];

    // When locating its nearest old-side destination
    const location = closestDiffLine(file, { path: "a.ts", line: 100, side: "LEFT" });

    // Then the last deletion is used rather than the unrelated new-side number
    expect(location).toEqual({ path: "a.ts", line: 11, side: "LEFT" });
  });

  test("approximate navigation falls back to the available side of a deleted file", () => {
    // Given a deleted file with no new-side lines
    const file = parseInput("diff --git a/a.ts b/a.ts\ndeleted file mode 100644\n--- a/a.ts\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-first\n-last\n")[0];

    // When an outdated new-side coordinate is used
    const location = closestDiffLine(file, { path: "a.ts", line: 2, side: "RIGHT" });

    // Then the remaining old-side line is a usable destination
    expect(location).toEqual({ path: "a.ts", line: 2, side: "LEFT" });
  });

  test("approximate navigation leaves hunkless files without a line target", () => {
    // Given a mode-only file still present in the review
    const file = parseInput("diff --git a/script.sh b/script.sh\nold mode 100644\nnew mode 100755\n")[0];

    // When resolving its outdated comment coordinate
    const location = closestDiffLine(file, { path: "script.sh", line: 50, side: "RIGHT" });

    // Then the caller can open just the file without requesting an invalid line
    expect(location).toBeUndefined();
  });
});
