import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Storage } from "../server/storage";
import { Inbox } from "../server/inbox";
import { beginHunkReconciliation, hunkApprovals, updateHunkApprovals } from "../server/logicalHunks";
import { reconcilePrComparison } from "../server/prComparison";
import { recordPullRequest, findReview } from "../server/reviewStore";
import { acknowledgeReviewChanges, reviewChangesStatus } from "../server/reviewChanges";
import { inboxMatches } from "../shared/inbox";
import type { DiscussionComment, GitHubReview, PullRequestSummary } from "../shared/types";
import { createApi } from "../server/api";
import { GitHub } from "../server/github";
import { Workspaces } from "../server/workspaces";

describe("reviewChanges", () => {
  let storage: Storage;
  let inbox: Inbox;
  let current: GitHubReview;
  let reviews: DiscussionComment[];
  const id = "example/repo/1";
  const firstHead = "a".repeat(40);
  const nextHead = "b".repeat(40);

  beforeEach(async () => {
    storage = new Storage();
    reviews = [];
    current = comparison(firstHead, "after");
    inbox = new Inbox(storage, "me", {
      dashboard: async () => [summary(current)],
      dashboardActivity: async () => {
        await reconcile();
        return { head: current.pr.head.sha, headAuthor: "author", checks: "Passing", reviewDecision: "APPROVED", reviewRequested: false,
          approvers: reviews.some((review) => review.state === "APPROVED") ? ["me"] : [], events: [], conversation: { comments: [], inline: [], reviews } };
      },
      syncThreads: reconcile,
      removeReviewRequest: async () => {},
    });
    await inbox.refresh("requested");
  });
  afterEach(async () => { await inbox.drain(); await storage.close(); });

  /** Exercise the same classified comparison used by dashboard thread synchronization. */
  async function reconcile() {
    await recordPullRequest(storage, id, [current.pr.head.sha], current.pr.state === "closed", current.pr.head.sha);
    await reconcilePrComparison(storage, { pullRequest: async () => current.pr, contents: async () => ({ oldFile: { name: "example.ts", contents: "before" }, newFile: { name: "example.ts", contents: "after" } }) }, id, current, beginHunkReconciliation(storage, id, "pr"));
  }

  /** Retain GitHub's receipt so later complete discussion snapshots do not remove the submitted review. */
  function publish(state = "APPROVED", head = current.pr.head.sha, version?: number) {
    const review = { id: reviews.length + 1, user: { login: "me" }, body: "Reviewed", html_url: "https://github.com/example/repo/pull/1", state, commit_id: head };
    reviews.push(review);
    inbox.recordReview(id, review, version === undefined ? undefined : { head, version });
  }

  test("first inventory is not new work", () => {
    // Given a tracked PR whose first complete comparison is known
    // When its Todo eligibility is read without an outstanding request
    const item = inbox.queue("requested").items[0];

    // Then initial discovery does not invent work
    expect(inboxMatches(item, "todo")).toEqual(false);
  });

  test("new reviewable hunks return an approved PR to Todo", async () => {
    // Given my completed approval without checking every hunk
    publish();

    // When a later head changes reviewable code
    current = comparison(nextHead, "changed");
    await inbox.refresh("requested");

    // Then this is new work independently of requests, messages, or follow-ups
    expect(inboxMatches(inbox.queue("requested").items[0], "todo")).toEqual(true);
  });

  test("an unchanged rebase does not return a reviewed PR to Todo", async () => {
    // Given a completed review
    publish();

    // When only the commit identity changes
    current = comparison(nextHead, "after");
    await inbox.refresh("requested");

    // Then unchanged unchecked hunks do not become new work
    expect(inboxMatches(inbox.queue("requested").items[0], "todo")).toEqual(false);
  });

  test("auto-reviewed file changes do not wake snooze", async () => {
    // Given a completed review and a snoozed PR
    publish();
    inbox.act(id, { action: "snooze" });
    const deadline = inbox.queue("requested").items[0].personal.snoozeUntil;

    // When the next comparison adds only a lockfile change
    current = { ...comparison(nextHead, "after"), patch: current.patch + patch("yarn.lock", "generated"), pr: { ...current.pr, head: { sha: nextHead, ref: "feature" }, changed_files: 2 } };
    await inbox.refresh("requested");

    // Then the snooze remains intact
    expect(inbox.queue("requested").items[0].personal.snoozeUntil).toEqual(deadline);
  });

  test("new reviewable changes unsnooze the PR", async () => {
    // Given a reviewed PR snoozed for one day
    publish();
    inbox.act(id, { action: "snooze" });

    // When reviewable code changes
    current = comparison(nextHead, "changed");
    await inbox.refresh("requested");

    // Then it is active immediately
    expect(inbox.queue("requested").items[0].personal.snoozeUntil).toEqual(0);
  });

  test("manual archive still hides new code", async () => {
    // Given a reviewed PR explicitly archived
    publish();
    await inbox.save(id, { action: "archive" });

    // When the PR changes
    current = comparison(nextHead, "changed");
    await inbox.refresh("requested");

    // Then new changes do not override the manual archive
    expect(inboxMatches(inbox.queue("requested").items[0], "todo")).toEqual(false);
  });

  test("code changes after requested changes get their own attention", async () => {
    // Given my review requesting changes
    publish("CHANGES_REQUESTED");

    // When the author changes code without re-requesting me
    current = comparison(nextHead, "changed");
    await inbox.refresh("requested");

    // Then the attention retains my prior review's context
    expect(reviewChangesStatus(storage.db, id, "me")).toMatchObject({ viewerNewChanges: true, previousReviewState: "CHANGES_REQUESTED" });
  });

  test("code changes after a comment-only review also become work", async () => {
    // Given a completed comment-only review
    publish("COMMENTED");

    // When the author updates code
    current = comparison(nextHead, "changed");
    await inbox.refresh("requested");

    // Then Todo includes the newly changed code
    expect(inboxMatches(inbox.queue("requested").items[0], "todo")).toEqual(true);
  });

  test("new code without a previous completed review does not create attention", async () => {
    // Given a PR I have not reviewed
    // When the author updates it
    current = comparison(nextHead, "changed");
    await inbox.refresh("requested");

    // Then tracking alone does not make its pushes my responsibility
    expect(inboxMatches(inbox.queue("requested").items[0], "todo")).toEqual(false);
  });

  test("a comment-only review clears existing new-change attention", async () => {
    // Given new reviewable changes after my approval
    publish();
    current = comparison(nextHead, "changed");
    await inbox.refresh("requested");

    // When GitHub acknowledges my comment-only review on this version
    publish("COMMENTED");

    // Then the pending new-code work is complete
    expect(reviewChangesStatus(storage.db, id, "me").viewerNewChanges).toEqual(false);
  });

  test("explicit acknowledgment clears only its displayed version", async () => {
    // Given pending changes on the current head
    publish();
    current = comparison(nextHead, "changed");
    await inbox.refresh("requested");
    const version = reviewChangesStatus(storage.db, id, "me").newChangesVersion!;

    // When I explicitly mark those changes reviewed
    await acknowledgeReviewChanges(storage, id, "me", { head: nextHead, version });

    // Then the boolean is cleared without publishing a GitHub review
    expect(reviewChangesStatus(storage.db, id, "me").viewerNewChanges).toEqual(false);
  });

  test("another push defeats an older explicit acknowledgment", async () => {
    // Given pending changes whose acknowledgment was prepared
    publish();
    current = comparison(nextHead, "changed");
    await inbox.refresh("requested");
    const version = reviewChangesStatus(storage.db, id, "me").newChangesVersion!;
    // And a newer comparison with additional code, even at the same head after a base update
    current = { ...comparison(nextHead, "changed again"), pr: { ...current.pr, base: { sha: "d".repeat(40), ref: "main" } } };
    await inbox.refresh("requested");

    // When an old acknowledgment arrives
    const attempt = acknowledgeReviewChanges(storage, id, "me", { head: nextHead, version });

    // Then it cannot clear unseen changes
    await expect(attempt).rejects.toThrow("The PR changed");
  });

  test("a review receipt in flight cannot clear a later comparison", async () => {
    // Given a review submitted against the first head and version
    publish();
    // And new code reconciled before GitHub's response arrives
    current = comparison(nextHead, "changed");
    await inbox.refresh("requested");

    // When the older review succeeds
    publish("COMMENTED", firstHead, 0);

    // Then the newer work is still pending
    expect(reviewChangesStatus(storage.db, id, "me").viewerNewChanges).toEqual(true);
  });

  test("replaying the same review receipt never acknowledges a later push", async () => {
    // Given my acknowledged review followed by new code
    publish();
    current = comparison(nextHead, "changed");
    await inbox.refresh("requested");

    // When an old publication receipt is retried
    inbox.recordReview(id, reviews[0]);

    // Then attention survives the replay
    expect(reviewChangesStatus(storage.db, id, "me").viewerNewChanges).toEqual(true);
  });

  test("checking all hunks does not implicitly acknowledge the PR", async () => {
    // Given pending reviewable changes
    publish();
    current = comparison(nextHead, "changed");
    await inbox.refresh("requested");
    const review = findReview(storage.db, id)!;
    const hunks = storage.db.query<{ path: string; hash: string; old_line: number; new_line: number }, [string, string]>("SELECT * FROM logical_hunks WHERE review_id=? AND pr_head=?").all(review.id, nextHead);

    // When every current hunk is checked
    await updateHunkApprovals(storage, id, hunks.map((hunk) => ({ identity: { path: hunk.path, hash: hunk.hash, oldLine: hunk.old_line, newLine: hunk.new_line, duplicate: false }, reviewed: true })), nextHead);
    await hunkApprovals(storage, id);

    // Then completion still needs an explicit acknowledgment or submitted review
    expect(reviewChangesStatus(storage.db, id, "me").viewerNewChanges).toEqual(true);
  });

  test("new changes on a completed PR do not become Todo", async () => {
    // Given a completed review
    publish();

    // When the final closed comparison differs
    current = { ...comparison(nextHead, "changed"), pr: { ...current.pr, state: "closed", head: { sha: nextHead, ref: "feature" } } };
    await inbox.refresh("requested");

    // Then completed work does not acquire new review attention
    expect(reviewChangesStatus(storage.db, id, "me").viewerNewChanges ?? false).toEqual(false);
  });

  test("repeated unchanged refreshes do not undo a later snooze", async () => {
    // Given new changes that I explicitly snoozed after discovery
    publish();
    current = comparison(nextHead, "changed");
    await inbox.refresh("requested");
    inbox.act(id, { action: "snooze" });
    const deadline = inbox.queue("requested").items[0].personal.snoozeUntil;

    // When the same comparison is refreshed again
    await inbox.refresh("requested");

    // Then the existing flag alone does not repeatedly wake the snooze
    expect(inbox.queue("requested").items[0].personal.snoozeUntil).toEqual(deadline);
  });

  test("implicit empty reviews from standalone inline comments do not clear attention", async () => {
    // Given pending reviewable code after approval
    publish();
    current = comparison(nextHead, "changed");
    await inbox.refresh("requested");
    // And GitHub's implicit review for a standalone inline comment
    reviews.push({ id: 2, user: { login: "me" }, body: "", html_url: "https://github.com/example/repo/pull/1", state: "COMMENTED", commit_id: nextHead });

    // When the discussion refresh discovers that implicit review
    await inbox.refresh("requested");

    // Then posting an ordinary inline comment has not acknowledged the PR
    expect(reviewChangesStatus(storage.db, id, "me").viewerNewChanges).toEqual(true);
  });

  test("an explicit inline-only review can clear attention", async () => {
    // Given pending changes after my approval
    publish();
    current = comparison(nextHead, "changed");
    await inbox.refresh("requested");
    const review = { id: 2, user: { login: "me" }, body: "", html_url: "https://github.com/example/repo/pull/1", state: "COMMENTED", commit_id: nextHead };
    reviews.push(review);

    // When Biff receives the explicit review submission receipt
    inbox.recordReview(id, review);
    await inbox.refresh("requested");

    // Then the empty summary does not prevent acknowledgment
    expect(reviewChangesStatus(storage.db, id, "me").viewerNewChanges).toEqual(false);
  });

  test("incomplete comparisons preserve the previous inventory and snooze", async () => {
    // Given a snoozed reviewed PR
    publish();
    inbox.act(id, { action: "snooze" });
    const deadline = inbox.queue("requested").items[0].personal.snoozeUntil;

    // When a truncated diff omits one of GitHub's reported changed files
    current = { ...comparison(nextHead, "changed"), pr: { ...current.pr, head: { sha: nextHead, ref: "feature" }, changed_files: 2 } };
    await inbox.refresh("requested");

    // Then incomplete evidence cannot wake the review
    expect(inbox.queue("requested").items[0].personal.snoozeUntil).toEqual(deadline);
  });

  test("a historical hunk becoming present again is new work without a new row", async () => {
    // Given two previously seen comparisons, with the newer one acknowledged
    publish();
    current = comparison(nextHead, "changed");
    await inbox.refresh("requested");
    await acknowledgeReviewChanges(storage, id, "me", { head: nextHead, version: 1 });

    // When the old hunk returns in a later comparison
    current = comparison("d".repeat(40), "after");
    await inbox.refresh("requested");

    // Then reusing its historical identity still creates attention
    expect(reviewChangesStatus(storage.db, id, "me").viewerNewChanges).toEqual(true);
  });

  test("a held API review submission cannot acknowledge a newer base comparison", async () => {
    // Given pending changes and an explicit review held at GitHub
    publish();
    current = comparison(nextHead, "changed");
    await inbox.refresh("requested");
    const held = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const github = new GitHub(async (args) => {
      if (args[2] === "user") return JSON.stringify({ login: "me" });
      if (args[2] === "repos/example/repo/pulls/1") return JSON.stringify(current.pr);
      if (args[2] !== "repos/example/repo/pulls/1/reviews") throw new Error(`Unexpected request: ${args.join(" ")}`);
      started.resolve();
      await held.promise;
      return JSON.stringify({ id: 2, state: "COMMENTED", body: "Reviewed", user: { login: "me" }, commit_id: nextHead, html_url: current.pr.html_url });
    }, storage);
    const api = createApi({ github, storage, inbox, workspaces: new Workspaces(storage) });
    const submitted = api(new Request("http://127.0.0.1:4567/api/github/pr/example/repo/1/review", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ event: "COMMENT", commitId: nextHead, body: "Reviewed", comments: [] }),
    }));
    await started.promise;

    // When new reviewable edits appear at the same head after a base update, before publication completes
    current = { ...comparison(nextHead, "newer"), pr: { ...current.pr, base: { sha: "d".repeat(40), ref: "main" } } };
    await inbox.refresh("requested");
    held.resolve();
    await submitted;

    // Then the API's admission version protects the newer code from the older receipt
    expect(reviewChangesStatus(storage.db, id, "me").viewerNewChanges).toEqual(true);
  });
});

/** Small complete comparisons exercise classification rather than faking its output. */
function comparison(head: string, added: string): GitHubReview {
  return { pr: { number: 1, title: "Review me", body: "", html_url: "https://github.com/example/repo/pull/1", state: "open", draft: false, user: { login: "author" }, head: { sha: head, ref: "feature" }, base: { sha: "c".repeat(40), ref: "main" }, changed_files: 1 }, commits: [], commit: "all", patch: patch("example.ts", added) };
}

/** A single text edit makes unchanged-head and content changes easy to distinguish. */
function patch(path: string, added: string): string {
  return `diff --git a/${path} b/${path}\nindex 1234567..7654321 100644\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-before\n+${added}\n`;
}

/** Dashboard timestamps are invalidation hints, never acknowledgments. */
function summary(current: GitHubReview): PullRequestSummary {
  return { number: 1, title: current.pr.title, url: current.pr.html_url, repository: { nameWithOwner: "example/repo" }, author: { login: "author" }, isDraft: false, updatedAt: current.pr.head.sha };
}
