import { createTwoFilesPatch } from "diff";

/** Put the opening snapshot delimiter outside a test addition's three lines of patch context. */
export function syntaxContextFixture() {
  const name = "Component.test.tsx";
  const oldSource = [
    'describe("component", () => {',
    '  it("renders a snapshot", () => {',
    '    expect(render()).toMatchInlineSnapshot(`',
    ...Array.from({ length: 40 }, (_, index) => `      <div>Snapshot line ${index}</div>`),
    '    `);',
    '  });',
    '});',
    '',
  ].join("\n");
  const newSource = oldSource.replace('\n});', '\n\n  it("hides proposed fields", async () => {\n    const view = await render(<Component />);\n    expect(view.hidden).toBe(true);\n  });\n});');
  const oldFile = { name, contents: oldSource };
  const newFile = { name, contents: newSource };
  return { oldFile, newFile, patch: createTwoFilesPatch(name, name, oldSource, newSource) };
}
