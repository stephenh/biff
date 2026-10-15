import { describe, expect, test } from "bun:test";
import { parseInput } from "../src/patches";

describe("patches", () => {
  test("loads every file from a multi-file patch in source order", async () => {
    // Given the bundled TypeScript, GraphQL, and JSON patch
    const patch = await Bun.file(new URL("../fixtures/demo.diff", import.meta.url)).text();

    // When the patch is opened
    const files = parseInput(patch);

    // Then the file picker receives every changed file in source order
    expect(files.map((file) => file.name)).toEqual(["src/reviews.ts", "schema/review.graphql", "settings.json"]);
  });

  test("rejects ordinary text instead of opening an empty review", () => {
    // Given content without any file changes
    const patch = "These are review notes, not a patch.";

    // When the content is opened
    function openPatch() { return parseInput(patch); }

    // Then the user gets an actionable error
    expect(openPatch).toThrow("No file changes found. Open a Git-style unified .diff or .patch file.");
  });

  test("rejects a truncated hunk rather than silently losing changes", async () => {
    // Given a valid patch truncated halfway through its first hunk
    const patch = await Bun.file(new URL("../fixtures/demo.diff", import.meta.url)).text();
    const truncated = patch.split("\n").slice(0, 9).join("\n");

    // When the truncated patch is opened
    function openPatch() { return parseInput(truncated); }

    // Then parsing fails instead of returning a partial review
    expect(openPatch).toThrow();
  });
});
