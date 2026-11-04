import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Storage } from "../server/storage";
import { PrActivity } from "../server/prActivity";
import { beginHunkReconciliation, updateHunkApproval } from "../server/logicalHunks";
import { recordPullRequest } from "../server/reviewStore";
import { reconcilePrComparison } from "../server/prComparison";
import { captureSinceReview, readSinceReview, recordSinceReview } from "../server/sinceReview";
import { registerReviewChanges } from "../server/reviewChanges";
import { createApi } from "../server/api";
import { GitHub } from "../server/github";
import { Workspaces } from "../server/workspaces";
import type { GitHubReview } from "../shared/types";

describe("sinceReview", () => {
  let storage: Storage;
  let current: GitHubReview;
  const scope = "example/repo/1";
  const firstHead = "a".repeat(40);
  const secondHead = "b".repeat(40);
  const base = "c".repeat(40);

  beforeEach(async () => {
    storage = new Storage();
    new PrActivity(storage.db).summary({ number: 1, title: "Review", url: "https://github.com/example/repo/pull/1", repository: { nameWithOwner: "example/repo" }, author: { login: "author" }, isDraft: false, updatedAt: "2026-11-04" });
    registerReviewChanges(storage.db, scope, "me");
    await reconcile(firstHead, "first");
  });
  afterEach(async () => { await storage.close(); });

  /** Reconcile real patches, including identities nobody has checked. */
  async function reconcile(head: string, contents: string, comparisonBase = base) {
    current = { pr: { number: 1, title: "Review", body: "", html_url: "https://github.com/example/repo/pull/1", state: "open", draft: false, user: { login: "author" }, head: { sha: head, ref: "feature" }, base: { sha: comparisonBase, ref: "main" }, changed_files: 1 }, commit: "all", commits: [],
      patch: `diff --git a/example.ts b/example.ts\n--- a/example.ts\n+++ b/example.ts\n@@ -1 +1 @@\n-before\n+${contents}\n` };
    await recordPullRequest(storage, scope, [head], false, head);
    await reconcilePrComparison(storage, { pullRequest: async () => current.pr, contents: async () => ({ oldFile: { name: "example.ts", contents: "before" }, newFile: { name: "example.ts", contents } }) }, scope, current, beginHunkReconciliation(storage, scope, "pr"));
  }

  /** Publish a real receipt and advance membership using its admitted inventory. */
  function submit() {
    const captured = captureSinceReview(storage.db, scope, current.pr.head.sha, base)!;
    observe(1, "me");
    recordSinceReview(storage.db, scope, "me", 1, current.pr.head.sha, captured.base, captured.units);
  }

  /** Imported reviews deliberately have no invented historical base. */
  function observe(id: number, login: string, state = "APPROVED", body = "Reviewed") {
    new PrActivity(storage.db).review(scope, { id, user: { login }, state, body, commit_id: current.pr.head.sha, submitted_at: `2026-11-04T12:00:0${id}Z`, html_url: current.pr.html_url });
  }

  test("unchecked hunks are existing after a successful submission", () => {
    // Given a complete comparison with no checkbox approvals
    // When the review is submitted
    submit();
    // Then the complete inventory belongs to that review
    expect(readSinceReview(storage.db, scope, "me").hunks).toMatchObject([{ sinceReview: "existing", present: true }]);
  });

  test("replacement keeps the old hunk discoverable and accents the new one", async () => {
    // Given a submitted review
    submit();
    // When a push replaces its only hunk
    await reconcile(secondHead, "replacement");
    // Then identities express membership without claiming ancestry
    expect(readSinceReview(storage.db, scope, "me").hunks).toMatchObject([{ sinceReview: "existing", present: false }, { sinceReview: "new", present: true }]);
  });

  test("checkbox approvals do not clear historical classification", async () => {
    // Given a new hunk after submission
    submit();
    await reconcile(secondHead, "replacement");
    const hunk = readSinceReview(storage.db, scope, "me").hunks.find((unit) => unit.present)!;
    // When it is checked
    await updateHunkApproval(storage, scope, hunk, true, secondHead);
    // Then it remains new
    expect(readSinceReview(storage.db, scope, "me").hunks.find((unit) => unit.present)?.sinceReview).toEqual("new");
  });

  test("another reviewer's submission does not invalidate my membership", () => {
    // Given my submitted review
    submit();
    // When a colleague submits a newer review
    observe(2, "someone-else");
    // Then my previous review remains usable
    expect(readSinceReview(storage.db, scope, "me").review?.id).toEqual(1);
  });

  test("my newer external review invalidates old membership", () => {
    // Given my captured submission
    submit();
    // When my newer external review has no historical base evidence
    observe(2, "ME");
    // Then old flags cannot be described as relative to the newer review
    expect(readSinceReview(storage.db, scope, "me")).toMatchObject({ review: undefined, hunks: [] });
  });

  test("an implicit review from a standalone comment does not advance history", () => {
    // Given my captured submission
    submit();
    // When GitHub creates an empty review for a standalone comment
    observe(2, "me", "COMMENTED", "");
    // Then the explicit submitted review still defines history
    expect(readSinceReview(storage.db, scope, "me").review?.id).toEqual(1);
  });

  test("an explicit inline-only submission establishes history", () => {
    // Given an admitted complete inventory
    const captured = captureSinceReview(storage.db, scope, firstHead, base)!;
    // When Biff confirms a comment-only review with no summary
    observe(1, "me", "COMMENTED", "");
    recordSinceReview(storage.db, scope, "me", 1, firstHead, base, captured.units);
    // Then the submission receipt distinguishes it from a standalone comment
    expect(readSinceReview(storage.db, scope, "me").review?.id).toEqual(1);
  });

  test("a held API submission does not absorb a concurrent base update", async () => {
    // Given a submission held at GitHub
    const held = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const github = new GitHub(async (args) => {
      if (args[2] === "repos/example/repo/pulls/1") return JSON.stringify(current.pr);
      if (args[2] !== "repos/example/repo/pulls/1/reviews") throw new Error(`Unexpected request: ${args.join(" ")}`);
      started.resolve();
      await held.promise;
      return JSON.stringify({ id: 1, state: "APPROVED", body: "", user: { login: "me" }, commit_id: firstHead, submitted_at: "2026-11-04T12:00:01Z", html_url: current.pr.html_url });
    }, storage);
    const api = createApi({ github, storage, workspaces: new Workspaces(storage) });
    const pending = api(new Request("http://127.0.0.1:4567/api/github/pr/example/repo/1/review", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ event: "APPROVE", commitId: firstHead, baseCommitId: base, body: "", comments: [] }) }));
    await started.promise;
    // When the base changes the diff before GitHub returns success
    await reconcile(firstHead, "replacement", "d".repeat(40));
    held.resolve();
    const result = await pending;
    if (!result.ok) throw new Error(await result.text());
    // Then the old submitted inventory is existing and the later hunk stays new
    expect(readSinceReview(storage.db, scope, "me").hunks).toMatchObject([{ sinceReview: "existing", present: false }, { sinceReview: "new", present: true }]);
  });

  test("a failed API submission preserves the previous review", async () => {
    // Given a successful review followed by new code
    submit();
    await reconcile(secondHead, "replacement");
    const before = readSinceReview(storage.db, scope, "me");
    // When GitHub rejects the next submission
    const github = new GitHub(async () => { throw new Error("Submission rejected"); }, storage);
    const api = createApi({ github, storage, workspaces: new Workspaces(storage) });
    await api(new Request("http://127.0.0.1:4567/api/github/pr/example/repo/1/review", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ event: "APPROVE", commitId: secondHead, baseCommitId: base, body: "", comments: [] }) }));
    // Then neither membership nor the submitted review changes
    expect(readSinceReview(storage.db, scope, "me")).toEqual(before);
  });

  test("the next successful submission retires older absent identities", async () => {
    // Given an existing hunk replaced after review
    submit();
    await reconcile(secondHead, "replacement");
    const captured = captureSinceReview(storage.db, scope, secondHead, base)!;
    // When the replacement is submitted in the next review
    observe(2, "me");
    recordSinceReview(storage.db, scope, "me", 2, secondHead, base, captured.units);
    // Then only the submitted current identity remains classified
    expect(readSinceReview(storage.db, scope, "me").hunks).toMatchObject([{ sinceReview: "existing", present: true }]);
  });

  test("replaying a successful receipt does not clear later new hunks", async () => {
    // Given a submission already recorded and a subsequent push
    const captured = captureSinceReview(storage.db, scope, firstHead, base)!;
    submit();
    await reconcile(secondHead, "replacement");
    const before = readSinceReview(storage.db, scope, "me");
    // When a retry recovers the original successful receipt
    recordSinceReview(storage.db, scope, "me", 1, firstHead, base, captured.units);
    // Then its original reset is not repeated
    expect(readSinceReview(storage.db, scope, "me")).toEqual(before);
  });

  test("a same-head base change cannot supply the displayed inventory", async () => {
    // Given a displayed head/base pair followed by base reconciliation
    await reconcile(firstHead, "replacement", "d".repeat(40));
    // When the old displayed comparison is captured for submission
    const captured = captureSinceReview(storage.db, scope, firstHead, base);
    // Then current hunks cannot masquerade as the old reviewed comparison
    expect(captured).toEqual(undefined);
  });
});
