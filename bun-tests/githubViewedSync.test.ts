import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { Storage } from "../server/storage";
import { Progress } from "../server/progress";
import { GitHubViewedSync } from "../server/githubViewedSync";
import { ThreadSync } from "../server/threadSync";
import { identifyChanges, identifyMetadata } from "../shared/changeProgress";
import { parseInput } from "../src/patches";
import type { FileViewedState, GitHubReview } from "../shared/types";
import type { GitHub } from "../server/github";

describe("githubViewedSync", () => {
  let directory: string;
  let storage: Storage;
  let progress: Progress;
  let worker: GitHubViewedSync;
  let github: Pick<GitHub, "review" | "viewedFiles" | "setFileViewed" | "contents" | "pullRequest">;
  let state: FileViewedState;
  let fail: boolean;
  let held: Promise<void> | undefined;
  const scope = "example/repo/1";
  const review: GitHubReview = { commit: "all", commits: [], patch: "diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-old\n+new\n", pr: { changed_files: 1, number: 1, title: "Fixture", body: "", html_url: "", state: "open", draft: false, user: { login: "reader" }, head: { sha: "a".repeat(40), ref: "topic" }, base: { sha: "b".repeat(40), ref: "main" } } };

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
    worker = new GitHubViewedSync(progress, github);
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
    worker = new GitHubViewedSync(progress, github);

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
    worker = new GitHubViewedSync(progress, github);
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

  it("import-only edits do not block completion or create approvals", async () => {
    // Given a TypeScript file whose only edit is an import
    const imports = { ...review, patch: review.patch.replaceAll("file.txt", "file.ts").replace("-old\n+new", '-import { old } from "pkg";\n+import { next } from "pkg";') };
    github.viewedFiles = async () => ({ files: { "file.ts": state } });
    github.contents = async () => ({ oldFile: { name: "file.ts", contents: 'import { old } from "pkg";\n' }, newFile: { name: "file.ts", contents: 'import { next } from "pkg";\n' } });

    // When classification and synchronization complete
    await worker.prepare("example/repo", "1", imports);

    // Then canonical exclusion evidence makes the file viewed without a fabricated approval
    expect(state).toEqual("VIEWED");
    expect(storage.db.query("SELECT pr_reviewable,reviewed_at FROM logical_hunks").all()).toEqual([{ pr_reviewable: 0, reviewed_at: null }]);
  });

  it("generated-file exclusions are represented on canonical units", async () => {
    // Given an automatically reviewed generated file
    const generated = { ...review, patch: review.patch.replaceAll("file.txt", "schema.graphql") };
    github.viewedFiles = async () => ({ files: { "schema.graphql": state } });

    // When the file is prepared
    await worker.prepare("example/repo", "1", generated);

    // Then its unapproved unit does not block the remote file flag
    expect(state).toEqual("VIEWED");
    expect(storage.db.query("SELECT path,pr_reviewable,reviewed_at FROM logical_hunks").all()).toEqual([{ path: "schema.graphql", pr_reviewable: 0, reviewed_at: null }]);
  });

  it("binary files stay unviewed until their metadata unit is approved", async () => {
    // Given a binary-only file
    const binary = { ...review, patch: "diff --git a/file.txt b/file.txt\nindex 1234567..abcdef0 100644\nBinary files a/file.txt and b/file.txt differ\n" };

    // When its complete comparison is prepared
    await worker.prepare("example/repo", "1", binary);

    // Then a real unapproved unit prevents empty-text completion
    expect(state).toEqual("UNVIEWED");
    expect(progress.viewedSync(scope)?.files).toEqual([{ path: "file.txt", githubViewed: false, desired: false }]);
  });

  it("a local action during remote import survives restart and background retry", async () => {
    // Given an initial remote Viewed lookup held in flight
    state = "VIEWED";
    const started = Promise.withResolvers<void>();
    const fetched = Promise.withResolvers<void>();
    github.viewedFiles = async () => { started.resolve(); await fetched.promise; return { files: { "file.txt": state } }; };
    const preparing = worker.prepare("example/repo", "1", review);
    await started.promise;
    // And the user explicitly unreviews the hunk while that lookup is pending
    const [block] = await identifyChanges(parseInput(review.patch));
    await progress.update(scope, block, false, review.pr.head.sha);
    fetched.resolve();
    await preparing;

    // When a restarted daemon retries the pending classification
    await worker.stop();
    await storage.close();
    storage = new Storage(`${directory}/state.sqlite`);
    progress = new Progress(storage);
    worker = new GitHubViewedSync(progress, github);
    await worker.retry(scope);

    // Then the newer unreview intent wins instead of importing the stale Viewed flag
    expect<FileViewedState>(state).toEqual("UNVIEWED");
    expect(await progress.get(scope)).toEqual([]);
  });

  it("a head change during a write cannot approve the new edit", async () => {
    // Given an approved old edit and a push racing its Viewed write
    await worker.prepare("example/repo", "1", review);
    const [block] = await identifyChanges(parseInput(review.patch));
    await progress.update(scope, block, true, review.pr.head.sha);
    const next = { ...review, patch: review.patch.replace("+new", "+different"), pr: { ...review.pr, head: { ...review.pr.head, sha: "c".repeat(40) } } };
    let current = review;
    github.review = async () => current;
    github.pullRequest = async () => current.pr;
    github.setFileViewed = async (_repo, _number, _path, viewed) => { state = viewed ? "VIEWED" : "UNVIEWED"; current = next; return { state }; };

    // When the old write completes and the worker reconciles the new head
    await worker.retry(scope);
    await worker.retry(scope);

    // Then the new unit remains unapproved and its accidental remote Viewed flag is corrected
    expect(state).toEqual("UNVIEWED");
    expect(storage.db.query("SELECT reviewed_at FROM logical_hunks WHERE pr_head=?").all(next.pr.head.sha)).toEqual([{ reviewed_at: null }]);
  });

  it("a failed post-write refresh retains the acknowledged flag", async () => {
    // Given a pending Viewed write
    await worker.prepare("example/repo", "1", review);
    const [block] = await identifyChanges(parseInput(review.patch));
    await progress.update(scope, block, true, review.pr.head.sha);
    // And metadata fetching fails only after GitHub accepts the mutation
    let rejectMetadata = false;
    github.pullRequest = async () => { if (rejectMetadata) throw new Error("Refresh unavailable"); return review.pr; };
    github.setFileViewed = async () => { state = "VIEWED"; rejectMetadata = true; return { state }; };

    // When the mutation succeeds but its subsequent refresh fails
    await worker.retry(scope);

    // Then the receipt remains acknowledged with a visible retry error
    expect(worker.status(scope)).toEqual({ files: { "file.txt": "VIEWED" }, syncErrors: [{ path: "file.txt", error: "Refresh unavailable" }] });
  });

  it("an incomplete comparison cannot overwrite registered receipts", async () => {
    // Given a valid registered file
    await worker.prepare("example/repo", "1", review);
    const before = worker.status(scope);
    // And a newer response omits an advertised file
    const incomplete = { ...review, pr: { ...review.pr, changed_files: 2, head: { ...review.pr.head, sha: "c".repeat(40) } } };

    // When preparation rejects the partial snapshot
    await worker.prepare("example/repo", "1", incomplete).catch(() => {});

    // Then the prior complete snapshot remains authoritative
    expect(worker.status(scope)).toEqual(before);
    expect(progress.viewedSync(scope)?.head).toEqual(review.pr.head.sha);
  });

  it("thread reconciliation establishes exclusions before viewed-file sync runs", async () => {
    // Given a generated file opened through thread reconciliation
    const generated = { ...review, patch: review.patch.replaceAll("file.txt", "schema.graphql") };
    const threads = new ThreadSync(storage, { ...github, patch: async () => generated.patch });
    await threads.refresh("example/repo", "1", generated);

    // When canonical review units are read before any remote Viewed flags are fetched
    const units = storage.db.query("SELECT path,pr_reviewable,reviewed_at FROM logical_hunks").all();

    // Then classification exists independently of viewed-file synchronization
    expect(units).toEqual([{ path: "schema.graphql", pr_reviewable: 0, reviewed_at: null }]);
  });

  it("viewed-file sync uses the comparison already reconciled by threads", async () => {
    // Given an import edit classified through the thread path
    const imports = { ...review, patch: review.patch.replaceAll("file.txt", "file.ts").replace("-old\n+new", '-import { old } from "pkg";\n+import { next } from "pkg";') };
    github.contents = async () => ({ oldFile: { name: "file.ts", contents: 'import { old } from "pkg";\n' }, newFile: { name: "file.ts", contents: 'import { next } from "pkg";\n' } });
    const threads = new ThreadSync(storage, { ...github, patch: async () => imports.patch });
    await threads.refresh("example/repo", "1", imports);
    // And only remote file flags remain available, without another source download
    github.contents = async () => { throw new Error("Source download unavailable"); };
    github.viewedFiles = async () => ({ files: { "file.ts": state } });

    // When viewed-file sync observes GitHub and derives completion from the stored units
    await worker.prepare("example/repo", "1", imports);

    // Then GitHub is marked Viewed using the existing import exclusion
    expect(worker.status(scope)).toEqual({ files: { "file.ts": "VIEWED" }, syncErrors: [] });
  });

  it("a base-only change reconciles file completion again", async () => {
    // Given a previously reviewed edit
    await worker.prepare("example/repo", "1", review);
    const [block] = await identifyChanges(parseInput(review.patch));
    await progress.update(scope, block, true, review.pr.head.sha);
    await worker.retry(scope);
    // And a new base exposes a different edit at the same head
    const next = { ...review, patch: review.patch.replace("-old", "-different base"), pr: { ...review.pr, base: { ...review.pr.base, sha: "c".repeat(40) } } };
    github.pullRequest = async () => next.pr;

    // When the new comparison is prepared
    await worker.prepare("example/repo", "1", next);

    // Then the newly exposed edit blocks completion without reimporting the old remote Viewed flag
    expect(worker.status(scope)).toEqual({ files: { "file.txt": "UNVIEWED" }, syncErrors: [] });
  });
});
