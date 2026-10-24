import type { Database } from "bun:sqlite";
import type { Storage } from "./storage";
import { randomUUID } from "node:crypto";
import type { InboxAction, InboxPR, InboxQueue, PersonalState, PullActivity, QueueView, TrackedPullRequest } from "../shared/inbox";
import type { DiscussionComment, PullRequestSummary } from "../shared/types";
import { Progress } from "./progress";
import { commentReadKey, conversationActivity, relevantComments } from "../shared/commentActivity";

interface Source {
  dashboard(view: string): Promise<PullRequestSummary[]>;
  dashboardActivity(repo: string, number: string, previous?: PullActivity): Promise<PullActivity>;
  trackedPullRequests?(ids: string[]): Promise<TrackedPullRequest[]>;
  followUpSnapshot?(repo: string, number: string, head: string): Promise<{ patch: string; commits: string[] }>;
}
interface StoredPR { id: string; summary: string; activity: string | null; activity_updated: string | null; activity_error: string | null }
interface StoredQueue { ids: string; updated_at: number; error: string | null }
interface TrackedPR { id: string; view: QueueView; state: TrackedPullRequest["state"]; closed_at: number | null; archived_at: number | null }
const interval = 120_000;
const day = 86_400_000;

/** Separate GitHub snapshots from durable personal choices in one local inbox database. */
export class Inbox {
  private db: Database;
  private progress: Progress;
  private pending = new Map<QueueView, Promise<void>>();
  private includingArchives = new Set<QueueView>();
  private details = new Map<string, Promise<void>>();
  private retryAt = new Map<QueueView, number>();
  private reviewVersions = new Map<string, number>();

  constructor(storage: Storage, private source: Source, private now: () => number = Date.now) {
    this.db = storage.db;
    this.progress = new Progress(storage);
  }

  /**
   * Return active and archived snapshots synchronously; only background jobs talk to GitHub.
   *
   * Automatic archives still refresh for reply discovery; manual archives opt out.
   */
  queue(view: QueueView): InboxQueue {
    const saved = this.db.query<StoredQueue, [string]>("SELECT * FROM queues WHERE view = ?").get(view);
    const remembered = this.db.query<TrackedPR, [string]>("SELECT * FROM inbox_tracked_prs WHERE view=?").all(view);
    // Message receipts and local follow-ups can change eligibility between GitHub refreshes.
    if (!this.pending.has(view)) this.archiveEligible(view, remembered.map((tracked) => tracked.id));
    // Keep all tabs warm while any queue is in use, without running a daemon-wide timer.
    for (const queue of ["authored", "requested", "dependabot"] as const) {
      const snapshot = queue === view ? saved : this.db.query<StoredQueue, [string]>("SELECT * FROM queues WHERE view=?").get(queue);
      if ((!snapshot || this.now() - snapshot.updated_at >= interval) && this.now() >= (this.retryAt.get(queue) ?? 0)) void this.refresh(queue);
    }
    const ids: string[] = saved ? JSON.parse(saved.ids) : [];
    // Keep history searchable independently of current discovery membership.
    return { items: [...new Set([...ids, ...remembered.map((row) => row.id)])].map((id) => this.item(id)).filter((pr): pr is InboxPR => Boolean(pr)), updatedAt: saved?.updated_at || null, refreshing: this.pending.has(view), error: saved?.error ?? undefined, truncated: ids.length >= 100, preferences: this.preferences(view) };
  }

  /** Keep repository choices across browsers and server restarts. */
  preferences(view: QueueView, value?: NonNullable<InboxQueue["preferences"]>): NonNullable<InboxQueue["preferences"]> {
    if (value) this.db.query("INSERT INTO preferences VALUES (?, ?) ON CONFLICT(view) DO UPDATE SET value=excluded.value").run(view, JSON.stringify(value));
    const saved = this.db.query<{ value: string }, [string]>("SELECT value FROM preferences WHERE view=?").get(view);
    return { repository: saved ? JSON.parse(saved.value).repository ?? "" : "" };
  }

  /** Remember a URL-opened PR without treating navigation as Restore or Mark read. */
  async track(repo: string, number: string): Promise<void> {
    if (!this.source.trackedPullRequests) throw new Error("Tracked PR lookup is unavailable");
    const [result] = await this.source.trackedPullRequests([`${repo.toLowerCase()}/${number}`]);
    if (!result) throw new Error("PR not found");
    this.db.transaction(() => {
      const id = prId(result.pr);
      this.db.query("INSERT INTO prs(id, summary) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET summary=excluded.summary").run(id, JSON.stringify(result.pr));
      this.saveTracking(result);
    })();
    await this.refreshActivity(result.pr);
  }

  /** Deduplicate tab polling, focus refreshes, and explicit refresh buttons. */
  refresh(view: QueueView, includeArchived = false): Promise<void> {
    const pending = this.pending.get(view);
    if (pending) return includeArchived && !this.includingArchives.has(view) ? pending.then(() => this.refresh(view, true)) : pending;
    if (includeArchived) this.includingArchives.add(view);
    const task = this.fetch(view, includeArchived).catch((error) => {
      this.retryAt.set(view, this.now() + interval);
      this.db.query("INSERT INTO queues(view, ids, updated_at, error) VALUES (?, '[]', 0, ?) ON CONFLICT(view) DO UPDATE SET error=excluded.error").run(view, error instanceof Error ? error.message : String(error));
    }).finally(() => { this.pending.delete(view); this.includingArchives.delete(view); });
    this.pending.set(view, task);
    return task;
  }

  /**
   * Apply personal choices independently of GitHub snapshots.
   *
   * Undo compares the saved personal state so an old tab cannot overwrite a newer decision.
   */
  act(id: string, action: InboxAction): { item?: InboxPR; undo?: string; previous?: PersonalState } {
    return this.db.transaction(() => {
      const before = this.personal(id);
      const next = { ...before };
      let undo: string | undefined;
      if (action.action === "undo") {
        const saved = this.db.query<{ before_value: string; after_value: string; expires: number }, [string, string]>("SELECT * FROM undo WHERE token=? AND id=?").get(action.token, id);
        if (!saved || saved.expires < this.now()) throw new Error("Undo has expired");
        if (JSON.stringify(before) !== saved.after_value) throw new Error("This PR changed since that action; use its current actions instead");
        this.savePersonal(id, JSON.parse(saved.before_value));
        this.db.query("DELETE FROM undo WHERE token=?").run(action.token);
        return { item: this.item(id) };
      }
      if (action.action === "set") Object.assign(next, action.personal);
      else if (action.action === "archive") next.archived = true;
      else if (action.action === "restore") {
        next.archived = false;
        next.restoredUntil = this.now() + 7 * day;
      }
      else if (action.action === "snooze") {
        next.snoozeUntil = this.now() + 86_400_000;
      } else if (action.action === "unsnooze") next.snoozeUntil = 0;
      this.savePersonal(id, next);
      undo = randomUUID();
      this.db.query("DELETE FROM undo WHERE expires < ?").run(this.now());
      this.db.query("INSERT INTO undo VALUES (?, ?, ?, ?, ?)").run(undo, id, JSON.stringify(before), JSON.stringify(next), this.now() + 60_000);
      return { item: this.item(id), undo, previous: before };
    })();
  }

  /** Apply GitHub's publication receipt without fetching the PR again. */
  recordReview(id: string, review: DiscussionComment): void {
    const stored = this.stored(id);
    if (!stored?.activity) return;
    const activity: PullActivity = JSON.parse(stored.activity);
    const actor = review.user.login;
    const ownReview = actor.toLowerCase() === activity.viewer.toLowerCase();
    if (ownReview) activity.reviewRequested = false;
    if (review.state === "APPROVED" || review.state === "CHANGES_REQUESTED") {
      activity.approvers = (activity.approvers ?? []).filter((login) => login.toLowerCase() !== actor.toLowerCase());
      if (review.state === "APPROVED") activity.approvers.push(actor);
      // Approval cannot prove that another reviewer's requested changes were satisfied.
      if (review.state === "CHANGES_REQUESTED" || activity.reviewDecision !== "CHANGES_REQUESTED") activity.reviewDecision = review.state;
    }
    const events = conversationActivity({ comments: [], inline: [], reviews: [review] });
    activity.events = [...activity.events.filter((event) => event.key !== `review:${review.id}`), ...events];
    // The receipt omits inline comment IDs. Keep the next normal refresh responsible
    // for loading them even when GitHub's updatedAt has not advanced yet.
    this.db.query("UPDATE prs SET activity=?, activity_updated=NULL WHERE id=?").run(JSON.stringify(activity), id);
    this.reviewVersions.set(id, (this.reviewVersions.get(id) ?? 0) + 1);
  }

  /** Finish refresh work before the owner closes the shared database. */
  async drain() {
    await Promise.all([...this.pending.values(), ...this.details.values()]);
  }

  /**
   * Publish queue membership before fetching details so cold starts progressively populate.
   *
   * Discovery finds new requests; remembered membership survives request removal.
   * Refresh discussions before deciding whether a closed review has unread activity.
   */
  private async fetch(view: QueueView, includeArchived: boolean) {
    const reviewVersions = new Map(this.reviewVersions);
    const discovered = await this.source.dashboard(view);
    const discoveredIds = new Set(discovered.map(prId));
    // Automatic archives still need reply discovery. Only explicit manual archives opt out.
    const missing = this.db.query<{ id: string }, [string]>("SELECT id FROM inbox_tracked_prs WHERE view=?").all(view).map((row) => row.id).filter((id) => !discoveredIds.has(id) && (includeArchived || !this.personal(id).archived));
    if (missing.length && !this.source.trackedPullRequests) throw new Error("Tracked PR lookup is unavailable");
    const retained = missing.length ? await this.source.trackedPullRequests!(missing) : [];
    const rows = [...discovered, ...retained.map((result) => result.pr)];
    this.db.transaction(() => {
      for (const row of discovered) this.saveTracking({ pr: row, state: "OPEN", view });
      for (const result of retained) this.saveTracking({ ...result, view });
      for (const row of rows) {
        const id = prId(row);
        this.db.query("INSERT INTO prs(id, summary) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET summary=excluded.summary").run(id, JSON.stringify(row));
      }
      // A URL submission may finish while GitHub is loading. Include its newly
      // registered membership instead of overwriting it with the older snapshot.
      const ids = new Set([...rows.map(prId), ...this.db.query<{ id: string }, [string]>("SELECT id FROM inbox_tracked_prs WHERE view=? AND archived_at IS NULL").all(view).map((row) => row.id)]);
      this.db.query("INSERT INTO queues VALUES (?, ?, ?, NULL) ON CONFLICT(view) DO UPDATE SET ids=excluded.ids, updated_at=excluded.updated_at, error=NULL").run(view, JSON.stringify([...ids]), this.now());
    })();
    this.retryAt.delete(view);
    // Bound GitHub subprocesses even when a queue contains a hundred PRs.
    const remaining = [...rows];
    await Promise.all(Array.from({ length: Math.min(3, rows.length) }, async () => {
      for (let row = remaining.shift(); row; row = remaining.shift()) await this.refreshActivity(row, reviewVersions.get(prId(row)) ?? 0);
    }));
    this.archiveEligible(view, rows.map(prId));
  }

  /** Refresh changed discussions; check status is also fetched on each queue refresh. */
  private refreshActivity(row: PullRequestSummary, reviewVersion = this.reviewVersions.get(prId(row)) ?? 0): Promise<void> {
    const id = prId(row);
    const existing = this.details.get(id);
    if (existing) return existing;
    const task = this.fetchActivity(row, reviewVersion).catch((error) => {
      this.db.query("UPDATE prs SET activity_error=? WHERE id=?").run(error instanceof Error ? error.message : String(error), id);
    }).finally(() => this.details.delete(id));
    this.details.set(id, task);
    return task;
  }

  /** Refresh discussion snapshots without acknowledging messages or changing personal choices. */
  private async fetchActivity(row: PullRequestSummary, reviewVersion: number) {
    const id = prId(row);
    const stored = this.stored(id)!;
    // GitHub's timestamp is only an invalidation hint, never an unread marker.
    const reusable = stored.activity && stored.activity_updated === row.updatedAt && !stored.activity_error ? JSON.parse(stored.activity) as PullActivity : undefined;
    const activity = await this.source.dashboardActivity(row.repository.nameWithOwner, String(row.number), reusable);
    if (this.progress.needsFollowUpDiff(id, activity.head) && this.source.followUpSnapshot) {
      const candidates = this.progress.followUps(id);
      const snapshot = await this.source.followUpSnapshot(row.repository.nameWithOwner, String(row.number), activity.head);
      await this.progress.reconcileFollowUps(id, snapshot.patch, activity.head, "pr", snapshot.commits, candidates);
    }
    await this.progress.reconcileFollowUpThreads(id, activity.events.filter((event) => event.key.startsWith("inline:")).map((event) => Number(event.key.slice(7))));
    if ((this.reviewVersions.get(id) ?? 0) === reviewVersion) this.db.query("UPDATE prs SET activity=?, activity_updated=?, activity_error=NULL WHERE id=?").run(JSON.stringify(activity), row.updatedAt, id);
  }

  /** Unread comes only from message receipts; review work comes from current GitHub requests. */
  private item(id: string): InboxPR | undefined {
    const row = this.stored(id);
    if (!row) return;
    const personal = this.personal(id);
    const activity: PullActivity | undefined = row.activity ? JSON.parse(row.activity) : undefined;
    const summary: PullRequestSummary = JSON.parse(row.summary);
    const commentReads = new Set(this.progress.commentReadSnapshot(id));
    const unreadThreads = activity ? new Set(relevantComments(activity.events, activity.viewer, summary.author.login).filter((event) => !commentReads.has(commentReadKey(event))).map((event) => event.thread ?? event.key)).size : 0;
    const tracked = this.tracked(id);
    const state = tracked?.state ?? "OPEN";
    const needsReview = state === "OPEN" && (tracked?.view === "authored" || Boolean(activity?.reviewRequested));
    const archivedAt = personal.restoredUntil > this.now() ? undefined : tracked?.archived_at ?? undefined;
    return { ...summary, id, state, closedAt: tracked?.closed_at ?? undefined, archivedAt, activity, personal, needsReview, unreadThreads, followUpCount: this.progress.followUps(id).length, unread: unreadThreads > 0, activityError: row.activity_error ?? undefined };
  }

  /** Record GitHub's closure time once; missing timestamps must not restart the clock on every poll. */
  private saveTracking(result: TrackedPullRequest) {
    const id = prId(result.pr);
    const timestamp = Date.parse(result.closedAt ?? "");
    const closedAt = result.state === "OPEN" ? null : Number.isFinite(timestamp) ? timestamp : this.tracked(id)?.closed_at ?? this.now();
    this.db.query(`INSERT INTO inbox_tracked_prs (id, view, state, closed_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET state=excluded.state, closed_at=excluded.closed_at,
      archived_at=CASE WHEN excluded.state='OPEN' THEN NULL ELSE inbox_tracked_prs.archived_at END`).run(id, result.view, result.state, closedAt);
  }

  /**
   * Archive completed reviews only after current activity and follow-ups are known.
   *
   * Failed activity fetches retain the previous visibility. Explicit follow-ups
   * never expire, and a manually restored PR gets seven days from that action.
   */
  private archiveEligible(view: QueueView, refreshed: string[]) {
    this.db.transaction(() => {
      for (const id of refreshed) {
        const tracked = this.tracked(id);
        const item = this.item(id);
        if (!tracked || !item?.activity || item.activityError || this.stored(id)?.activity_updated !== item.updatedAt) continue;
        const approved = item.activity.approvers?.includes(item.activity.viewer);
        const oldEnough = this.now() >= (tracked.closed_at ?? this.now()) + 7 * day;
        const archive = tracked.state !== "OPEN" && !item.unread && item.followUpCount === 0 &&
          item.personal.restoredUntil <= this.now() && Boolean(approved || oldEnough);
        this.db.query("UPDATE inbox_tracked_prs SET archived_at=? WHERE id=?").run(archive ? tracked.archived_at ?? this.now() : null, id);
      }
      const saved = this.db.query<StoredQueue, [string]>("SELECT * FROM queues WHERE view=?").get(view);
      if (!saved) return;
      const ids: string[] = JSON.parse(saved.ids);
      this.db.query("UPDATE queues SET ids=? WHERE view=?").run(JSON.stringify(ids.filter((id) => !this.tracked(id)?.archived_at)), view);
    })();
  }

  private tracked(id: string) { return this.db.query<TrackedPR, [string]>("SELECT * FROM inbox_tracked_prs WHERE id=?").get(id); }

  private stored(id: string) { return this.db.query<StoredPR, [string]>("SELECT * FROM prs WHERE id=?").get(id); }
  private personal(id: string): PersonalState {
    const saved = this.db.query<{ value: string }, [string]>("SELECT value FROM pr_user_state WHERE id=?").get(id);
    const value = saved ? JSON.parse(saved.value) : {};
    // Reuse old Ignore intent; obsolete PR read markers need no migration.
    return { archived: value.archived ?? value.ignored ?? false, restoredUntil: value.restoredUntil ?? 0, snoozeUntil: value.snoozeUntil ?? 0 };
  }
  private savePersonal(id: string, state: PersonalState) {
    this.db.query("INSERT INTO pr_user_state VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET value=excluded.value").run(id, JSON.stringify(state));
  }
}

/** One PR shares personal state across both queues and repository-name casing. */
function prId(pr: PullRequestSummary) { return `${pr.repository.nameWithOwner.toLowerCase()}/${pr.number}`; }
