import { updateHunkApproval, updateHunkApprovals, hunkApprovals } from "../server/logicalHunks";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { Storage } from "../server/storage";
import { identifyChanges, identifyFiles, identifyMetadata } from "../shared/changeProgress";
import { fileReviewed, matchesChange } from "../shared/progress";
import { parseInput } from "../src/patches";

describe("hunkApprovals", () => {
  let directory: string;
  let storage: Storage;
  const patch = "diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new\n";

  beforeEach(async () => { directory = await mkdtemp("/tmp/opencode/biff-approvals-"); });
  afterEach(async () => { await storage?.close(); await rm(directory, { recursive: true, force: true }); });

  test("hunk approvals preserve their timestamps across restart", async () => {
    // Given a persisted hunk approval
    const [block] = await identifyChanges(parseInput(patch));
    storage = new Storage(`${directory}/state.sqlite`);
    await updateHunkApproval(storage, "review", block, true, "head");
    storage.db.exec("UPDATE logical_hunks SET reviewed_at='2026-01-01T00:00:00Z'");

    // When the daemon restarts
    await storage.close();
    storage = new Storage(`${directory}/state.sqlite`);

    // Then the original approval survives with its timestamp
    expect(storage.db.query("SELECT path,reviewed_head,reviewed_at FROM logical_hunks WHERE reviewed_at IS NOT NULL").all()).toEqual([{ path: "file.ts", reviewed_head: "head", reviewed_at: "2026-01-01T00:00:00Z" }]);
  });

  test("marking a file stores only its units and clearing a hunk makes it incomplete", async () => {
    // Given a two-hunk file marked reviewed as a batch
    storage = new Storage();
    const files = parseInput(patch + "@@ -20 +20 @@\n-before\n+after\n");
    const blocks = await identifyChanges(files);
    const [file] = await identifyFiles(files, blocks);
    await updateHunkApproval(storage, "review", file, true, "head", blocks);

    // When one hunk is cleared
    const records = await updateHunkApproval(storage, "review", blocks[0], false, "head");

    // Then the file is incomplete even though it was marked as a whole
    expect(fileReviewed(file.path, blocks, (unit) => records.some((record) => matchesChange(record, unit)))).toBe(false);
  });

  test("a failed batch rolls back earlier changes in the same transaction", async () => {
    // Given an unreviewed file
    storage = new Storage();
    const files = parseInput(patch);
    const [block] = await identifyChanges(files);
    const [file] = await identifyFiles(files, [block]);

    // When a batch starts with a valid update but later contains an invalid file approval
    await updateHunkApprovals(storage, "review", [{ identity: block, reviewed: true }, { identity: file, reviewed: true }], "head").catch(() => {});

    // Then no part of the batch was saved
    expect(await hunkApprovals(storage, "review")).toEqual([]);
  });

  test("non-text approval does not change when unrelated text changes", async () => {
    // Given an executable-bit change accompanying a text edit
    const modePatch = patch.replace("--- a/file.ts", "old mode 100644\nnew mode 100755\n--- a/file.ts");
    const [before] = await identifyMetadata(parseInput(modePatch), "head");

    // When the text changes again but the executable-bit change stays the same
    const [after] = await identifyMetadata(parseInput(modePatch.replace("+new", "+different")), "next");

    // Then the non-text review unit retains its identity
    expect(matchesChange(before, after)).toBe(true);
  });

  test("a binary change has a review unit even without text hunks", async () => {
    // Given a binary diff with immutable blob IDs
    const files = parseInput("diff --git a/picture.png b/picture.png\nindex 1234567..abcdef0 100644\nBinary files a/picture.png and b/picture.png differ\n");

    // When its review units are identified
    const units = await identifyMetadata(files, "head");

    // Then binary content cannot be considered complete without an approval
    expect(fileReviewed("picture.png", units, () => false)).toBe(false);
  });

  test("clearing one duplicate leaves the other occurrence approved", async () => {
    // Given two approved occurrences of the same edit
    storage = new Storage();
    const blocks = await identifyChanges(parseInput(patch + "@@ -20 +20 @@\n-old\n+new\n"));
    await updateHunkApprovals(storage, "review", blocks.map((identity) => ({ identity, reviewed: true })), "head");

    // When the first occurrence is unreviewed
    await updateHunkApproval(storage, "review", blocks[0], false, "head");

    // Then only the second occurrence retains approval
    expect((await hunkApprovals(storage, "review")).map((record) => record.oldLine)).toEqual([20]);
  });

  test("clearing a hunk after file approval survives restart", async () => {
    // Given a file marked reviewed
    const files = parseInput(patch);
    const [block] = await identifyChanges(files);
    const [file] = await identifyFiles(files, [block]);
    storage = new Storage(`${directory}/state.sqlite`);
    await updateHunkApproval(storage, "review", file, true, "head", [block]);

    // When the hunk is cleared and the database reopens
    await updateHunkApproval(storage, "review", block, false, "head");
    await storage.close();
    storage = new Storage(`${directory}/state.sqlite`);

    // Then restarting cannot resurrect the hunk approval
    expect(await hunkApprovals(storage, "review")).toEqual([]);
  });

});
