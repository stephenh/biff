import { describe, expect, test } from "bun:test";
import { fileRouteNames, reviewFileRoute } from "../src/fileRoute";

describe("fileRoute", () => {
  test("unique basenames do not include their directories", () => {
    // Given files in different directories
    const files = [{ name: "src/Viewer.tsx" }, { name: "tests/viewer.test.ts" }];

    // When their route names are assigned
    const names = fileRouteNames(files);

    // Then each name is just the basename
    expect(names).toEqual(["Viewer.tsx", "viewer.test.ts"]);
  });

  test("duplicate names use full-path order rather than display order", () => {
    // Given duplicate names displayed in reverse path order
    const files = [{ name: "server/foo.ts" }, { name: "client/foo.ts" }];

    // When their route names are assigned
    const names = fileRouteNames(files);

    // Then suffixes follow sorted full paths
    expect(names).toEqual(["foo.ts-2", "foo.ts-1"]);
  });

  test("generated suffixes cannot shadow real basenames", () => {
    // Given a real file named like a generated duplicate
    const files = [{ name: "client/foo.ts" }, { name: "server/foo.ts" }, { name: "foo.ts-1" }];

    // When their route names are assigned
    const names = fileRouteNames(files);

    // Then all three names remain unambiguous
    expect(names).toEqual(["foo.ts-2", "foo.ts-3", "foo.ts-1"]);
  });

  test("encoded filenames are decoded exactly once", () => {
    // Given a filename containing spaces, Unicode, and a literal percent escape
    const pathname = `/workspaces/project/f/${encodeURIComponent("café %20.ts")}`;

    // When its route is read
    const route = reviewFileRoute(pathname);

    // Then the filename is preserved without double decoding
    expect(route).toEqual({ base: "/workspaces/project", file: "café %20.ts" });
  });

  test("existing PR URLs still identify a review without a file", () => {
    // Given a PR URL without a file suffix
    const pathname = "/pr/example/project/12";

    // When its route is read
    const route = reviewFileRoute(pathname);

    // Then file selection remains optional
    expect(route).toEqual({ base: pathname, file: undefined });
  });
});
