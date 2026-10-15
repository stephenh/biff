import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Workspaces } from "../server/workspaces";
import { runCommand } from "../server/commands";
import { parseInput } from "../src/patches";

describe("workspaces", () => {
  let directory: string;
  let repo: string;
  let registry: string;
  let workspaces: Workspaces;
  beforeAll(async () => {
    directory = await mkdtemp("/tmp/opencode/biff-workspaces-");
    repo = join(directory, "repository with spaces");
    registry = join(directory, "registry.json");
    await mkdir(join(repo, "nested"), { recursive: true });
    await runCommand(["jj", "git", "init"], { cwd: repo });
    await writeFile(join(repo, "example.ts"), "export const value = 1;\n");
    await runCommand(["jj", "describe", "-m", "First change"], { cwd: repo });
    await runCommand(["jj", "new", "-m", "Current change"], { cwd: repo });
    await writeFile(join(repo, "example.ts"), "export const value = 2;\n");
    workspaces = new Workspaces(registry);
  });
  afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

  test("registration from a subdirectory persists one canonical working copy", async () => {
    // Given a JJ repository containing a nested directory
    await workspaces.add(repo);

    // When the nested directory is registered again and the registry is reopened
    await workspaces.add(join(repo, "nested"));
    const entries = await new Workspaces(registry).list();

    // Then the dashboard has one canonical entry
    expect(entries.map((entry) => entry.path)).toEqual([repo]);
  });

  test("@ includes unsnapshotted edits in the working commit", async () => {
    // Given a registered working copy with an edited file
    const workspace = await workspaces.add(repo);

    // When the current commit is opened
    const review = await workspaces.review(workspace.id, "@");

    // Then its patch contains the edited new content
    expect(parseInput(review.patch)[0].additionLines).toEqual(["export const value = 2;\n"]);
  });

  test("@- shows the previous commit rather than the working tree", async () => {
    // Given a working copy whose current commit changes value 1 to 2
    const workspace = await workspaces.add(repo);

    // When the previous commit is opened
    const review = await workspaces.review(workspace.id, "@-");

    // Then its patch and metadata refer to the first change
    expect(parseInput(review.patch)[0].additionLines).toEqual(["export const value = 1;\n"]);
    expect(review.selected.description.trim()).toBe("First change");
  });

  test("empty working commits return an empty diff", async () => {
    // Given a new working commit without edits
    await runCommand(["jj", "new"], { cwd: repo });
    const workspace = await workspaces.add(repo);

    // When its diff is requested
    const review = await workspaces.review(workspace.id, "@");

    // Then it can be presented as a normal empty state
    expect(review.patch).toBe("");
  });

  test("invalid revisions are rejected without running arbitrary revsets", async () => {
    // Given a registered workspace
    const workspace = await workspaces.add(repo);

    // When a shell-like revision is supplied
    const result = workspaces.review(workspace.id, "@; touch injected");

    // Then validation rejects it
    await expect(result).rejects.toThrow("Choose @, @-, or a revision from the recent list.");
  });
});
