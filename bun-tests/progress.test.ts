import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { Progress } from "../server/progress";
import { matchesChange } from "../shared/progress";
import { identifyChanges, isImportOnly } from "../src/changeProgress";
import { findImportGroups } from "../src/importGroups";
import { parseInput } from "../src/patches";
import { createApi } from "../server/api";
import { GitHub } from "../server/github";
import { Workspaces } from "../server/workspaces";

describe("progress", () => {
  test("unique exact edits retain completion after unrelated lines shift", async () => {
    // Given a reviewed edit and the same edit moved down in the file
    const [saved] = await identifyChanges(parseInput(patch(1)));
    const [moved] = await identifyChanges(parseInput(patch(20)));
    // When their identities are compared
    const match = matchesChange(saved, moved);
    // Then coordinates do not invalidate a unique edit
    expect(match).toBe(true);
  });

  test("duplicate edits require matching old and new coordinates", async () => {
    // Given identical edits in two locations
    const blocks = await identifyChanges(parseInput(patch(1) + '@@ -20 +20 @@\n-before();\n+after();\n'));
    // When the first completion is compared to the second occurrence
    const match = matchesChange(blocks[0], blocks[1]);
    // Then it cannot mark both occurrences completed
    expect(match).toBe(false);
  });

  test("a duplicate becoming unique remains position dependent", async () => {
    // Given a saved position-dependent mark
    const [saved] = await identifyChanges(parseInput(patch(1)));
    saved.duplicate = true;
    // And its remaining unique occurrence has moved
    const [moved] = await identifyChanges(parseInput(patch(20)));
    // When matching after another occurrence disappears
    const match = matchesChange(saved, moved);
    // Then the position-dependent record is not silently upgraded
    expect(match).toBe(false);
  });

  test("a unique edit becoming duplicated only matches its original coordinates", async () => {
    // Given a unique saved edit
    const [saved] = await identifyChanges(parseInput(patch(1)));
    // And a new occurrence of that edit appears elsewhere
    const [current] = await identifyChanges(parseInput(patch(20)));
    current.duplicate = true;
    // When the new duplicate is matched
    const match = matchesChange(saved, current);
    // Then completion does not spread to the new location
    expect(match).toBe(false);
  });

  test("changed text invalidates a saved completion", async () => {
    // Given an edit whose addition later changes
    const [saved] = await identifyChanges(parseInput(patch(1)));
    const [changed] = await identifyChanges(parseInput(patch(1).replace("after();", "different();")));
    // When matching the revised edit
    const match = matchesChange(saved, changed);
    // Then it requires review again
    expect(match).toBe(false);
  });

  test("serialized updates survive restarting the progress store without losing other marks", async () => {
    // Given durable storage and two distinct edits
    const directory = await mkdtemp("/tmp/opencode/biff-progress-");
    try {
      const store = new Progress(directory);
      const [first] = await identifyChanges(parseInput(patch(1)));
      const [second] = await identifyChanges(parseInput(patch(1).replaceAll("file.ts", "second.ts")));
      // When two tabs save concurrently and the server restarts
      await Promise.all([store.update("repo/1", first, true, "head"), store.update("repo/1", second, true, "head")]);
      const restored = await new Progress(directory).get("repo/1");
      // Then both completions are durably present
      expect(restored.map((entry) => entry.path)).toEqual(["file.ts", "second.ts"]);
    } finally { await rm(directory, { recursive: true }); }
  });

  test("the progress API persists and unmarks changes independently of GitHub", async () => {
    // Given the local progress API and an exact edit identity
    const directory = await mkdtemp("/tmp/opencode/biff-progress-api-");
    try {
      const api = createApi({ github: new GitHub(), workspaces: new Workspaces(`${directory}/workspaces.json`), progress: new Progress(directory) });
      const [identity] = await identifyChanges(parseInput(patch(1)));
      const url = "http://127.0.0.1:4567/api/github/pr/example/project/12/progress";
      const marked = await api(new Request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...identity, reviewed: true, head: "a".repeat(40) }) }));
      if (!marked.ok) throw new Error(await marked.text());
      // When the same change is unmarked through the API
      const unmarked = await api(new Request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...identity, reviewed: false, head: "a".repeat(40) }) }));
      if (!unmarked.ok) throw new Error(await unmarked.text());
      const loaded = await api(new Request(url));
      // Then a later read sees no completion
      expect(await loaded.json()).toEqual([]);
    } finally { await rm(directory, { recursive: true }); }
  });
  test.each([
    { workspace: "first", change: "k".repeat(32), expected: 1 },
    { workspace: "first", change: "z".repeat(32), expected: 0 },
    { workspace: "second", change: "k".repeat(32), expected: 0 },
  ])("JJ progress is scoped to $workspace / $change", async (scenario) => {
    // Given two registered workspaces and a completed edit on one JJ change
    const directory = await mkdtemp("/tmp/opencode/biff-jj-progress-");
    try {
      const registry = `${directory}/workspaces.json`;
      await writeFile(registry, JSON.stringify(["first", "second"].map((id) => ({ id, name: id, path: `${directory}/${id}` }))));
      const services = { github: new GitHub(), workspaces: new Workspaces(registry), progress: new Progress(directory) };
      const api = createApi(services);
      const [identity] = await identifyChanges(parseInput(patch(1)));
      const base = "http://127.0.0.1:4567/api/workspaces";
      const marked = await api(new Request(`${base}/first/changes/${"k".repeat(32)}/progress`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...identity, reviewed: true, head: "a".repeat(40) }) }));
      if (!marked.ok) throw new Error(await marked.text());

      // When a new server instance loads progress without using the old commit ID
      const restarted = createApi({ ...services, progress: new Progress(directory) });
      const loaded = await restarted(new Request(`${base}/${scenario.workspace}/changes/${scenario.change}/progress`));
      if (!loaded.ok) throw new Error(await loaded.text());

      // Then only the same workspace and stable JJ change retain completion
      expect(await loaded.json()).toHaveLength(scenario.expected);
    } finally { await rm(directory, { recursive: true }); }
  });
  test("import-only edits are excluded from review progress", async () => {
    // Given an import replacement
    const files = parseInput(patch(1).replace("before();", 'import Old from "old";').replace("after();", 'import New from "new";'));
    const [block] = await identifyChanges(files);

    // When classifying the block with the same metadata as import folding
    const excluded = isImportOnly(block, findImportGroups(files[0]));

    // Then it does not contribute to progress
    expect(excluded).toBe(true);
  });

  test("mixed import and business edits still contribute to review progress", async () => {
    // Given imports adjacent to changed business code in one block
    const files = parseInput('diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n@@ -1,2 +1,2 @@\n-import Old from "old";\n-const value = 1;\n+import New from "new";\n+const value = 2;\n');
    const [block] = await identifyChanges(files);

    // When classifying the whole block
    const excluded = isImportOnly(block, findImportGroups(files[0]));

    // Then its business edit keeps it in the count
    expect(excluded).toBe(false);
  });
});

/** Supply a one-block edit at an arbitrary source coordinate. */
function patch(line: number) {
  return `diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n@@ -${line} +${line} @@\n-before();\n+after();\n`;
}
