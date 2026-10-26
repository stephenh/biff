import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { Storage } from "../server/storage";
import { Progress } from "../server/progress";
import { identifyChanges, identifyFiles, identifyMetadata } from "../shared/changeProgress";
import { fileReviewed, matchesChange, type ReviewedChange } from "../shared/progress";
import { parseInput } from "../src/patches";

describe("hunkApprovals", () => {
  let directory: string;
  let storage: Storage;
  const patch = "diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new\n";

  beforeEach(async () => { directory = await mkdtemp("/tmp/opencode/biff-approvals-"); });
  afterEach(async () => { await storage?.close(); await rm(directory, { recursive: true, force: true }); });

  test("an existing database migrates hunk evidence once and preserves its timestamps", async () => {
    // Given legacy progress stored inside the review JSON
    const [block] = await identifyChanges(parseInput(patch));
    const approval = { ...block, head: "head", reviewedAt: "2026-01-01T00:00:00Z" };
    seed([approval]);

    // When the upgraded daemon starts twice
    storage = new Storage(`${directory}/state.sqlite`);
    await storage.close();
    storage = new Storage(`${directory}/state.sqlite`);

    // Then one original approval survives in the new table
    expect(storage.db.query("SELECT path,head,reviewed_at FROM hunk_approvals").all()).toEqual([{ path: "file.ts", head: "head", reviewed_at: approval.reviewedAt }]);
  });

  test("migrated hunk approvals are removed from the review JSON", async () => {
    // Given a legacy hunk approval
    const [block] = await identifyChanges(parseInput(patch));
    seed([{ ...block, head: "head", reviewedAt: "then" }]);

    // When storage is upgraded
    storage = new Storage(`${directory}/state.sqlite`);

    // Then the JSON payload no longer duplicates approval state
    expect(JSON.parse(storage.db.query<{ value: string }, []>("SELECT value FROM reviews").get()!.value).records).toEqual([]);
  });

  test("a legacy file approval expands only when its exact comparison is available", async () => {
    // Given an old file-only approval and its corresponding diff
    const files = parseInput(patch);
    const blocks = await identifyChanges(files);
    const [file] = await identifyFiles(files, blocks, "head");
    seed([{ ...file, head: "head", reviewedAt: "then" }]);
    storage = new Storage(`${directory}/state.sqlite`);
    const progress = new Progress(storage);

    // When that exact comparison is loaded
    await progress.migrateFileApprovals("review", files, "head");

    // Then only its hunk approval becomes authoritative
    expect((await progress.get("review")).map((entry) => ({ hash: entry.hash, kind: entry.kind, reviewedAt: entry.reviewedAt }))).toEqual([{ hash: blocks[0].hash, kind: undefined, reviewedAt: "then" }]);
  });

  test("unavailable legacy comparisons cannot approve different content", async () => {
    // Given file evidence for an older edit
    const files = parseInput(patch);
    const [file] = await identifyFiles(files, await identifyChanges(files), "head");
    seed([{ ...file, head: "head", reviewedAt: "then" }]);
    storage = new Storage(`${directory}/state.sqlite`);
    const progress = new Progress(storage);

    // When only a newer comparison can be loaded
    await progress.migrateFileApprovals("review", parseInput(patch.replace("+new", "+different")), "next");

    // Then old file evidence does not act as a hunk approval
    expect(await progress.get("review")).toEqual([]);
  });

  test("marking a file stores only its units and clearing a hunk makes it incomplete", async () => {
    // Given a two-hunk file marked reviewed as a batch
    storage = new Storage();
    const progress = new Progress(storage);
    const files = parseInput(patch + "@@ -20 +20 @@\n-before\n+after\n");
    const blocks = await identifyChanges(files);
    const [file] = await identifyFiles(files, blocks);
    await progress.update("review", file, true, "head", blocks);

    // When one hunk is cleared
    const records = await progress.update("review", blocks[0], false, "head");

    // Then the file is incomplete even though it was marked as a whole
    expect(fileReviewed(file.path, blocks, (unit) => records.some((record) => matchesChange(record, unit)))).toBe(false);
  });

  test("a failed batch rolls back earlier changes in the same transaction", async () => {
    // Given an unreviewed file
    storage = new Storage();
    const progress = new Progress(storage);
    const files = parseInput(patch);
    const [block] = await identifyChanges(files);
    const [file] = await identifyFiles(files, [block]);

    // When a batch starts with a valid update but later contains an invalid file approval
    await progress.updateBatch("review", [{ identity: block, reviewed: true }, { identity: file, reviewed: true }], "head").catch(() => {});

    // Then no part of the batch was saved
    expect(await progress.get("review")).toEqual([]);
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

  /** Build a pre-migration database rather than seeding through the new implementation. */
  function seed(records: ReviewedChange[]) {
    const db = new Database(`${directory}/state.sqlite`);
    db.exec("CREATE TABLE review_records (id TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.query("INSERT INTO review_records VALUES (?,?)").run("review", JSON.stringify({ id: "review", records, commits: [], changes: [], closed: false }));
    db.close();
  }

  test("clearing one duplicate leaves the other occurrence approved", async () => {
    // Given two approved occurrences of the same edit
    storage = new Storage();
    const progress = new Progress(storage);
    const blocks = await identifyChanges(parseInput(patch + "@@ -20 +20 @@\n-old\n+new\n"));
    await progress.updateBatch("review", blocks.map((identity) => ({ identity, reviewed: true })), "head");

    // When the first occurrence is unreviewed
    await progress.update("review", blocks[0], false, "head");

    // Then only the second occurrence retains approval
    expect((await progress.get("review")).map((record) => record.oldLine)).toEqual([20]);
  });

  test("clearing migrated text prevents old file evidence from restoring it", async () => {
    // Given legacy whole-file and hunk approvals
    const files = parseInput(patch);
    const [block] = await identifyChanges(files);
    const [file] = await identifyFiles(files, [block]);
    seed([block, file].map((identity) => ({ ...identity, head: "head", reviewedAt: "then" })));
    storage = new Storage(`${directory}/state.sqlite`);
    const progress = new Progress(storage);

    // When the hunk is cleared before the old comparison is loaded again
    await progress.update("review", block, false, "head");
    await progress.migrateFileApprovals("review", files, "head");

    // Then the old file approval cannot resurrect the hunk
    expect(await progress.get("review")).toEqual([]);
  });
});
