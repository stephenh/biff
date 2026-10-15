import { describe, expect, test } from "bun:test";
import { groupFiles } from "../src/fileOrder";

describe("fileOrder", () => {
  test("groups companions after their source in reading order", () => {
    // Given companions interleaved with other changed files
    const files = ["src/Foo.graphql", "src/Foo.stories.ts", "src/Other.ts", "src/Foo.test.ts", "src/Foo.ts"].map((name) => ({ name }));

    // When the flat review list is grouped
    const result = groupFiles(files);

    // Then the source leads its indented tests, stories, and GraphQL document
    expect(result).toEqual([
      { file: { name: "src/Other.ts" }, child: false },
      { file: { name: "src/Foo.ts" }, child: false },
      { file: { name: "src/Foo.test.ts" }, child: true },
      { file: { name: "src/Foo.stories.ts" }, child: true },
      { file: { name: "src/Foo.graphql" }, child: true },
    ]);
  });

  test("unmatched companions stay top-level instead of joining another directory", () => {
    // Given matching basenames in different directories
    const files = [{ name: "a/Foo.test.ts" }, { name: "b/Foo.ts" }];

    // When the review is grouped
    const result = groupFiles(files);

    // Then both remain top-level in their original order
    expect(result).toEqual(files.map((file) => ({ file, child: false })));
  });

  test("React sources can own tests and stories with different extensions", () => {
    // Given a TSX component with TS tests
    const files = [{ name: "Foo.spec.ts" }, { name: "Foo.tsx" }, { name: "Foo.stories.tsx" }];

    // When the review is grouped
    const result = groupFiles(files);

    // Then both companions follow the component
    expect(result).toEqual([{ file: files[1], child: false }, { file: files[0], child: true }, { file: files[2], child: true }]);
  });
});
