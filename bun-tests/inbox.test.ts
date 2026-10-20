import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { Inbox } from "../server/inbox";
import { Storage } from "../server/storage";
import { inboxMatches, type PullActivity } from "../shared/inbox";
import type { PullRequestSummary } from "../shared/types";
import type { TrackedPullRequest } from "../shared/inbox";
import { createApi } from "../server/api";
import { GitHub } from "../server/github";
import { Workspaces } from "../server/workspaces";
import { Progress } from "../server/progress";

const day = 86_400_000;
const flaggedBlock = { path: "file.ts", hash: "a".repeat(64), oldLine: 1, newLine: 1, duplicate: false };

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

  test("an existing review queue survives cleared requests and a schema upgrade", async () => {
    // Given a requested PR saved by the older queue-only schema
    await inbox.refresh("requested");
    storage.db.exec("DROP TABLE inbox_tracked_prs");
    // And an unrelated cached PR that was never in this review queue
    storage.db.query("INSERT INTO prs(id, summary) VALUES (?, ?)").run("example/repo/2", JSON.stringify({ ...row, number: 2 }));
    await storage.close();
    // And GitHub no longer requests this review after the user comments
    storage = new Storage(join(directory, "inbox.sqlite"));
    inbox = new Inbox(storage, {
      dashboard: async () => [], dashboardActivity: async () => activity,
      trackedPullRequests: async () => [{ pr: row, state: "OPEN", view: "requested" }],
    }, () => now);

    // When the upgraded inbox refreshes
    await inbox.refresh("requested");

    // Then the known open review remains in the queue
    expect(inbox.queue("requested").items.map((pr) => pr.id)).toEqual([id]);
  });

  test.each(["CLOSED", "MERGED"] as const)("read %s reviews archive seven days after closure", async (state) => {
    // Given a read PR that previously requested review
    await inbox.refresh("requested");
    inbox.act(id, { action: "read" });
    // And GitHub confirms it closed seven days ago, not just when Biff noticed it
    inbox = new Inbox(storage, {
      dashboard: async () => [], dashboardActivity: async () => activity,
      trackedPullRequests: async () => [{ pr: row, state, closedAt: new Date(now - 7 * day).toISOString(), view: "requested" }],
    }, () => now);

    // When refreshing the queue
    await inbox.refresh("requested");

    // Then it moves to locally searchable history instead of disappearing
    expect(inbox.queue("requested").items.filter((pr) => inboxMatches(pr, "archived", now)).map((pr) => pr.id)).toEqual([id]);
  });

  test("failed status checks preserve remembered reviews", async () => {
    // Given a requested PR that disappears from search
    await inbox.refresh("requested");
    // And GitHub cannot establish its current state
    inbox = new Inbox(storage, {
      dashboard: async () => [], dashboardActivity: async () => activity,
      trackedPullRequests: async () => { throw new Error("GitHub unavailable"); },
    }, () => now);

    // When refreshing the queue fails
    await inbox.refresh("requested");

    // Then its last saved entry is retained for retry
    expect(inbox.queue("requested").items.map((pr) => pr.id)).toEqual([id]);
  });

  test("retained reviews preserve personal ignore and snooze choices", async () => {
    // Given an ignored and snoozed review
    await inbox.refresh("requested");
    inbox.act(id, { action: "ignore" });
    inbox.act(id, { action: "snooze" });
    // And the PR remains open after its review request clears
    inbox = new Inbox(storage, {
      dashboard: async () => [], dashboardActivity: async () => activity,
      trackedPullRequests: async () => [{ pr: row, state: "OPEN", view: "requested" }],
    }, () => now);

    // When the remembered review is refreshed
    await inbox.refresh("requested");

    // Then refresh does not reset the user's queue choices
    expect(inbox.queue("requested").items[0].personal).toMatchObject({ ignored: true, snoozeUntil: now + 86_400_000 });
  });

  test("a manually submitted URL recovers an open PR absent from discovery", async () => {
    // Given an open PR that has never appeared in any saved queue
    inbox = new Inbox(storage, {
      dashboard: async () => [], dashboardActivity: async () => activity,
      trackedPullRequests: async () => [{ pr: row, state: "OPEN", view: "requested" }],
    }, () => now);
    const api = createApi({ inbox, github: new GitHub(), workspaces: new Workspaces(storage) });

    // When the URL box registers it before opening the review
    const response = await api(new Request(`http://127.0.0.1:4567/api/github/pr/${id}/track`, { method: "POST" }));
    if (!response.ok) throw new Error(await response.text());
    await inbox.refresh("requested");

    // Then the recovered review survives the next discovery search
    expect(inbox.queue("requested").items.map((pr) => pr.id)).toEqual([id]);
  });

  test("manual recovery during a refresh is not overwritten by the older snapshot", async () => {
    // Given a remembered review whose status check is in flight
    await inbox.refresh("requested");
    const started = Promise.withResolvers<void>();
    const remote = Promise.withResolvers<TrackedPullRequest[]>();
    const second = { ...row, number: 2 };
    inbox = new Inbox(storage, {
      dashboard: async () => [], dashboardActivity: async () => activity,
      trackedPullRequests: async (ids) => {
        if (ids[0] === id) { started.resolve(); return remote.promise; }
        return [{ pr: second, state: "OPEN", view: "requested" }];
      },
    }, () => now);
    const refresh = inbox.refresh("requested");
    await started.promise;

    // When another PR is manually recovered before that status check finishes
    await inbox.track("example/repo", "2");
    remote.resolve([{ pr: row, state: "OPEN", view: "requested" }]);
    await refresh;

    // Then the older refresh preserves both memberships
    expect(inbox.queue("requested").items.map((pr) => pr.id).sort()).toEqual([id, "example/repo/2"]);
  });

  test("a full discovery page does not evict a remembered review", async () => {
    // Given an old review that no longer appears in discovery
    await inbox.refresh("requested");
    // And a full page of newly requested reviews
    inbox = new Inbox(storage, {
      dashboard: async () => Array.from({ length: 100 }, (_, index) => ({ ...row, number: index + 2 })),
      dashboardActivity: async () => activity,
      trackedPullRequests: async () => [{ pr: row, state: "OPEN", view: "requested" }],
    }, () => now);

    // When discovery and remembered reviews are combined
    await inbox.refresh("requested");

    // Then all 101 reviews remain available
    expect(inbox.queue("requested").items).toHaveLength(101);
  });

  test("a recently merged read PR remains active for seven days", async () => {
    // Given a read PR merged six days ago
    await inbox.refresh("requested");
    inbox.act(id, { action: "read" });
    inbox = new Inbox(storage, closedSource(row, activity, now - 6 * day), () => now);

    // When checking its status
    await inbox.refresh("requested");

    // Then it remains in the active inbox with its merged status
    expect(inbox.queue("requested").items.filter((pr) => inboxMatches(pr, "all", now))).toMatchObject([{ id, state: "MERGED" }]);
  });

  test("new unread activity extends the closure window to fourteen days", async () => {
    // Given a read PR merged eight days ago
    await inbox.refresh("requested");
    inbox.act(id, { action: "read" });
    inbox = new Inbox(storage, closedSource(row, activity, now - 8 * day), () => now);
    // And a review arrives before this refresh decides whether to archive it
    activity.events.push({ key: "review:9", actor: "reviewer", at: new Date(now).toISOString(), kind: "review" });

    // When fetching current discussion activity
    await inbox.refresh("requested");

    // Then the newly unread PR stays active beyond the ordinary seven-day window
    expect(inbox.queue("requested").items.filter((pr) => inboxMatches(pr, "all", now))).toMatchObject([{ id, unread: true }]);
  });

  test("unread reviews archive fourteen days after closure", async () => {
    // Given an unread PR merged fourteen days ago
    await inbox.refresh("requested");
    inbox = new Inbox(storage, closedSource(row, activity, now - 14 * day), () => now);

    // When checking the unread retention deadline
    await inbox.refresh("requested");

    // Then it remains searchable in Archived rather than the active unread filter
    expect(inbox.queue("requested").items.filter((pr) => inboxMatches(pr, "unread", now))).toEqual([]);
  });

  test("explicit follow-ups keep old merged reviews active indefinitely", async () => {
    // Given a ninety-day-old merged PR with a deliberate follow-up
    await inbox.refresh("requested");
    await new Progress(storage).followUpHunk(id, flaggedBlock, "head", true);
    inbox = new Inbox(storage, closedSource(row, activity, now - 90 * day), () => now);

    // When the retention policy runs
    await inbox.refresh("requested");

    // Then the follow-up remains in the active queue
    expect(inbox.queue("requested").items.filter((pr) => inboxMatches(pr, "follow-ups", now))).toMatchObject([{ id, followUpCount: 1 }]);
  });

  test("clearing the last follow-up allows an old merged review to archive", async () => {
    // Given an old merged PR retained by a follow-up
    await inbox.refresh("requested");
    const progress = new Progress(storage);
    await progress.followUpHunk(id, flaggedBlock, "head", true);
    inbox = new Inbox(storage, closedSource(row, activity, now - 90 * day), () => now);
    await inbox.refresh("requested");

    // When the user clears that follow-up and the queue refreshes
    await progress.followUpHunk(id, flaggedBlock, "head", false);
    await inbox.refresh("requested");

    // Then the completed work moves to Archived
    expect(inbox.queue("requested").items.filter((pr) => inboxMatches(pr, "archived", now)).map((pr) => pr.id)).toEqual([id]);
  });

  test("a manual URL restores an already merged PR for seven days from opening", async () => {
    // Given a PR merged a month ago, absent from all queues
    inbox = new Inbox(storage, closedSource(row, activity, now - 30 * day), () => now);

    // When it is manually opened and refreshed six days later
    await inbox.track("example/repo", "1");
    now += 6 * day;
    await inbox.refresh("requested");

    // Then closure age does not immediately undo recovery
    expect(inbox.queue("requested").items.filter((pr) => inboxMatches(pr, "all", now)).map((pr) => pr.id)).toEqual([id]);
  });

  test("opening archived history grants a fixed seven-day window across reloads", async () => {
    // Given an archived month-old review
    await inbox.refresh("requested");
    inbox = new Inbox(storage, closedSource(row, activity, now - 30 * day), () => now);
    await inbox.refresh("requested");
    // And the user opens it from history
    inbox.openArchived(id);
    now += 6 * day;
    await inbox.refresh("requested");

    // When a reload occurs, followed by another two days
    inbox.openArchived(id);
    now += 2 * day;
    await inbox.refresh("requested");

    // Then reloading an active review has not extended its recovery window
    expect(inbox.queue("requested").items.filter((pr) => inboxMatches(pr, "all", now))).toEqual([]);
  });

  test("ordinary refreshes leave archived GitHub snapshots untouched", async () => {
    // Given a PR already archived by the retention policy
    await inbox.refresh("requested");
    inbox = new Inbox(storage, closedSource(row, activity, now - 30 * day), () => now);
    await inbox.refresh("requested");
    // And a remote title change after archival
    row.title = "Changed remotely";

    // When normal queue polling continues
    now += day;
    await inbox.refresh("requested");

    // Then the archived snapshot was not fetched in the background
    expect(inbox.queue("requested").items[0].title).toBe("A PR");
  });

  test("explicit history refresh updates archived snapshots", async () => {
    // Given an archived PR whose remote title has changed
    await inbox.refresh("requested");
    inbox = new Inbox(storage, closedSource(row, activity, now - 30 * day), () => now);
    await inbox.refresh("requested");
    // And the new remote title
    row.title = "Changed remotely";

    // When the reader explicitly refreshes history
    await inbox.refresh("requested", true);

    // Then the archived record receives the fresh GitHub data
    expect(inbox.queue("requested").items[0].title).toBe("Changed remotely");
  });

  test("archived records remain searchable after a year and a restart", async () => {
    // Given an archived PR in durable storage
    await inbox.refresh("requested");
    const source = closedSource(row, activity, now - 30 * day);
    inbox = new Inbox(storage, source, () => now);
    await inbox.refresh("requested");
    await inbox.drain();
    await storage.close();

    // When Biff restarts more than a year later
    now += 366 * day;
    storage = new Storage(join(directory, "inbox.sqlite"));
    inbox = new Inbox(storage, source, () => now);

    // Then history is retained without returning it to the active queue
    expect(inbox.queue("requested").items.filter((pr) => inboxMatches(pr, "archived", now)).map((pr) => pr.title)).toEqual(["A PR"]);
  });

  test("discussion failures cannot archive a potentially unread closed review", async () => {
    // Given an old, read review whose latest discussion cannot be loaded
    await inbox.refresh("requested");
    inbox.act(id, { action: "read" });
    inbox = new Inbox(storage, { ...closedSource(row, activity, now - 30 * day), dashboardActivity: async () => { throw new Error("offline"); } }, () => now);

    // When the metadata refresh succeeds but discussion refresh fails
    await inbox.refresh("requested");

    // Then Biff preserves active visibility until unread state can be established
    expect(inbox.queue("requested").items.filter((pr) => inboxMatches(pr, "all", now)).map((pr) => pr.id)).toEqual([id]);
  });

  test("a new local follow-up reactivates an already archived PR", async () => {
    // Given an archived review linked to local work
    await inbox.refresh("requested");
    inbox = new Inbox(storage, closedSource(row, activity, now - 30 * day), () => now);
    await inbox.refresh("requested");

    // When a follow-up is added without opening the PR page
    await new Progress(storage).followUpHunk(id, flaggedBlock, "head", true);

    // Then local queue polling restores its active follow-up visibility
    expect(inbox.queue("requested").items.filter((pr) => inboxMatches(pr, "follow-ups", now)).map((pr) => pr.id)).toEqual([id]);
  });
});

/** Model a merged PR that no longer appears in discovery, with fresh copies of remote data. */
function closedSource(row: PullRequestSummary, activity: PullActivity, closedAt: number) {
  return {
    dashboard: async () => [],
    dashboardActivity: async () => structuredClone(activity),
    trackedPullRequests: async (): Promise<TrackedPullRequest[]> => [{ pr: structuredClone(row), state: "MERGED", closedAt: new Date(closedAt).toISOString(), view: "requested" }],
  };
}
