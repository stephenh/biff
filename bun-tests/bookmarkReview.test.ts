import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { Workspaces } from "../server/workspaces";
import { runCommand } from "../server/commands";

describe("bookmarkReview", () => {
  let directory: string;
  let workspaces: Workspaces;
  let id: string;

  beforeEach(async () => {
    directory = await mkdtemp("/tmp/opencode/biff-bookmark-");
    await jj("git", "init");
    await writeFile(`${directory}/file.ts`, "const first = 0;\nconst second = 0;\n");
    await jj("bookmark", "create", "main");
    await jj("config", "set", "--repo", 'revset-aliases."trunk()"', "main");
    await jj("new");
    await writeFile(`${directory}/file.ts`, "const first = 1;\nconst second = 0;\n");
    await jj("new");
    await writeFile(`${directory}/file.ts`, "const first = 1;\nconst second = 2;\n");
    await jj("bookmark", "create", "feature/test");
    workspaces = new Workspaces(`${directory}/.jj/biff-workspaces.json`);
    id = (await workspaces.add(directory)).id;
  });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  /** Run JJ against the isolated workspace. */
  function jj(...args: string[]) { return runCommand(["jj", ...args], { cwd: directory }); }

  test("all changes loads full source from the trunk base across multiple commits", async () => {
    // Given a bookmark containing two commits
    const review = await workspaces.bookmarkReview(id);
    // When full source is loaded for its aggregate diff
    const contents = await workspaces.contents(id, review.selected.commit_id, "file.ts", review.base!.commit_id);
    // Then the old source precedes both edits
    expect(contents.oldFile.contents).toBe("const first = 0;\nconst second = 0;\n");
  });

  test("individual commits use their own parent rather than the bookmark base", async () => {
    // Given the two-commit bookmark
    const all = await workspaces.bookmarkReview(id, "feature/test");
    // When only the tip commit is selected
    const review = await workspaces.bookmarkReview(id, "feature/test", all.tip!.change_id);
    const contents = await workspaces.contents(id, review.selected.commit_id, "file.ts");
    // Then its parent already contains the first edit
    expect(contents.oldFile.contents).toBe("const first = 1;\nconst second = 0;\n");
  });

  test("moving a bookmark retains its progress scope", async () => {
    // Given a bookmark review
    const before = await workspaces.bookmarkReview(id, "feature/test");
    // When another commit is added to the bookmark
    await jj("new");
    await writeFile(`${directory}/file.ts`, "const first = 1;\nconst second = 3;\n");
    await jj("bookmark", "set", "feature/test");
    const after = await workspaces.bookmarkReview(id, "feature/test");
    // Then progress remains scoped to the bookmark
    expect(after.progressScope).toBe(before.progressScope);
  });

  test("an explicit base limits a stacked review to commits above its parent", async () => {
    // Given a stacked bookmark with its first commit as the parent base
    const all = await workspaces.bookmarkReview(id, "feature/test");
    // When the parent commit is chosen as the base
    const review = await workspaces.bookmarkReview(id, "feature/test", "all", all.revisions[1].commit_id);
    // Then only the tip commit belongs to the review
    expect(review.revisions.map((entry) => entry.commit_id)).toEqual([all.tip!.commit_id]);
  });

  test("WIP is the default when the working commit has no bookmark", async () => {
    // Given work above a named bookmark
    await jj("new");
    await writeFile(`${directory}/file.ts`, "const first = 1;\nconst second = 3;\n");
    // When the default workspace view is opened
    const review = await workspaces.bookmarkReview(id);
    // Then the unbookmarked working commit is reviewed as WIP
    expect(review.bookmark).toBe("");
  });

  test("a named bookmark excludes later working-copy changes", async () => {
    // Given additional work above the bookmark
    const before = await workspaces.bookmarkReview(id, "feature/test");
    await jj("new");
    await writeFile(`${directory}/file.ts`, "const first = 1;\nconst second = 3;\n");
    // When the named bookmark is reviewed
    const after = await workspaces.bookmarkReview(id, "feature/test");
    // Then the diff still ends at the bookmark
    expect(after.patch).toBe(before.patch);
  });

  test("a stacked bookmark automatically uses its nearest bookmarked ancestor", async () => {
    // Given a parent bookmark on the first of two feature commits
    const all = await workspaces.bookmarkReview(id, "feature/test");
    await jj("bookmark", "create", "parent-feature", "-r", all.revisions[1].commit_id);

    // When reviewing the child without a base override
    const review = await workspaces.bookmarkReview(id, "feature/test");

    // Then the parent bookmark is the inferred base
    expect(review.base?.commit_id).toBe(all.revisions[1].commit_id);
  });

  test("an explicit base can include changes below the inferred parent bookmark", async () => {
    // Given a parent bookmark in the stack
    const all = await workspaces.bookmarkReview(id, "feature/test");
    await jj("bookmark", "create", "parent-feature", "-r", all.revisions[1].commit_id);

    // When explicitly choosing main instead
    const review = await workspaces.bookmarkReview(id, "feature/test", "all", "main");

    // Then both feature commits remain in the review
    expect(review.revisions.map((entry) => entry.commit_id)).toEqual(all.revisions.map((entry) => entry.commit_id));
  });
});
