import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { InboxAction, InboxPR, InboxQueue, PersonalState, PullActivity, QueueView } from "../shared/inbox";
import type { PullRequestSummary } from "../shared/types";

interface Source {
  dashboard(view: string): Promise<PullRequestSummary[]>;
  dashboardActivity(repo: string, number: string, previous?: PullActivity): Promise<PullActivity>;
}
interface StoredPR { id: string; summary: string; activity: string | null; activity_updated: string | null; activity_error: string | null }
interface StoredQueue { ids: string; updated_at: number; error: string | null }
const interval = 120_000;

/** Separate GitHub snapshots from durable personal choices in one local inbox database. */
export class Inbox {
  private db: Database;
  private pending = new Map<QueueView, Promise<void>>();
  private details = new Map<string, Promise<void>>();
  private retryAt = new Map<QueueView, number>();

  constructor(file: string, private source: Source, private now: () => number = Date.now) {
    mkdirSync(dirname(file), { recursive: true });
    this.db = new Database(file, { create: true });
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS prs (id TEXT PRIMARY KEY, summary TEXT NOT NULL, activity TEXT, activity_updated TEXT, activity_error TEXT);
      CREATE TABLE IF NOT EXISTS queues (view TEXT PRIMARY KEY, ids TEXT NOT NULL, updated_at INTEGER NOT NULL, error TEXT);
      CREATE TABLE IF NOT EXISTS personal (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS preferences (view TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS undo (token TEXT PRIMARY KEY, id TEXT NOT NULL, before_value TEXT NOT NULL, after_value TEXT NOT NULL, expires INTEGER NOT NULL);`);
  }

  /** Return saved rows synchronously; only a background job talks to GitHub. */
  queue(view: QueueView): InboxQueue {
    const saved = this.db.query<StoredQueue, [string]>("SELECT * FROM queues WHERE view = ?").get(view);
    // Keep both tabs warm while either queue is in use, without running a daemon-wide timer.
    for (const queue of ["authored", "requested"] as const) {
      const snapshot = queue === view ? saved : this.db.query<StoredQueue, [string]>("SELECT * FROM queues WHERE view=?").get(queue);
      if ((!snapshot || this.now() - snapshot.updated_at >= interval) && this.now() >= (this.retryAt.get(queue) ?? 0)) void this.refresh(queue);
    }
    const ids: string[] = saved ? JSON.parse(saved.ids) : [];
    return { items: ids.map((id) => this.item(id)).filter((pr): pr is InboxPR => Boolean(pr)), updatedAt: saved?.updated_at || null, refreshing: this.pending.has(view), error: saved?.error ?? undefined, truncated: ids.length >= 100, preferences: this.preferences(view) };
  }

  /** Keep queue sorting and repository choices across browsers and server restarts. */
  preferences(view: QueueView, value?: NonNullable<InboxQueue["preferences"]>): NonNullable<InboxQueue["preferences"]> {
    if (value) this.db.query("INSERT INTO preferences VALUES (?, ?) ON CONFLICT(view) DO UPDATE SET value=excluded.value").run(view, JSON.stringify(value));
    const saved = this.db.query<{ value: string }, [string]>("SELECT value FROM preferences WHERE view=?").get(view);
    return saved ? JSON.parse(saved.value) : { sort: "attention", repository: "" };
  }

  /** Deduplicate tab polling, focus refreshes, and explicit refresh buttons. */
  refresh(view: QueueView): Promise<void> {
    const pending = this.pending.get(view);
    if (pending) return pending;
    const task = this.fetch(view).catch((error) => {
      this.retryAt.set(view, this.now() + interval);
      this.db.query("INSERT INTO queues(view, ids, updated_at, error) VALUES (?, '[]', 0, ?) ON CONFLICT(view) DO UPDATE SET error=excluded.error").run(view, error instanceof Error ? error.message : String(error));
    }).finally(() => this.pending.delete(view));
    this.pending.set(view, task);
    return task;
  }

  /**
   * Apply personal choices independently of GitHub snapshots.
   *
   * Undo compares the saved personal state so an old tab cannot overwrite a newer decision.
   */
  act(id: string, action: InboxAction): { item?: InboxPR; undo?: string } {
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
      if (action.action === "ignore") next.ignored = true;
      else if (action.action === "restore") next.ignored = false;
      else if (action.action === "pin") next.pinned = true;
      else if (action.action === "unpin") next.pinned = false;
      else if (action.action === "snooze") {
        next.snoozeUntil = this.now() + 86_400_000;
        next.wakeOnActivity = action.wakeOnActivity !== false;
      } else if (action.action === "unsnooze") next.snoozeUntil = 0;
      else if (action.action === "unread") next.unread = true;
      else if (action.action === "read" || action.action === "seen") {
        if (action.head !== undefined) next.seenHead = action.head;
        if (action.events) next.seenEvents = [...new Set([...next.seenEvents, ...action.events])];
        next.isNew = false;
        next.unread = false;
      }
      this.savePersonal(id, next);
      if (action.action !== "seen") {
        undo = randomUUID();
        this.db.query("DELETE FROM undo WHERE expires < ?").run(this.now());
        this.db.query("INSERT INTO undo VALUES (?, ?, ?, ?, ?)").run(undo, id, JSON.stringify(before), JSON.stringify(next), this.now() + 60_000);
      }
      return { item: this.item(id), undo };
    })();
  }

  /** Close only after refresh work has settled, including during test cleanup. */
  async close() {
    await Promise.all([...this.pending.values(), ...this.details.values()]);
    this.db.close();
  }

  /** Publish queue membership before fetching details so cold starts progressively populate. */
  private async fetch(view: QueueView) {
    const rows = await this.source.dashboard(view);
    this.db.transaction(() => {
      const prior = this.db.query<StoredQueue, [string]>("SELECT * FROM queues WHERE view=?").get(view);
      const priorIds = new Set<string>(prior ? JSON.parse(prior.ids) : []);
      for (const row of rows) {
        const id = prId(row);
        if (prior && !priorIds.has(id)) this.savePersonal(id, { ...this.personal(id), isNew: true });
        this.db.query("INSERT INTO prs(id, summary) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET summary=excluded.summary").run(id, JSON.stringify(row));
      }
      this.db.query("INSERT INTO queues VALUES (?, ?, ?, NULL) ON CONFLICT(view) DO UPDATE SET ids=excluded.ids, updated_at=excluded.updated_at, error=NULL").run(view, JSON.stringify(rows.map(prId)), this.now());
    })();
    this.retryAt.delete(view);
    // Bound GitHub subprocesses even when a queue contains a hundred PRs.
    const remaining = [...rows];
    await Promise.all(Array.from({ length: Math.min(3, rows.length) }, async () => {
      for (let row = remaining.shift(); row; row = remaining.shift()) await this.refreshActivity(row);
    }));
  }

  /** Refresh changed discussions; check status is also fetched on each queue refresh. */
  private refreshActivity(row: PullRequestSummary): Promise<void> {
    const id = prId(row);
    const existing = this.details.get(id);
    if (existing) return existing;
    const task = this.fetchActivity(row).catch((error) => {
      this.db.query("UPDATE prs SET activity_error=? WHERE id=?").run(error instanceof Error ? error.message : String(error), id);
    }).finally(() => this.details.delete(id));
    this.details.set(id, task);
    return task;
  }

  /**
   * Preserve read markers and wake snoozed PRs for new activity by someone else.
   *
   * The first snapshot establishes a baseline; historical replies are covered by New to queue.
   */
  private async fetchActivity(row: PullRequestSummary) {
    const id = prId(row);
    const stored = this.stored(id)!;
    // GitHub's timestamp is only an invalidation hint, never an unread marker.
    const reusable = stored.activity && stored.activity_updated === row.updatedAt && !stored.activity_error ? JSON.parse(stored.activity) as PullActivity : undefined;
    const activity = await this.source.dashboardActivity(row.repository.nameWithOwner, String(row.number), reusable);
    this.db.transaction(() => {
      const previous = this.stored(id)?.activity;
      const old: PullActivity | undefined = previous ? JSON.parse(previous) : undefined;
      const personal = this.personal(id);
      if (!old) {
        if (!personal.seenHead) personal.seenHead = activity.head;
        personal.seenEvents = [...new Set([...personal.seenEvents, ...activity.events.map((event) => event.key)])];
      } else if (personal.snoozeUntil > this.now() && personal.wakeOnActivity) {
        const known = new Set(old.events.map((event) => event.key));
        const reply = activity.events.some((event) => event.actor !== activity.viewer && !known.has(event.key));
        const commit = old.head !== activity.head && activity.headAuthor !== activity.viewer;
        if (reply || commit) personal.snoozeUntil = 0;
      }
      this.savePersonal(id, personal);
      this.db.query("UPDATE prs SET activity=?, activity_updated=?, activity_error=NULL WHERE id=?").run(JSON.stringify(activity), row.updatedAt, id);
    })();
  }

  /** Derive badges from exact head SHAs and event IDs instead of generic update timestamps. */
  private item(id: string): InboxPR | undefined {
    const row = this.stored(id);
    if (!row) return;
    const personal = this.personal(id);
    const activity: PullActivity | undefined = row.activity ? JSON.parse(row.activity) : undefined;
    const read = new Set(personal.seenEvents);
    const events = activity?.events.filter((event) => event.actor !== activity.viewer && !read.has(event.key)) ?? [];
    const newCommits = Boolean(activity && personal.seenHead && activity.head !== personal.seenHead);
    const newReplies = events.filter((event) => event.kind === "reply").length;
    const newReviews = events.filter((event) => event.kind === "review").length;
    return { ...JSON.parse(row.summary), id, activity, personal, newCommits, newReplies, newReviews, unread: personal.unread || personal.isNew || newCommits || newReplies > 0 || newReviews > 0, activityError: row.activity_error ?? undefined };
  }

  private stored(id: string) { return this.db.query<StoredPR, [string]>("SELECT * FROM prs WHERE id=?").get(id); }
  private personal(id: string): PersonalState {
    const saved = this.db.query<{ value: string }, [string]>("SELECT value FROM personal WHERE id=?").get(id);
    return saved ? JSON.parse(saved.value) : { ignored: false, pinned: false, snoozeUntil: 0, wakeOnActivity: true, seenHead: "", seenEvents: [], isNew: true, unread: false };
  }
  private savePersonal(id: string, state: PersonalState) {
    this.db.query("INSERT INTO personal VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET value=excluded.value").run(id, JSON.stringify(state));
  }
}

/** One PR shares personal state across both queues and repository-name casing. */
function prId(pr: PullRequestSummary) { return `${pr.repository.nameWithOwner.toLowerCase()}/${pr.number}`; }
