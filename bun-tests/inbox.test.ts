import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { Inbox } from "../server/inbox";
import { Storage } from "../server/storage";
import { inboxMatches, type PullActivity } from "../shared/inbox";
import type { PullRequestSummary } from "../shared/types";
import { createApi } from "../server/api";
import { GitHub } from "../server/github";
import { Workspaces } from "../server/workspaces";

describe("Inbox", () => {
  let directory: string;
  let inbox: Inbox;
  let storage: Storage;
  let now: number;
  let row: PullRequestSummary;
  let activity: PullActivity;
  const id = "example/repo/1";

  beforeEach(async () => {
    directory = await mkdtemp("/tmp/opencode/biff-inbox-");
    now = 1_800_000_000_000;
    row = { number: 1, title: "A PR", url: "https://github.com/example/repo/pull/1", repository: { nameWithOwner: "example/repo" }, author: { login: "author" }, isDraft: false, updatedAt: "2026-10-18T00:00:00Z" };
    activity = { head: "a".repeat(40), headAuthor: "author", viewer: "me", reviewDecision: "REVIEW_REQUIRED", checks: "Passing", events: [] };
    storage = new Storage(join(directory, "inbox.sqlite"));
    inbox = new Inbox(storage, { dashboard: async () => [structuredClone(row)], dashboardActivity: async () => structuredClone(activity) }, () => now);
  });
  afterEach(async () => { await inbox.drain(); await storage.close(); await rm(directory, { recursive: true, force: true }); });

  test("saved queues appear immediately after a restart while GitHub refreshes", async () => {
    // Given a persisted queue older than the refresh interval
    await inbox.refresh("authored");
    await inbox.drain();
    await storage.close();
    now += 180_000;
    const remote = Promise.withResolvers<PullRequestSummary[]>();
    storage = new Storage(join(directory, "inbox.sqlite"));
    inbox = new Inbox(storage, { dashboard: () => remote.promise, dashboardActivity: async () => activity }, () => now);

    // When the dashboard opens while GitHub is still responding
    const saved = inbox.queue("authored");
    remote.resolve([row]);

    // Then the persisted title is already available
    expect(saved.items.map((pr) => pr.title)).toEqual(["A PR"]);
  });

  test("ignore survives new replies, new commits, and server restarts", async () => {
    // Given an ignored PR
    await inbox.refresh("authored");
    inbox.act(id, { action: "ignore" });

    // And new activity from another person
    activity.head = "b".repeat(40);
    activity.events.push({ key: "inline:2", actor: "author", at: "2026-10-19T00:00:00Z", kind: "reply" });
    row.updatedAt = "2026-10-19T00:00:00Z";

    // When the queue refreshes and Biff restarts
    await inbox.refresh("authored");
    await inbox.drain();
    await storage.close();
    storage = new Storage(join(directory, "inbox.sqlite"));
    inbox = new Inbox(storage, { dashboard: async () => [row], dashboardActivity: async () => activity }, () => now);
    const pr = inbox.queue("authored").items[0]!;

    // Then it appears only in the explicit ignored filter
    expect(["all", "unread", "snoozed", "ignored"].filter((filter) => inboxMatches(pr, filter as "all" | "unread" | "snoozed" | "ignored", now))).toEqual(["ignored"]);
  });

  test("snooze expires after one day", async () => {
    // Given a snoozed PR
    await inbox.refresh("authored");
    inbox.act(id, { action: "snooze" });

    // When a day has elapsed
    now += 86_400_001;

    // Then it returns to the active queue
    expect(inboxMatches(inbox.queue("authored").items[0]!, "all", now)).toEqual(true);
  });

  test("a new reply preserves the snooze deadline", async () => {
    // Given a snoozed PR
    await inbox.refresh("authored");
    inbox.act(id, { action: "snooze" });

    // When another person replies
    activity.events.push({ key: "general:4", actor: "author", at: "2026-10-19T00:00:00Z", kind: "reply" });
    row.updatedAt = "2026-10-19T00:00:00Z";
    await inbox.refresh("authored");

    // Then it stays snoozed until the original deadline
    expect(inbox.queue("authored").items[0]!.personal.snoozeUntil).toEqual(now + 86_400_000);
  });

  test("a new commit does not wake a snoozed PR", async () => {
    // Given a PR explicitly snoozed until tomorrow
    await inbox.refresh("authored");
    inbox.act(id, { action: "snooze" });

    // When a new commit appears
    activity.head = "b".repeat(40);
    row.updatedAt = "2026-10-19T00:00:00Z";
    await inbox.refresh("authored");

    // Then it remains snoozed
    expect(inboxMatches(inbox.queue("authored").items[0]!, "snoozed", now)).toEqual(true);
  });

  test("marking the displayed snapshot read does not consume a later commit", async () => {
    // Given an opened snapshot and a newer head arriving afterwards
    await inbox.refresh("authored");
    const displayed = activity.head;
    activity.head = "b".repeat(40);
    row.updatedAt = "2026-10-19T00:00:00Z";
    await inbox.refresh("authored");

    // When the old tab acknowledges its displayed revision
    inbox.act(id, { action: "seen", head: displayed });

    // Then the newer revision stays unread
    expect(inbox.queue("authored").items[0]!.newCommits).toEqual(true);
  });

  test("new replies exclude the authenticated person's own comments", async () => {
    // Given an existing PR with its initial activity baseline
    await inbox.refresh("authored");

    // When both the reader and a teammate reply
    activity.events.push({ key: "inline:1", thread: "inline:1", actor: "me", at: "2026-10-19", kind: "reply" }, { key: "inline:2", thread: "inline:1", actor: "author", at: "2026-10-19", kind: "reply" });
    row.updatedAt = "2026-10-19T00:00:00Z";
    await inbox.refresh("authored");

    // Then only the teammate's reply needs attention
    expect(inbox.queue("authored").items[0]!.newReplies).toEqual(1);
  });

  test("opening the queue does not acknowledge new activity", async () => {
    // Given an unread PR
    await inbox.refresh("authored");

    // When its queue is read repeatedly
    inbox.queue("authored");
    inbox.queue("authored");

    // Then it remains unread
    expect(inbox.queue("authored").items[0]!.unread).toEqual(true);
  });

  test("undo restores an ignored PR across both queues", async () => {
    // Given the same PR in both queues
    await inbox.refresh("authored");
    await inbox.refresh("requested");
    const receipt = inbox.act(id, { action: "ignore" });

    // When the ignore is undone
    inbox.act(id, { action: "undo", token: receipt.undo! });

    // Then the review-requested copy is restored too
    expect(inbox.queue("requested").items[0]!.personal.ignored).toEqual(false);
  });

  test("undo cannot overwrite a newer personal choice", async () => {
    // Given an ignore receipt followed by a newer pin decision
    await inbox.refresh("authored");
    const receipt = inbox.act(id, { action: "ignore" });
    inbox.act(id, { action: "pin" });

    // When an older tab tries to undo its ignore
    function undo() { inbox.act(id, { action: "undo", token: receipt.undo! }); }

    // Then the newer decision is protected
    expect(undo).toThrow("This PR changed since that action");
  });

  test("GitHub failures preserve the last queue", async () => {
    // Given a persisted queue
    await inbox.refresh("authored");
    await inbox.drain();
    await storage.close();
    storage = new Storage(join(directory, "inbox.sqlite"));
    inbox = new Inbox(storage, { dashboard: async () => { throw new Error("offline"); }, dashboardActivity: async () => activity }, () => now);

    // When GitHub cannot refresh it
    await inbox.refresh("authored");

    // Then the last saved PR remains available
    expect(inbox.queue("authored").items.map((pr) => pr.title)).toEqual(["A PR"]);
  });

  test("the public API persists Ignore without removing the GitHub snapshot", async () => {
    // Given a populated inbox served by the local API
    await inbox.refresh("authored");
    const api = createApi({ inbox, github: new GitHub(undefined, storage), workspaces: new Workspaces(storage) });

    // When the browser ignores the PR through its normal endpoint
    await api(new Request(`http://127.0.0.1:4567/api/github/pr/${id}/inbox`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "ignore" }) }));
    const response = await api(new Request("http://127.0.0.1:4567/api/inbox?view=authored"));
    const queue = await response.json();

    // Then the snapshot remains available for the Ignored filter
    expect(queue.items[0]).toMatchObject({ id, title: "A PR", personal: { ignored: true } });
  });

  test("read acknowledgments consume only the displayed discussion IDs", async () => {
    // Given two new replies after the initial snapshot
    activity.events.push({ key: "inline:0", thread: "inline:0", actor: "me", at: "2026-10-18", kind: "reply" });
    await inbox.refresh("authored");
    activity.events.push({ key: "inline:1", thread: "inline:0", actor: "author", at: "2026-10-19", kind: "reply" }, { key: "inline:2", thread: "inline:0", actor: "author", at: "2026-10-19", kind: "reply" });
    row.updatedAt = "2026-10-19T00:00:00Z";
    await inbox.refresh("authored");

    // When only the first reply is read in its thread
    inbox.act(id, { action: "seen", events: ["inline:1"] });

    // Then the second reply remains unread
    expect(inbox.queue("authored").items[0]!.newReplies).toEqual(1);
  });

  test("unrelated bot comments do not mark a read PR unread", async () => {
    // Given a read PR with a thread the viewer started
    activity.events.push({ key: "inline:1", thread: "inline:1", actor: "me", at: "2026-10-18", kind: "reply" });
    await inbox.refresh("authored");
    inbox.act(id, { action: "read" });

    // When bots post a top-level comment and a separate review thread
    activity.events.push(
      { key: "general:2", actor: "ci[bot]", at: "2026-10-19", kind: "reply" },
      { key: "inline:3", thread: "inline:3", actor: "review[bot]", at: "2026-10-19", kind: "reply" },
    );
    await inbox.refresh("authored");

    // Then unrelated comments produce neither a reply badge nor unread activity
    expect(inbox.queue("authored").items[0]).toMatchObject({ newReplies: 0, unread: false });
  });

  test("replies in other people's threads do not count without viewer participation", async () => {
    // Given another person's thread on a read PR
    activity.events.push({ key: "inline:1", thread: "inline:1", actor: "reviewer", at: "2026-10-18", kind: "reply" });
    await inbox.refresh("authored");
    inbox.act(id, { action: "read" });

    // When the author replies to that reviewer
    activity.events.push({ key: "inline:2", thread: "inline:1", actor: "author", at: "2026-10-19", kind: "reply" });
    await inbox.refresh("authored");

    // Then the reply does not need the viewer's attention
    expect(inbox.queue("authored").items[0]!.newReplies).toEqual(0);
  });

  test("replies count in threads the viewer joined without starting", async () => {
    // Given a thread started by a reviewer and joined by the viewer
    activity.events.push(
      { key: "inline:1", thread: "inline:1", actor: "reviewer", at: "2026-10-18", kind: "reply" },
      { key: "inline:2", thread: "inline:1", actor: "me", at: "2026-10-18", kind: "reply" },
    );
    await inbox.refresh("authored");

    // When the author replies after the baseline was read
    activity.events.push({ key: "inline:3", thread: "inline:1", actor: "author", at: "2026-10-19", kind: "reply" });
    await inbox.refresh("authored");

    // Then participation in the saved discussion qualifies the reply
    expect(inbox.queue("authored").items[0]!.newReplies).toEqual(1);
  });
});
