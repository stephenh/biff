import { beforeAll, describe, expect, test } from "bun:test";
import type { FileDiffMetadata } from "@pierre/diffs";
import { changeStarts, lineLocation, nextHunk } from "../src/navigation";
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
});
