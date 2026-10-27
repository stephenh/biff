import { hunkApprovals, updateHunkApproval } from "../server/logicalHunks";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { Storage } from "../server/storage";
import { GitHubViewedSync } from "../server/githubViewedSync";
import { identifyChanges } from "../shared/changeProgress";
import { ReviewStore } from "../server/reviewStore";
import { parseInput } from "../src/patches";
import type { FileViewedState, GitHubReview } from "../shared/types";

describe("viewedFiles", () => {
  let directory: string;
  let storage: Storage;
  let worker: GitHubViewedSync;
  let remote: FileViewedState;
  const scope = "example/repo/1";
  const id = "a".repeat(64);
  const review: GitHubReview = { commit: "all", commits: [], patch: "diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-old\n+new\n",
    pr: { changed_files: 1, number: 1, title: "PR", body: "", html_url: "", state: "open", draft: false, user: { login: "author" }, head: { sha: "head", ref: "feature" }, base: { sha: "base", ref: "main" } } };

  beforeEach(async () => {
    directory = await mkdtemp("/tmp/opencode/biff-viewed-files-");
    remote = "VIEWED";
    storage = new Storage(`${directory}/state.sqlite`);
    new ReviewStore(storage.db).save({ id, pr: scope, closed: false, commits: [], changes: [] });
    storage.db.query("INSERT INTO review_aliases VALUES (?,?)").run(scope, id);
    storage.db.query("UPDATE reviews SET viewed_sync_head='head' WHERE id=?").run(id);
    storage.db.query("INSERT INTO review_files (review_id,path,github_viewed,sync_error) VALUES (?,'file.txt',1,'Offline')").run(id);
    worker = createWorker();
  });
  afterEach(async () => { await worker.stop(); await storage.close(); await rm(directory, { recursive: true, force: true }); });

  test("GitHub file flags and retry errors survive restart", async () => {
    // Given a stored GitHub Viewed flag with a saved error
    // When the database reopens
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
    expect(await hunkApprovals(storage, scope)).toEqual([]);
    expect(worker.status(scope)?.syncErrors).toEqual([]);
  });

  test("file IDs survive reclassification and subsequent saves", async () => {
    // Given the file's synthetic identity
    const before = storage.db.query<{ id: number }, []>("SELECT id FROM review_files").get()!;

    // When classification is rebuilt and a later approval is synchronized
    await worker.retry(scope);
    const [block] = await identifyChanges(parseInput(review.patch));
    await updateHunkApproval(storage, scope, block, true, "head");
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
    worker = createWorker();
  }

  /** Keep the remote flag independent from local receipts and approvals. */
  function createWorker(): GitHubViewedSync {
    return new GitHubViewedSync(storage, {
      review: async () => review, pullRequest: async () => review.pr, viewedFiles: async () => ({ files: { "file.txt": remote } }),
      setFileViewed: async (_repo, _number, _path, viewed) => { remote = viewed ? "VIEWED" : "UNVIEWED"; return { state: remote }; },
      contents: async () => { throw new Error("Unexpected source fetch"); },
    });
  }
});
