import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { Storage } from "../server/storage";
import { Inbox } from "../server/inbox";
import { PrActivity } from "../server/prActivity";
import { recordReviewableChanges, reviewChangesStatus } from "../server/reviewChanges";

describe("inboxPersistence", () => {
  let directory: string;
  let storage: Storage;
  const id = "example/repo/1";
  const now = 1_800_000_000_000;
  const summary = { number: 1, title: "A PR", url: "https://github.com/example/repo/pull/1", repository: { nameWithOwner: "Example/Repo" }, author: { login: "author" }, isDraft: true, updatedAt: "2026-10-26T00:00:00Z", createdAt: "2026-10-25T00:00:00Z" };
  const activity = { head: "abc", headAuthor: "author", reviewDecision: "", checks: "Passing", events: [] };
  const source = { dashboard: async () => [], dashboardActivity: async () => activity };

  beforeEach(async () => {
    directory = await mkdtemp("/tmp/opencode/biff-inbox-persistence-");
    storage = new Storage(`${directory}/inbox.sqlite`);
    const activities = new PrActivity(storage.db);
    activities.summary(summary);
    activities.save(id, activity);
    storage.db.query("UPDATE prs SET activity_updated=?,activity_error='offline' WHERE id=?").run(summary.updatedAt, id);
  });
  afterEach(async () => { await storage.close(); await rm(directory, { recursive: true, force: true }); });

  test("PR summaries and independently cached activity survive restarts", async () => {
    // Given a PR with its summary, activity, and error cached independently
    // When successive startups open the database
    await reopen();
    await reopen();

    // Then all cached PR data survives
    expect(storage.db.query("SELECT * FROM prs").all()).toEqual([{
      id, number: 1, title: summary.title, url: summary.url, repository: "Example/Repo", author: "author", is_draft: 1,
      updated_at: summary.updatedAt, created_at: summary.createdAt, head_sha: "abc", head_author: "author", review_decision: "", review_requested: null, checks: "Passing", discussion_version: 0, activity_updated: summary.updatedAt, activity_error: "offline",
    }]);
  });

  test("an outstanding undo receipt remains usable after restart", async () => {
    // Given an archive action with a still-valid receipt
    storage.db.query("INSERT INTO pr_user_state (id,archived) VALUES (?,1)").run(id);
    storage.db.query("INSERT INTO undo VALUES (?,?,0,?,?,1,0,0,?)").run("receipt", id, now, now + 1000, now + 60_000);

    // When the receipt is used after another restart
    await reopen();
    const result = new Inbox(storage, "me", source, () => now).act(id, { action: "undo", token: "receipt" });

    // Then the prior choices are restored through the normal inbox API
    expect(result.item?.personal).toEqual({ archived: false, restoredUntil: now, snoozeUntil: now + 1000 });
  });

  test("a persisted receipt cannot overwrite a newer personal choice", async () => {
    // Given a receipt whose after-state no longer matches personal state
    storage.db.query("INSERT INTO pr_user_state (id,archived,snooze_until) VALUES (?,1,?)").run(id, now);
    storage.db.query("INSERT INTO undo VALUES (?,?,0,0,0,1,0,0,?)").run("receipt", id, now + 60_000);

    // When an old tab tries to undo after restart
    await reopen();
    const inbox = new Inbox(storage, "me", source, () => now);

    // Then the stale action is rejected
    expect(() => inbox.act(id, { action: "undo", token: "receipt" })).toThrow("This PR changed since that action");
  });

  test("receipt expiry survives restart", async () => {
    // Given an expired receipt
    storage.db.query("INSERT INTO pr_user_state (id,archived) VALUES (?,1)").run(id);
    storage.db.query("INSERT INTO undo VALUES (?,?,0,0,0,1,0,0,?)").run("receipt", id, now - 1);

    // When the expired receipt is used after restart
    await reopen();
    const inbox = new Inbox(storage, "me", source, () => now);

    // Then expiry is still enforced
    expect(() => inbox.act(id, { action: "undo", token: "receipt" })).toThrow("Undo has expired");
  });

  test("new undo receipts survive restarting the server", async () => {
    // Given a new archive receipt
    const receipt = new Inbox(storage, "me", source, () => now).act(id, { action: "archive" });

    // When the server restarts and the action is undone
    await reopen();
    const result = new Inbox(storage, "me", source, () => now).act(id, { action: "undo", token: receipt.undo! });

    // Then all original choices are restored
    expect(result.item?.personal).toEqual({ archived: false, restoredUntil: 0, snoozeUntil: 0 });
  });

  test("new-change attention and its previous-review context survive restart", async () => {
    // Given durable attention after my requested-changes review
    const inbox = new Inbox(storage, "me", source, () => now);
    inbox.recordReview(id, { id: 123, user: { login: "Me" }, body: "Please update this", state: "CHANGES_REQUESTED", commit_id: "abc", html_url: summary.url });
    recordReviewableChanges(storage.db, id);

    // When a new server opens the same database before refreshing GitHub
    await reopen();

    // Then both attention and its context are immediately available
    expect(reviewChangesStatus(storage.db, id, "ME")).toEqual({ viewerNewChanges: true, newChangesVersion: 1, previousReviewState: "CHANGES_REQUESTED" });
  });

  test("another account does not inherit new-change attention", async () => {
    // Given attention registered for my completed review
    const inbox = new Inbox(storage, "me", source, () => now);
    inbox.recordReview(id, { id: 123, user: { login: "me" }, body: "Approved", state: "APPROVED", commit_id: "abc", html_url: summary.url });
    recordReviewableChanges(storage.db, id);

    // When a different authenticated reader projects the cached status
    const status = reviewChangesStatus(storage.db, id, "other");

    // Then my pending work is not attributed to that reader
    expect(status).toEqual({});
  });

  /** Reopen the physical database rather than reusing cached service state. */
  async function reopen() {
    await storage.close();
    storage = new Storage(`${directory}/inbox.sqlite`);
  }
});
