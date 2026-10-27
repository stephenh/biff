import { describe, expect, test } from "bun:test";
import { DiffHunksRenderer, type HunksRenderResult } from "@pierre/diffs";
import { syntaxContextFixture } from "../fixtures/syntaxContext";
import { diffHighlightOptions } from "../src/diffHighlights";
import { fullSourceDiff } from "../src/fullSourceDiff";
import { parseInput } from "../src/patches";

type DiffNode = NonNullable<HunksRenderResult["unifiedContentAST"]>[number];

describe("fullSourceDiff", () => {
  test("a test after an omitted template literal has normal syntax tokens", async () => {
    // Given a partial hunk that begins with a snapshot's closing backtick
    const contents = syntaxContextFixture();
    const [file] = parseInput(contents.patch);

    // When the renderer receives complete syntax context without expanding unchanged lines
    const result = await new DiffHunksRenderer({ ...diffHighlightOptions, diffStyle: "unified", expandUnchanged: false }).asyncRender(fullSourceDiff(file, contents));
    const row = result.unifiedContentAST!.find((row) => text(row).includes('it("hides proposed fields"'))!;

    // Then code after the string is tokenized rather than treated as one green string
    expect(row.type === "element" ? row.children.map((child: DiffNode) => text(child).trim()) : []).toEqual(['it', '(', '"hides proposed fields"', ',', 'async', '()', '=>', '{']);
  });

  test("hydration leaves the canonical review metadata partial", () => {
    // Given the canonical diff used by review progress
    const contents = syntaxContextFixture();
    const [file] = parseInput(contents.patch);

    // When preparing full syntax context
    fullSourceDiff(file, contents);

    // Then review identity is not mutated by a renderer upgrade
    expect(file.isPartial).toBe(true);
  });

  test("both reading panes share the hydrated metadata", () => {
    // Given an already prepared full-source diff
    const contents = syntaxContextFixture();
    const [file] = parseInput(contents.patch);
    const main = fullSourceDiff(file, contents);

    // When a reference pane opens the same source version
    const reference = fullSourceDiff(file, contents);

    // Then both panes reuse the same source preparation
    expect(reference).toBe(main);
  });

  test("full syntax context does not change visible source coordinates", async () => {
    // Given native partial-hunk rows
    const contents = syntaxContextFixture();
    const [file] = parseInput(contents.patch);
    const options = { ...diffHighlightOptions, diffStyle: "unified", expandUnchanged: false } as const;
    const partial = await new DiffHunksRenderer(options).asyncRender(file);

    // When the same collapsed diff is highlighted with full source
    const full = await new DiffHunksRenderer(options).asyncRender(fullSourceDiff(file, contents));

    // Then navigation and comments still address the same displayed rows
    expect(sourceRows(full).map((row) => row.type === "element" ? row.properties : undefined)).toEqual(sourceRows(partial).map((row) => row.type === "element" ? row.properties : undefined));
  });
});

/** Read token text independently of the syntax span structure. */
function text(node: DiffNode): string { return node.type === "text" ? node.value : node.type === "element" ? node.children.map(text).join("") : ""; }

/** Separator expand buttons can change when source arrives; source coordinates cannot. */
function sourceRows(result: HunksRenderResult): DiffNode[] { return result.unifiedContentAST!.filter((row) => row.type === "element" && row.properties["data-line"] !== undefined); }
