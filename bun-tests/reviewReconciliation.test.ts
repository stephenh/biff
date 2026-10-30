import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Storage } from "../server/storage";
import { createApi } from "../server/api";
import { GitHub } from "../server/github";
import { GitHubViewedSync } from "../server/githubViewedSync";
import { Workspaces } from "../server/workspaces";
import { reviewReconciliation, settleReviewReconciliations, startReviewReconciliation, waitForReviewState } from "../server/reviewReconciliation";
import { hunkApprovals, updateHunkApproval } from "../server/logicalHunks";
import { identifyChanges } from "../shared/changeProgress";
import { parseInput } from "../src/patches";
import { splitSemanticChanges } from "../shared/semanticChanges";
import { matchesChange } from "../shared/progress";
import type { GitHubReview } from "../shared/types";

describe("reviewReconciliation", () => {
  let storage: Storage;
  const scope = "example/repo/1";
  const head = "a".repeat(40);
  const base = "b".repeat(40);

  beforeEach(() => { storage = new Storage(); });
  afterEach(async () => { await settleReviewReconciliations(storage); await storage.close(); });

  test("a ready file can be read and edited while another file's source is held", async () => {
    // Given a PR with two source-dependent import edits and a slow second file
    const review = fixture(head, base);
    const release = Promise.withResolvers<void>();
    const github = new GitHub(undefined, storage);
    github.review = async () => review;
    github.pullRequest = async () => review.pr;
    github.syncThreads = async () => {};
    github.viewedFiles = async () => ({ files: { "first.ts": "VIEWED", "second.ts": "VIEWED" } });
    github.setFileViewed = async (_repo, _number, _path, viewed) => ({ state: viewed ? "VIEWED" : "UNVIEWED" });
    github.contents = async (_repo, _number, _head, _base, path) => {
      if (path === "second.ts") await release.promise;
      return { oldFile: { name: path, contents: 'import { old } from "pkg";\nconst value = 1;\n' }, newFile: { name: path, contents: 'import { next } from "pkg";\nconst value = 2;\n' } };
    };
    const sync = new GitHubViewedSync(storage, github);
    const api = createApi({ storage, github, githubViewedSync: sync, workspaces: new Workspaces(storage) });

    try {
      // When the review route returns before the slow source and the first file finishes
      const response = await api(new Request(`http://localhost/api/github/pr/${scope}/review`));
      expect((await response.json()).reconciliation).toEqual(true);
      await until(() => reviewReconciliation(storage, scope)?.files["first.ts"] === "ready");
      const status = await api(new Request(`http://localhost/api/github/pr/${scope}/reconciliation`));

      // Then the first file is usable while the complete comparison is still running
      expect(await status.json()).toEqual({ head, base, state: "running", files: { "first.ts": "ready", "second.ts": "running" } });
      const block = (await identifyChanges(splitSemanticChanges(parseInput(review.patch)))).filter((entry) => entry.path === "first.ts").at(-1)!;
      expect((await hunkApprovals(storage, scope)).some((entry) => matchesChange(entry, block))).toEqual(true);
      await updateHunkApproval(storage, scope, block, false, head);
      release.resolve();
      await settleReviewReconciliations(storage);
      expect((await hunkApprovals(storage, scope)).filter((entry) => entry.path === "first.ts" && entry.hash === block.hash)).toEqual([]);
      expect(reviewReconciliation(storage, scope)?.state).toEqual("ready");
    } finally { release.resolve(); await settleReviewReconciliations(storage); await sync.stop(); }
  });

  test("failed shared prerequisites remain retryable through the same PR endpoint", async () => {
    // Given a background prerequisite that fails on its first attempt
    let fail = true;
    startReviewReconciliation(storage, scope, { head, base }, ["file.ts"], async (reporter) => {
      if (fail) throw new Error("GitHub unavailable");
      reporter.sharedReady();
      reporter.ready("file.ts");
    });
    await settleReviewReconciliations(storage);
    const api = createApi({ storage, github: new GitHub(), workspaces: new Workspaces(storage) });

    // When the user retries after GitHub recovers
    fail = false;
    await api(new Request(`http://localhost/api/github/pr/${scope}/reconciliation`, { method: "POST" }));
    await waitForReviewState(storage, scope);
    await settleReviewReconciliations(storage);

    // Then the same comparison becomes ready without reopening the review
    expect(reviewReconciliation(storage, scope)).toEqual({ head, base, state: "ready", error: undefined, files: { "file.ts": "ready" } });
  });

  test("an old completion cannot publish readiness for a replacement comparison", async () => {
    // Given an old comparison waiting on source
    const release = Promise.withResolvers<void>();
    startReviewReconciliation(storage, scope, { head, base }, ["old.ts"], async (reporter) => { await release.promise; reporter.ready("old.ts"); });

    // When a new head replaces it before its request finishes
    const next = "c".repeat(40);
    startReviewReconciliation(storage, scope, { head: next, base }, ["new.ts"], async (reporter) => { reporter.ready("new.ts"); });
    release.resolve();
    await settleReviewReconciliations(storage);

    // Then only the new comparison's file inventory is visible
    expect(reviewReconciliation(storage, scope)).toEqual({ head: next, base, state: "ready", files: { "new.ts": "ready" } });
  });

  test("local reviews expose the same comparison and file status contract", async () => {
    // Given a prepared local comparison in an existing workspace
    const review = "d".repeat(64);
    const localScope = `jj/workspace/${review}`;
    const workspaces = new Workspaces(storage);
    workspaces.list = async () => [{ id: "workspace", name: "Fixture", path: "/fixture" }];
    startReviewReconciliation(storage, localScope, { head, base }, ["file.ts"], async (reporter) => { reporter.sharedReady(); });
    await settleReviewReconciliations(storage);
    const api = createApi({ storage, github: new GitHub(), workspaces });

    // When the shared viewer polls through the workspace route
    const response = await api(new Request(`http://localhost/api/workspaces/workspace/changes/${review}/reconciliation`));

    // Then its payload has the same shape as a ready GitHub comparison
    expect(await response.json()).toEqual({ head, base, state: "ready", files: { "file.ts": "ready" } });
  });
});

/** Bound readiness waits so a broken worker fails the test rather than hanging cleanup. */
async function until(ready: () => boolean) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (ready()) return;
    await Bun.sleep(5);
  }
  throw new Error("Reconciliation did not reach the expected state");
}

/** Include both import and business changes so early user approvals exercise finalization. */
function fixture(head: string, base: string): GitHubReview {
  return { commit: "all", commits: [], pr: { changed_files: 2, number: 1, title: "Fixture", body: "", html_url: "", state: "open", draft: false, user: { login: "reader" }, head: { sha: head, ref: "topic" }, base: { sha: base, ref: "main" } },
    patch: ["first.ts", "second.ts"].map((path) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,2 +1,2 @@\n-import { old } from "pkg";\n-const value = 1;\n+import { next } from "pkg";\n+const value = 2;\n`).join("") };
}
