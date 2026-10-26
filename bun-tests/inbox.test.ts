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
    activity = { head: "a".repeat(40), headAuthor: "author", viewer: "me", reviewRequested: true, reviewDecision: "REVIEW_REQUIRED", checks: "Passing", events: [] };
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

  test("manual archive survives new replies, new commits, and server restarts", async () => {
    // Given a manually archived PR
    await inbox.refresh("authored");
    inbox.act(id, { action: "archive" });

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

    // Then it remains in history and All, not active work
    expect((["todo", "unread", "snoozed", "archived", "all"] as const).filter((filter) => inboxMatches(pr, filter, now))).toEqual(["archived", "all"]);
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

  test("new commits do not create unread messages", async () => {
    // Given a PR without unread discussion
    await inbox.refresh("authored");

    // When a newer head arrives
    activity.head = "b".repeat(40);
    row.updatedAt = "2026-10-19T00:00:00Z";
    await inbox.refresh("authored");

    // Then commit state is not confused with unread discussion
    expect(inbox.queue("authored").items[0]!.unread).toEqual(false);
  });

  test("new replies exclude the authenticated person's own comments", async () => {
    // Given an existing PR with its initial activity baseline
    await inbox.refresh("authored");

    // When both the reader and a teammate reply
    activity.events.push({ key: "inline:1", thread: "inline:1", actor: "me", at: "2026-10-19", kind: "reply" }, { key: "inline:2", thread: "inline:1", actor: "author", at: "2026-10-19", kind: "reply" });
    row.updatedAt = "2026-10-19T00:00:00Z";
    await inbox.refresh("authored");

    // Then only the teammate's reply needs attention
    expect(inbox.queue("authored").items[0]!.unreadThreads).toEqual(1);
  });

  test("opening the queue does not acknowledge new activity", async () => {
    // Given an unread PR
    activity.events = [{ key: "inline:1", thread: "inline:1", actor: "me", at: "", kind: "reply" }, { key: "inline:2", thread: "inline:1", actor: "author", at: "", kind: "reply" }];
    await inbox.refresh("authored");

    // When its queue is read repeatedly
    inbox.queue("authored");
    inbox.queue("authored");

    // Then it remains unread
    expect(inbox.queue("authored").items[0]!.unread).toEqual(true);
  });

  test("undo restores an archived PR across both queues", async () => {
    // Given the same PR in both queues
    await inbox.refresh("authored");
    await inbox.refresh("requested");
    const receipt = inbox.act(id, { action: "archive" });

    // When the archive is undone
    inbox.act(id, { action: "undo", token: receipt.undo! });

    // Then the review-requested copy is restored too
    expect(inbox.queue("requested").items[0]!.personal.archived).toEqual(false);
  });

  test("undo cannot overwrite a newer personal choice", async () => {
    // Given an archive receipt followed by a newer snooze decision
    await inbox.refresh("authored");
    const receipt = inbox.act(id, { action: "archive" });
    inbox.act(id, { action: "snooze" });

    // When an older tab tries to undo its archive
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

  test("the public API persists Archive without removing the GitHub snapshot", async () => {
    // Given a populated inbox served by the local API
    await inbox.refresh("authored");
    const api = createApi({ inbox, github: new GitHub(undefined, storage), workspaces: new Workspaces(storage) });

    // When the browser archives the PR through its normal endpoint
    await api(new Request(`http://127.0.0.1:4567/api/github/pr/${id}/inbox`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "archive" }) }));
    const response = await api(new Request("http://127.0.0.1:4567/api/inbox?view=authored"));
    const queue = await response.json();

    // Then the snapshot remains available for the Archived filter
    expect(queue.items[0]).toMatchObject({ id, title: "A PR", personal: { archived: true } });
  });

  test("read acknowledgments consume only the displayed discussion IDs", async () => {
    // Given two new replies after the initial snapshot
    activity.events.push({ key: "inline:0", thread: "inline:0", actor: "me", at: "2026-10-18", kind: "reply" });
    await inbox.refresh("authored");
    activity.events.push({ key: "inline:1", thread: "inline:0", actor: "author", at: "2026-10-19", kind: "reply" }, { key: "inline:2", thread: "inline:0", actor: "author", at: "2026-10-19", kind: "reply" });
    row.updatedAt = "2026-10-19T00:00:00Z";
    await inbox.refresh("authored");

    // When only the first reply is read in its thread
    await new Progress(storage).commentReads(id, ["github:1"]);

    // Then the second reply remains unread
    expect(inbox.queue("authored").items[0]!.unreadThreads).toEqual(1);
  });

  test("unrelated bot comments do not mark a read PR unread", async () => {
    // Given a read PR with a thread the viewer started
    activity.events.push({ key: "inline:1", thread: "inline:1", actor: "me", at: "2026-10-18", kind: "reply" });
    await inbox.refresh("authored");

    // When bots post a top-level comment and a separate review thread
    activity.events.push(
      { key: "general:2", actor: "ci[bot]", at: "2026-10-19", kind: "reply" },
      { key: "inline:3", thread: "inline:3", actor: "review[bot]", at: "2026-10-19", kind: "reply" },
    );
    await inbox.refresh("authored");

    // Then unrelated comments produce neither a reply badge nor unread activity
    expect(inbox.queue("authored").items[0]).toMatchObject({ unreadThreads: 0, unread: false });
  });

  test("replies in other people's threads do not count without viewer participation", async () => {
    // Given another person's thread on a read PR
    activity.events.push({ key: "inline:1", thread: "inline:1", actor: "reviewer", at: "2026-10-18", kind: "reply" });
    await inbox.refresh("authored");

    // When the author replies to that reviewer
    activity.events.push({ key: "inline:2", thread: "inline:1", actor: "author", at: "2026-10-19", kind: "reply" });
    await inbox.refresh("authored");

    // Then the reply does not need the viewer's attention
    expect(inbox.queue("authored").items[0]!.unreadThreads).toEqual(0);
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
    expect(inbox.queue("authored").items[0]!.unreadThreads).toEqual(1);
  });

  test("an existing review queue survives cleared requests and a schema upgrade", async () => {
    // Given a requested PR saved by the older queue-only schema
    await inbox.refresh("requested");
    storage.db.exec("DROP TABLE inbox_tracked_prs");
    // And an unrelated cached PR that was never in this review queue
    storage.db.query(`INSERT INTO prs (id, number, title, url, repository, author, is_draft, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run("example/repo/2", 2, row.title, row.url, row.repository.nameWithOwner, row.author.login, Number(row.isDraft), row.updatedAt);
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

  test("retained reviews preserve personal archive and snooze choices", async () => {
    // Given an archived and snoozed review
    await inbox.refresh("requested");
    inbox.act(id, { action: "archive" });
    inbox.act(id, { action: "snooze" });
    // And the PR remains open after its review request clears
    inbox = new Inbox(storage, {
      dashboard: async () => [], dashboardActivity: async () => activity,
      trackedPullRequests: async () => [{ pr: row, state: "OPEN", view: "requested" }],
    }, () => now);

    // When the remembered review is refreshed
    await inbox.refresh("requested");

    // Then refresh does not reset the user's queue choices
    expect(inbox.queue("requested").items[0].personal).toMatchObject({ archived: true, snoozeUntil: now + 86_400_000 });
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
    inbox = new Inbox(storage, closedSource(row, activity, now - 6 * day), () => now);

    // When checking its status
    await inbox.refresh("requested");

    // Then it remains in the active inbox with its merged status
    expect(inbox.queue("requested").items[0]).toMatchObject({ id, state: "MERGED", archivedAt: undefined });
  });

  test("unread replies block automatic archival beyond seven days", async () => {
    // Given a read PR merged eight days ago
    await inbox.refresh("requested");
    inbox = new Inbox(storage, closedSource(row, activity, now - 8 * day), () => now);
    // And a reply arrives in a thread I started
    activity.events.push({ key: "inline:1", thread: "inline:1", actor: "me", at: "", kind: "reply" }, { key: "inline:2", thread: "inline:1", actor: "author", at: "", kind: "reply" });

    // When fetching current discussion activity
    await inbox.refresh("requested");

    // Then the newly unread PR stays active beyond the ordinary seven-day window
    expect(inbox.queue("requested").items.filter((pr) => inboxMatches(pr, "todo", now))).toMatchObject([{ id, unread: true }]);
  });

  test("unread replies never time out into archival", async () => {
    // Given an unread reply on a PR merged ninety days ago
    activity.events = [{ key: "inline:1", thread: "inline:1", actor: "me", at: "", kind: "reply" }, { key: "inline:2", thread: "inline:1", actor: "author", at: "", kind: "reply" }];
    await inbox.refresh("requested");
    inbox = new Inbox(storage, closedSource(row, activity, now - 90 * day), () => now);

    // When checking archival eligibility
    await inbox.refresh("requested");

    // Then it remains in Unread instead of timing out
    expect(inbox.queue("requested").items.filter((pr) => inboxMatches(pr, "unread", now)).map((pr) => pr.id)).toEqual([id]);
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

  test("opening a manual URL does not restore an old merged PR", async () => {
    // Given a PR merged a month ago, absent from all queues
    inbox = new Inbox(storage, closedSource(row, activity, now - 30 * day), () => now);

    // When it is manually opened and refreshed six days later
    await inbox.track("example/repo", "1");
    now += 6 * day;
    await inbox.refresh("requested");

    // Then reading history does not undo automatic archival
    expect(inbox.queue("requested").items.filter((pr) => inboxMatches(pr, "archived", now)).map((pr) => pr.id)).toEqual([id]);
  });

  test("explicit Restore grants seven days without extending on navigation", async () => {
    // Given an archived month-old review
    await inbox.refresh("requested");
    inbox = new Inbox(storage, closedSource(row, activity, now - 30 * day), () => now);
    await inbox.refresh("requested");
    // And the user explicitly restores it from history
    inbox.act(id, { action: "restore" });
    now += 6 * day;
    await inbox.refresh("requested");

    // When a reload occurs, followed by another two days
    await inbox.track("example/repo", "1");
    now += 2 * day;
    await inbox.refresh("requested");

    // Then reloading an active review has not extended its recovery window
    expect(inbox.queue("requested").items.filter((pr) => inboxMatches(pr, "archived", now)).map((pr) => pr.id)).toEqual([id]);
  });

  test("ordinary refreshes leave manually archived GitHub snapshots untouched", async () => {
    // Given a PR already archived by the retention policy
    await inbox.refresh("requested");
    inbox = new Inbox(storage, closedSource(row, activity, now - 30 * day), () => now);
    await inbox.refresh("requested");
    inbox.act(id, { action: "archive" });
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
    inbox = new Inbox(storage, { ...closedSource(row, activity, now - 30 * day), dashboardActivity: async () => { throw new Error("offline"); } }, () => now);

    // When the metadata refresh succeeds but discussion refresh fails
    await inbox.refresh("requested");

    // Then Biff preserves active visibility until unread state can be established
    expect(inbox.queue("requested").items[0].archivedAt).toEqual(undefined);
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

  test("own PRs count conversations rather than individual comments", async () => {
    // Given two messages in an inline thread and one general conversation on my PR
    row.author.login = "me";
    activity.events = [
      { key: "inline:1", thread: "inline:1", actor: "reviewer", at: "", kind: "reply" },
      { key: "inline:2", thread: "inline:1", actor: "reviewer", at: "", kind: "reply" },
      { key: "general:3", thread: "general", actor: "reviewer", at: "", kind: "reply" },
      { key: "review:4", actor: "reviewer", at: "", kind: "review", hasBody: false },
    ];

    // When the dashboard discovers the PR
    await inbox.refresh("authored");

    // Then approvals without text add no conversation to read
    expect(inbox.queue("authored").items[0]!.unreadThreads).toEqual(2);
  });

  test("thread acknowledgements through the public API update the dashboard", async () => {
    // Given my PR with one unread thread
    row.author.login = "me";
    activity.events = [{ key: "inline:1", thread: "inline:1", actor: "reviewer", at: "", kind: "reply" }];
    await inbox.refresh("authored");
    const api = createApi({ inbox, progress: new Progress(storage), github: new GitHub(undefined, storage), workspaces: new Workspaces(storage) });

    // When the reader acknowledges its exact displayed message
    await api(new Request(`http://127.0.0.1:4567/api/github/pr/${id}/comment-reads`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ keys: ["github:1"] }) }));

    // Then the dashboard uses that same persisted receipt immediately
    expect(inbox.queue("authored").items[0]!.unreadThreads).toEqual(0);
  });

  test("a reply arriving after acknowledgement reopens only its conversation", async () => {
    // Given an acknowledged thread I participated in on someone else's PR
    activity.events = [
      { key: "inline:1", thread: "inline:1", actor: "me", at: "", kind: "reply" },
      { key: "inline:2", thread: "inline:1", actor: "author", at: "", kind: "reply" },
      { key: "inline:3", thread: "inline:3", actor: "other", at: "", kind: "reply" },
    ];
    await inbox.refresh("requested");
    await new Progress(storage).commentReads(id, ["github:2"]);

    // When another reply arrives in my thread
    activity.events.push({ key: "inline:4", thread: "inline:1", actor: "author", at: "", kind: "reply" });
    await inbox.refresh("requested");

    // Then the unrelated thread does not contribute to my queue
    expect(inbox.queue("requested").items[0]!.unreadThreads).toEqual(1);
  });

  test("a review request stays Todo after its last reply is read", async () => {
    // Given a requested review with one reply to my thread
    activity.events = [{ key: "inline:1", thread: "inline:1", actor: "me", at: "", kind: "reply" }, { key: "inline:2", thread: "inline:1", actor: "author", at: "", kind: "reply" }];
    await inbox.refresh("requested");

    // When I read that reply
    await new Progress(storage).commentReads(id, ["github:2"]);

    // Then the review request alone keeps it in Todo
    expect(inboxMatches(inbox.queue("requested").items[0], "todo", now)).toEqual(true);
  });

  test("clearing a review request leaves a read PR only in All", async () => {
    // Given a tracked requested review
    await inbox.refresh("requested");
    // And GitHub no longer requests my review
    activity.reviewRequested = false;
    inbox = new Inbox(storage, {
      dashboard: async () => [], dashboardActivity: async () => activity,
      trackedPullRequests: async () => [{ pr: row, state: "OPEN", view: "requested" }],
    }, () => now);

    // When the retained PR refreshes
    await inbox.refresh("requested");

    // Then read history is kept without being treated as outstanding work
    expect((["todo", "unread", "follow-ups", "archived", "all"] as const).filter((filter) => inboxMatches(inbox.queue("requested").items[0], filter, now))).toEqual(["all"]);
  });

  test("a follow-up retains a PR after its review request clears", async () => {
    // Given a PR without an outstanding review request
    activity.reviewRequested = false;
    await inbox.refresh("requested");

    // When I flag a follow-up
    await new Progress(storage).followUpHunk(id, flaggedBlock, "head", true);

    // Then the remembered work belongs in Todo
    expect(inboxMatches(inbox.queue("requested").items[0], "todo", now)).toEqual(true);
  });

  test("my approval archives a completed PR immediately", async () => {
    // Given my approval on a PR that just merged without outstanding discussion
    activity.approvers = ["me"];
    await inbox.refresh("requested");
    inbox = new Inbox(storage, closedSource(row, activity, now), () => now);

    // When its merged status refreshes
    await inbox.refresh("requested");

    // Then approval skips the seven-day wait
    expect(inboxMatches(inbox.queue("requested").items[0], "archived", now)).toEqual(true);
  });

  test("another reviewer's approval does not skip my seven-day wait", async () => {
    // Given someone else's approval on a newly merged PR
    activity.approvers = ["someone-else"];
    await inbox.refresh("requested");
    inbox = new Inbox(storage, closedSource(row, activity, now), () => now);

    // When its merged status refreshes
    await inbox.refresh("requested");

    // Then it has not automatically archived
    expect(inboxMatches(inbox.queue("requested").items[0], "archived", now)).toEqual(false);
  });

  test("approval never auto-archives an open PR", async () => {
    // Given my approved but still open PR
    activity.approvers = ["me"];

    // When it refreshes
    await inbox.refresh("requested");

    // Then it remains outside Archived
    expect(inboxMatches(inbox.queue("requested").items[0], "archived", now)).toEqual(false);
  });

  test("reading the last reply allows immediate archival of my approved merged PR", async () => {
    // Given my approved merged PR retained by one unread reply
    activity.approvers = ["me"];
    activity.events = [{ key: "inline:1", thread: "inline:1", actor: "me", at: "", kind: "reply" }, { key: "inline:2", thread: "inline:1", actor: "author", at: "", kind: "reply" }];
    await inbox.refresh("requested");
    inbox = new Inbox(storage, closedSource(row, activity, now), () => now);
    await inbox.refresh("requested");

    // When I explicitly read the reply without another GitHub refresh
    await new Progress(storage).commentReads(id, ["github:2"]);

    // Then local polling moves the completed PR to Archived
    expect(inboxMatches(inbox.queue("requested").items[0], "archived", now)).toEqual(true);
  });

  test("a new reply reactivates an automatically archived PR", async () => {
    // Given an automatically archived PR containing my comment
    activity.approvers = ["me"];
    activity.events = [{ key: "inline:1", thread: "inline:1", actor: "me", at: "", kind: "reply" }];
    await inbox.refresh("requested");
    inbox = new Inbox(storage, closedSource(row, activity, now - 30 * day), () => now);
    await inbox.refresh("requested");
    // And a later reply to my comment
    activity.events.push({ key: "inline:2", thread: "inline:1", actor: "author", at: "", kind: "reply" });
    row.updatedAt = new Date(now).toISOString();

    // When normal polling refreshes automatically archived history
    await inbox.refresh("requested");

    // Then the reply brings it back to Todo
    expect(inboxMatches(inbox.queue("requested").items[0], "todo", now)).toEqual(true);
  });

  test("manual archive overrides a local follow-up", async () => {
    // Given a manually archived PR
    await inbox.refresh("requested");
    inbox.act(id, { action: "archive" });

    // When a follow-up is added from linked local work
    await new Progress(storage).followUpHunk(id, flaggedBlock, "head", true);

    // Then manual intent still hides it from Todo
    expect(inboxMatches(inbox.queue("requested").items[0], "todo", now)).toEqual(false);
  });

  test("closure metadata cannot archive a PR before its new discussion arrives", async () => {
    // Given my approved open PR with no previously unread messages
    activity.approvers = ["me"];
    await inbox.refresh("requested");
    // And closure metadata arrives before a held discussion refresh
    const held = Promise.withResolvers<PullActivity>();
    const started = Promise.withResolvers<void>();
    row.updatedAt = new Date(now).toISOString();
    inbox = new Inbox(storage, { ...closedSource(row, activity, now), dashboardActivity: () => { started.resolve(); return held.promise; } }, () => now);
    const refresh = inbox.refresh("requested");
    await started.promise;

    // When local polling runs while GitHub discussion is still loading
    const snapshot = inbox.queue("requested");
    held.resolve(activity);
    await refresh;

    // Then the in-flight snapshot does not prematurely archive completed work
    expect(snapshot.items[0].archivedAt).toEqual(undefined);
  });
  for (const [event, state, decision, approvers] of [
    ["COMMENT", "COMMENTED", "REVIEW_REQUIRED", ["other", "me"]],
    ["APPROVE", "APPROVED", "APPROVED", ["other", "me"]],
    ["REQUEST_CHANGES", "CHANGES_REQUESTED", "CHANGES_REQUESTED", ["other"]],
  ] as const) {
    test(`${event} updates the saved inbox immediately after GitHub accepts it`, async () => {
      // Given a saved review request and a held GitHub submission
      activity.approvers = ["other", "me"];
      await inbox.refresh("requested");
      const held = Promise.withResolvers<string>();
      const started = Promise.withResolvers<void>();
      const github = new GitHub(async (args, options) => {
        if (args[2] === "repos/example/repo/pulls/1") return JSON.stringify({ head: { sha: activity.head } });
        if (args[2] === "repos/example/repo/pulls/1/reviews" && options?.input) { started.resolve(); return held.promise; }
        throw new Error(`Unexpected GitHub request: ${args.join(" ")}`);
      });
      const api = createApi({ github, inbox, workspaces: new Workspaces(storage) });
      const response = api(new Request("http://localhost/api/github/pr/example/repo/1/review", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ event, commitId: activity.head, body: "My review", comments: [] }),
      }));
      await started.promise;
      const before = inbox.act(id, { action: "set", personal: { archived: false, restoredUntil: 0, snoozeUntil: 0 } }).item;

      // When GitHub acknowledges the review
      held.resolve(JSON.stringify({ id: 42, user: { login: "me" }, body: "My review", state, submitted_at: "2026-10-24T00:00:00Z" }));
      const result = await response;

      // Then the durable snapshot changes only after success, without another GitHub read
      expect(before?.needsReview).toEqual(true);
      expect(result.status).toEqual(200);
      expect(inbox.act(id, { action: "set", personal: before!.personal }).item).toMatchObject({
        needsReview: false,
        activity: { reviewRequested: false, reviewDecision: decision, approvers: [...approvers], events: [{ key: "review:42", actor: "me", at: "2026-10-24T00:00:00Z", kind: "review", hasBody: true }] },
      });
    });
  }

  test("a failed review leaves the saved request intact", async () => {
    // Given a saved review request and a GitHub rejection
    await inbox.refresh("requested");
    const github = new GitHub(async (args) => {
      if (args[2] === "repos/example/repo/pulls/1") return JSON.stringify({ head: { sha: activity.head } });
      throw new Error("Review rejected");
    });
    const api = createApi({ github, inbox, workspaces: new Workspaces(storage) });

    // When the user submits an approval
    await api(new Request("http://localhost/api/github/pr/example/repo/1/review", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ event: "APPROVE", commitId: activity.head, body: "", comments: [] }),
    }));

    // Then local review state is unchanged
    expect(inbox.queue("requested").items[0].activity).toEqual(activity);
  });

  test("an in-flight refresh cannot undo an acknowledged review", async () => {
    // Given a stored PR and a held refresh with the old review request
    await inbox.refresh("requested");
    const held = Promise.withResolvers<PullActivity>();
    const started = Promise.withResolvers<void>();
    inbox = new Inbox(storage, { dashboard: async () => [row], dashboardActivity: () => { started.resolve(); return held.promise; } }, () => now);
    const refresh = inbox.refresh("requested");
    await started.promise;

    // When approval succeeds before the old refresh finishes
    inbox.recordReview(id, { id: 42, user: { login: "me" }, body: "", html_url: `${row.url}#pullrequestreview-42`, state: "APPROVED", submitted_at: "2026-10-24T00:00:00Z" });
    held.resolve(activity);
    await refresh;

    // Then the published approval survives the stale snapshot
    expect(inbox.queue("requested").items[0]).toMatchObject({ needsReview: false, activity: { reviewDecision: "APPROVED", approvers: ["me"] } });
  });
  test("dashboard refresh persists bot read receipts", async () => {
    // Given automated messages and human feedback on my PR
    activity.viewer = "author";
    activity.events = [
      { key: "general:1", thread: "general", actor: "linear-code[bot]", at: "", kind: "reply" },
      { key: "inline:2", thread: "inline:2", actor: "homebound-team-bot", at: "", kind: "reply" },
      { key: "general:3", thread: "general", actor: "reviewer", at: "", kind: "reply" },
    ];

    // When the dashboard refreshes without opening a conversation
    await inbox.refresh("authored");
    await inbox.drain();

    // Then the backend has acknowledged only the automated messages
    expect(new Progress(storage).commentReadSnapshot(id)).toEqual(["general:1", "github:2"]);
  });
  test("summary refreshes persist typed fields without losing cached activity on a fetch failure", async () => {
    // Given a cached PR and activity snapshot
    await inbox.refresh("authored");
    // And changed summary fields with an unavailable activity endpoint
    row = { ...row, title: "Updated title", author: { login: "new-author" }, isDraft: true, createdAt: "2026-10-17T00:00:00Z", updatedAt: "2026-10-26T00:00:00Z" };
    inbox = new Inbox(storage, { dashboard: async () => [row], dashboardActivity: async () => { throw new Error("offline"); } }, () => now);

    // When the summary refreshes and the server restarts
    await inbox.refresh("authored");
    await inbox.drain();
    await storage.close();
    storage = new Storage(join(directory, "inbox.sqlite"));
    inbox = new Inbox(storage, { dashboard: async () => [row], dashboardActivity: async () => activity }, () => now);

    // Then the new summary and old activity are both available through the inbox API
    expect(inbox.queue("authored").items[0]).toMatchObject({ ...row, activity, activityError: "offline" });
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
