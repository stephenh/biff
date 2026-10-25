import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { Storage } from "../server/storage";
import { Progress } from "../server/progress";
import { ViewedSync } from "../server/viewedSync";
import { identifyChanges, identifyMetadata } from "../shared/changeProgress";
import { parseInput } from "../src/patches";
import type { FileViewedState, GitHubReview } from "../shared/types";
import type { GitHub } from "../server/github";

describe("viewedSync", () => {
  let directory: string;
  let storage: Storage;
  let progress: Progress;
  let worker: ViewedSync;
  let github: Pick<GitHub, "review" | "viewedFiles" | "setFileViewed" | "contents" | "pullRequest">;
  let state: FileViewedState;
  let fail: boolean;
  let held: Promise<void> | undefined;
  const scope = "example/repo/1";
  const review: GitHubReview = { commit: "all", commits: [], patch: "diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-old\n+new\n", pr: { number: 1, title: "Fixture", body: "", html_url: "", state: "open", draft: false, user: { login: "reader" }, head: { sha: "a".repeat(40), ref: "topic" }, base: { sha: "b".repeat(40), ref: "main" } } };

  beforeEach(async () => {
    directory = await mkdtemp("/tmp/opencode/biff-viewed-");
    storage = new Storage(`${directory}/state.sqlite`);
    progress = new Progress(storage);
    state = "UNVIEWED";
    fail = false;
    held = undefined;
    github = {
      review: async () => review,
      pullRequest: async () => review.pr,
      viewedFiles: async () => ({ files: { "file.txt": state } }),
      setFileViewed: async (_repo, _number, _path, viewed) => {
        await held;
        if (fail) throw new Error("GitHub unavailable");
        state = viewed ? "VIEWED" : "UNVIEWED";
        return { state };
      },
      contents: async () => { throw new Error("Text fixture needs no import context"); },
    };
    worker = new ViewedSync(progress, github);
  });
  afterEach(async () => { await worker.stop(); await storage.close(); await rm(directory, { recursive: true, force: true }); });

  it("imports GitHub Viewed marks into persisted Biff progress", async () => {
    // Given GitHub already considers the file reviewed
    state = "VIEWED";

    // When the server prepares its review snapshot
    await worker.prepare("example/repo", "1", review);

    // Then Biff has a durable hunk approval without an independent file flag
    expect((await progress.get(scope)).map((entry) => ({ path: entry.path, kind: entry.kind }))).toEqual([{ path: "file.txt", kind: undefined }]);
  });

  it("syncs hunk completion without a mounted viewer", async () => {
    // Given a registered PR and its last hunk marked reviewed directly in storage
    await worker.prepare("example/repo", "1", review);
    const [block] = await identifyChanges(parseInput(review.patch, true));
    await progress.update(scope, block, true, review.pr.head.sha);

    // When the daemon reconciles progress
    await worker.retry(scope);

    // Then GitHub receives Viewed state
    expect(state).toBe("VIEWED");
  });

  it("retains failed synchronization after reopening SQLite", async () => {
    // Given a failed Viewed write
    await worker.prepare("example/repo", "1", review);
    const [block] = await identifyChanges(parseInput(review.patch, true));
    await progress.update(scope, block, true, review.pr.head.sha);
    fail = true;
    await worker.retry(scope);

    // When the daemon restarts
    await worker.stop();
    await storage.close();
    storage = new Storage(`${directory}/state.sqlite`);
    progress = new Progress(storage);
    worker = new ViewedSync(progress, github);

    // Then the failure is still visible and retryable
    expect(worker.status(scope)?.syncErrors).toEqual([{ path: "file.txt", error: "GitHub unavailable" }]);
  });

  it("retries persisted failures without reopening the PR", async () => {
    // Given a durable failed write
    await worker.prepare("example/repo", "1", review);
    const [block] = await identifyChanges(parseInput(review.patch, true));
    await progress.update(scope, block, true, review.pr.head.sha);
    fail = true;
    await worker.retry(scope);
    // And a new worker after GitHub recovers
    await worker.stop();
    worker = new ViewedSync(progress, github);
    fail = false;

    // When background reconciliation retries
    await worker.retry(scope);

    // Then GitHub reaches the saved intent
    expect(state).toBe("VIEWED");
  });

  it("a reversal during a held write becomes the final remote state", async () => {
    // Given the Viewed write is held
    await worker.prepare("example/repo", "1", review);
    const [block] = await identifyChanges(parseInput(review.patch, true));
    await progress.update(scope, block, true, review.pr.head.sha);
    const latch = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    held = latch.promise;
    const write = github.setFileViewed;
    github.setFileViewed = (...args) => { started.resolve(); return write(...args); };
    const first = worker.retry(scope);
    await started.promise;
    // And the reader reverses the approval while it is saving
    await progress.update(scope, block, false, review.pr.head.sha);
    const second = worker.retry(scope);

    // When the queued reconciliations finish
    latch.resolve();
    await Promise.all([first, second]);

    // Then the newer intent wins
    expect(state).toBe("UNVIEWED");
  });
  it("text completion cannot approve a pending executable-bit change", async () => {
    // Given a file with both a text hunk and a mode change
    const changed = { ...review, patch: review.patch.replace("--- a/file.txt", "old mode 100644\nnew mode 100755\n--- a/file.txt") };
    await worker.prepare("example/repo", "1", changed);
    const [block] = await identifyChanges(parseInput(changed.patch, true));

    // When only the text hunk is approved
    await progress.update(scope, block, true, review.pr.head.sha);
    await worker.retry(scope);

    // Then GitHub still shows the file as unviewed
    expect(state).toBe("UNVIEWED");
  });

  it("approving all text and non-text units projects to GitHub Viewed", async () => {
    // Given a file with both a text hunk and a mode change
    const changed = { ...review, patch: review.patch.replace("--- a/file.txt", "old mode 100644\nnew mode 100755\n--- a/file.txt") };
    await worker.prepare("example/repo", "1", changed);
    const files = parseInput(changed.patch, true);
    const units = [...await identifyChanges(files), ...await identifyMetadata(files, review.pr.head.sha)];

    // When all of its units are approved together
    await progress.updateBatch(scope, units.map((identity) => ({ identity, reviewed: true })), review.pr.head.sha);
    await worker.retry(scope);

    // Then the derived file result reaches GitHub
    expect(state).toBe("VIEWED");
  });
});
