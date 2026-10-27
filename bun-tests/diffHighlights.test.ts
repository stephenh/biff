import { describe, expect, test } from "bun:test";
import { DiffHunksRenderer, getHighlighterType, type HunksRenderResult } from "@pierre/diffs";
import { createTwoFilesPatch } from "diff";
import { diffHighlightOptions } from "../src/diffHighlights";
import { parseInput } from "../src/patches";

type DiffNode = NonNullable<HunksRenderResult["unifiedContentAST"]>[number];

describe("diffHighlights", () => {
  test("renderer tests use the browser's Highlights backend", () => {
    // Given the shared highlighter initialized by the test preload
    // When Pierre reports its active backend
    const backend = getHighlighterType();

    // Then an earlier renderer cannot silently make these tests exercise Shiki
    expect(backend).toBe("highlights");
  });

  test.each([
    ["schema.graphql", 'type Query { user(id: ID!): User }\n# Find a user\n'],
    ["README.md", '# Heading\nA **bold** word and `code`.\n'],
    ["model.ts", 'export const count: number = 42; // count\n'],
    ["view.tsx", 'export function View() { return <button title="Save">Save</button>; }\n'],
  ])("%s gets syntax colors through the diff renderer", async (name, source) => {
    // Given a file with syntax that must not fall back to plain text
    const [file] = parseInput(createTwoFilesPatch("/dev/null", name, "", source));

    // When the same backend and theme as the reading panes render it
    const result = await new DiffHunksRenderer({ ...diffHighlightOptions, diffStyle: "unified" }).asyncRender(file);
    const styles = new Set((result.unifiedContentAST ?? []).flatMap(syntaxStyles));

    // Then the file contains distinct syntax colors, not just a diff background
    expect(styles.size).toBeGreaterThan(1);
  });
});

/** Ignore row and separator styling; syntax colors belong to inline spans. */
function syntaxStyles(node: DiffNode): string[] {
  if (node.type !== "element") return [];
  const style = node.properties.style;
  if (node.tagName === "span" && typeof style === "string" && style.includes("color:")) return [style];
  return node.children.flatMap(syntaxStyles);
}
