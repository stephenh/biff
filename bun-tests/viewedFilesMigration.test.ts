import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { Storage } from "../server/storage";
import { Progress } from "../server/progress";
import { GitHubViewedSync } from "../server/githubViewedSync";
import { identifyChanges } from "../shared/changeProgress";
import { parseInput } from "../src/patches";
import type { FileViewedState, GitHubReview } from "../shared/types";

describe("viewedFilesMigration", () => {
  let directory: string;
  let storage: Storage;
  let progress: Progress;
  let worker: GitHubViewedSync;
  let remote: FileViewedState;
  const scope = "example/repo/1";
  const id = "a".repeat(64);
  const review: GitHubReview = { commit: "all", commits: [], patch: "diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-old\n+new\n",
    pr: { changed_files: 1, number: 1, title: "PR", body: "", html_url: "", state: "open", draft: false, user: { login: "author" }, head: { sha: "head", ref: "feature" }, base: { sha: "base", ref: "main" } } };

  beforeEach(async () => {
    directory = await mkdtemp("/tmp/opencode/biff-viewed-migration-");
    remote = "VIEWED";
    const [block] = await identifyChanges(parseInput(review.patch));
    const db = new Database(`${directory}/state.sqlite`);
    db.exec("CREATE TABLE review_records (id TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE review_aliases (alias TEXT PRIMARY KEY,review_id TEXT NOT NULL)");
    db.query("INSERT INTO review_records VALUES (?,?)").run(id, JSON.stringify({ id, pr: scope, closed: false, commits: [], changes: [], records: [],
      githubFileReview: { repo: "example/repo", number: "1", head: "head", files: [{ identity: { ...block, kind: "file" }, blocks: [block], reviewable: [block], units: [block], acknowledged: true, error: "Offline" }] } }));
    db.query("INSERT INTO review_aliases VALUES (?,?)").run(scope, id);
    db.close();
    storage = new Storage(`${directory}/state.sqlite`);
    progress = new Progress(storage);
    worker = createWorker();
  });
  afterEach(async () => { await worker.stop(); await storage.close(); await rm(directory, { recursive: true, force: true }); });

  test("migration keeps file receipts and retry errors after restart", async () => {
    // Given a legacy acknowledged Viewed flag with a saved error
    // When the migrated database reopens
    await reopen();

    // Then the receipt and error remain visible without the classification arrays
    expect(worker.status(scope)).toEqual({ files: { "file.txt": "VIEWED" }, syncErrors: [{ path: "file.txt", error: "Offline" }] });
    expect(storage.db.query("SELECT review_id,path,github_viewed,sync_error FROM review_files").all())
      .toEqual([{ review_id: id, path: "file.txt", github_viewed: 1, sync_error: "Offline" }]);
    expect(storage.db.query<{ name: string }, []>("PRAGMA table_info(reviews)").all().some((column) => column.name === "value")).toEqual(false);
  });

  test("reclassification does not reimport an old acknowledgement over an unreview action", async () => {
    // Given GitHub still says Viewed but the user's durable hunk approval has been cleared
    // When the restarted worker rebuilds classification at the same head
    await reopen();
    await worker.retry(scope);

    // Then canonical unreviewed state wins and corrects GitHub
    expect(remote).toEqual("UNVIEWED");
    expect(await progress.get(scope)).toEqual([]);
    expect(worker.status(scope)?.syncErrors).toEqual([]);
  });

  test("file IDs survive reclassification and subsequent saves", async () => {
    // Given the migrated file's synthetic identity
    const before = storage.db.query<{ id: number }, []>("SELECT id FROM review_files").get()!;

    // When classification is rebuilt and a later approval is synchronized
    await worker.retry(scope);
    const [block] = await identifyChanges(parseInput(review.patch));
    await progress.update(scope, block, true, "head");
    await worker.retry(scope);

    // Then the receipt updates on the original file row
    expect(storage.db.query("SELECT id,github_viewed,sync_error FROM review_files").all()).toEqual([{ id: before.id, github_viewed: 1, sync_error: null }]);
    expect(storage.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  /** Recreate services around a fresh SQLite connection. */
  async function reopen() {
    await worker.stop();
    await storage.close();
    storage = new Storage(`${directory}/state.sqlite`);
    progress = new Progress(storage);
    worker = createWorker();
  }

  /** Keep the remote flag independent from local receipts and approvals. */
  function createWorker(): GitHubViewedSync {
    return new GitHubViewedSync(progress, {
      review: async () => review, pullRequest: async () => review.pr, viewedFiles: async () => ({ files: { "file.txt": remote } }),
      setFileViewed: async (_repo, _number, _path, viewed) => { remote = viewed ? "VIEWED" : "UNVIEWED"; return { state: remote }; },
      contents: async () => { throw new Error("Unexpected source fetch"); },
    });
  }
});
