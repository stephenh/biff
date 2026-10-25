import type { Storage } from "./storage";
import type { LocalReview } from "../shared/types";
import type { ReviewSession, ReviewThread } from "../shared/localReview";
import type { Progress } from "./progress";

/** Persist agent sessions and delivery cursors through one serialized database writer. */
export class Reviews {
  private listeners = new Set<() => void>();
  private progress?: Progress;
  private unsubscribe?: () => void;

  constructor(private storage: Storage) {}

  /** Agent sessions subscribe to durable bookmark comments without owning their lifetime. */
  connect(progress: Progress) {
    if (this.progress === progress) return;
    this.unsubscribe?.();
    this.progress = progress;
    this.unsubscribe = progress.subscribeDiscussion(() => { for (const wake of this.listeners) wake(); });
  }

  /** Recover host subscriptions from saved sessions after a plugin restart. */
  async list(workspace: string): Promise<ReviewSession[]> {
    return this.serialize(async () => {
      const rows = this.storage.db.query<{ value: string }, [string, string]>("SELECT value FROM sessions WHERE workspace=? AND updated_at>=?").all(workspace, new Date(Date.now() - 7 * 86400_000).toISOString());
      return rows.map((row) => JSON.parse(row.value) as ReviewSession).filter((review) => !review.finished || review.humanSequence > review.acknowledged);
    });
  }

  /** Resume only the same review lifetime within this workspace and conversation. */
  async start(snapshot: LocalReview, agentSession: string): Promise<ReviewSession> {
    return this.serialize(async () => {
      this.storage.db.query("DELETE FROM sessions WHERE updated_at < ?").run(new Date(Date.now() - 7 * 86400_000).toISOString());
      const rows = this.storage.db.query<{ value: string }, [string]>("SELECT value FROM sessions WHERE workspace=?").all(snapshot.workspace.path);
      for (const row of rows) {
        const review = JSON.parse(row.value) as ReviewSession;
        if (agentSession && !review.finished && review.agentSession === agentSession && review.snapshot.workspace.path === snapshot.workspace.path && sameReviewLifetime(review.snapshot, snapshot)) return review;
      }
      const review: ReviewSession = { version: 1, id: crypto.randomUUID(), agentSession, snapshot, sequence: 0, humanSequence: 0, acknowledged: 0, updatedAt: new Date().toISOString(), finished: false, threads: [] };
      await this.syncDiscussion(review);
      await this.save(review);
      return review;
    });
  }

  /** Read after admitted writes so reconnecting clients see acknowledged mutations. */
  async get(id: string): Promise<ReviewSession> {
    return this.serialize(async () => {
      const review = await this.read(id);
      if (this.progress) await this.progress.migrateFileApprovals(`jj/${review.snapshot.workspace.id}/${review.snapshot.progressScope ?? review.snapshot.selected.change_id}`, review.snapshot.patch, review.snapshot.selected.commit_id);
      if (!review.finished && await this.syncDiscussion(review)) await this.save(review);
      if (this.progress) review.commentReads = this.progress.commentReadSnapshot(review.discussionScope ?? `collaboration/${review.id}`);
      return review;
    });
  }

  /** Atomically persist before waking browser streams or waiting agents. */
  async update(id: string, human: boolean, change: (review: ReviewSession) => void): Promise<ReviewSession> {
    return this.serialize(async () => {
      const review = await this.read(id);
      if (!review.finished) await this.syncDiscussion(review);
      const before = structuredClone(review.threads);
      review.sequence++;
      change(review);
      if (human) review.humanSequence = review.sequence;
      review.updatedAt = new Date().toISOString();
      if (this.progress && review.discussionScope) {
        await this.progress.updateDiscussion(review.discussionScope, (discussion) => {
          mergeThreadEdits(discussion.threads, review.threads, before);
          discussion.commentReads = [...new Set([...(discussion.commentReads ?? []), ...(review.commentReads ?? [])])];
        });
      }
      else if (this.progress && review.commentReads?.length) await this.progress.commentReads(`collaboration/${review.id}`, review.commentReads);
      if (!review.finished) await this.syncDiscussion(review);
      await this.save(review);
      for (const wake of this.listeners) wake();
      return review;
    });
  }

  /**
   * Project shared messages onto each agent session's independent delivery sequence.
   *
   * Existing message IDs retain their sequence; new local user messages wake the agent,
   * while agent replies and publication receipts only wake browser streams.
   */
  private async syncDiscussion(review: ReviewSession): Promise<boolean> {
    if (!this.progress || !review.snapshot.identity) return false;
    const scope = `jj/${review.snapshot.workspace.id}/${review.snapshot.progressScope}`;
    const before = JSON.stringify(review);
    if (!review.discussionScope) {
      await this.progress.updateDiscussion(scope, (discussion) => mergeThreadEdits(discussion.threads, review.threads, []));
    }
    const previous = review.discussionScope && review.discussionScope !== scope ? [] : review.threads;
    review.discussionScope = scope;
    const discussion = await this.progress.discussion(scope);
    review.commentReads = discussion.commentReads;
    review.threads = discussion.threads.map((source) => {
      const existing = previous.find((thread) => thread.id === source.id);
      const thread = structuredClone(source);
      thread.humanSequence = existing?.humanSequence ?? 0;
      thread.messages = source.messages.map((message) => {
        const known = existing?.messages.find((entry) => entry.id === message.id);
        if (known && known.body === message.body) return { ...message, sequence: known.sequence };
        const sequence = ++review.sequence;
        if (message.author === "user") review.humanSequence = thread.humanSequence = sequence;
        return { ...message, sequence };
      });
      if (existing && JSON.stringify({ ...thread, humanSequence: 0 }) !== JSON.stringify({ ...existing, humanSequence: 0 })) review.sequence++;
      return thread;
    });
    // Deleting the final message removes the thread, but must still wake the browser and agent.
    if (previous.some((thread) => thread.messages.some((message) => !review.threads.some((entry) => entry.messages.some((current) => current.id === message.id))))) {
      review.humanSequence = ++review.sequence;
    }
    const changed = before !== JSON.stringify(review);
    if (changed) review.updatedAt = new Date().toISOString();
    return changed;
  }

  /** Wait without consuming feedback; only an explicit acknowledgment advances delivery. */
  async wait(id: string, after: number | undefined, signal: AbortSignal, all = false): Promise<ReviewSession> {
    const deadline = Date.now() + 25_000;
    while (true) {
      // Subscribe before reading to close the read/subscribe lost-wakeup window.
      let wake!: () => void;
      const changed = new Promise<void>((resolve) => { wake = resolve; });
      this.listeners.add(wake);
      const timer = setTimeout(wake, Math.max(0, deadline - Date.now()));
      signal.addEventListener("abort", wake, { once: true });
      try {
        signal.throwIfAborted();
        const review = await this.get(id);
        if (review.finished || (all ? review.sequence : review.humanSequence) > (after ?? review.acknowledged) || Date.now() >= deadline) return review;
        await changed;
      } finally {
        clearTimeout(timer);
        this.listeners.delete(wake);
        signal.removeEventListener("abort", wake);
      }
    }
  }

  /** Keep a failed mutation from poisoning later independent writes. */
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    return this.storage.serialize("sessions", operation);
  }

  /** Session IDs are opaque keys and must already exist. */
  private async read(id: string): Promise<ReviewSession> {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid review ID");
    const row = this.storage.db.query<{ value: string }, [string]>("SELECT value FROM sessions WHERE id=?").get(id);
    if (!row) throw new Error("Review session not found");
    return JSON.parse(row.value);
  }

  /** Save the snapshot and delivery cursor in one atomic row replacement. */
  private async save(review: ReviewSession) {
    this.storage.db.query("INSERT INTO sessions VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET workspace=excluded.workspace, updated_at=excluded.updated_at, value=excluded.value").run(review.id, review.snapshot.workspace.path, review.updatedAt, JSON.stringify(review));
  }
}

/** Conversations outlive PRs; a new bookmark or a reused bookmark's new lifetime needs a new session. */
function sameReviewLifetime(previous: LocalReview, current: LocalReview): boolean {
  if (previous.identity || current.identity) return previous.identity?.id === current.identity?.id;
  // Explicit revisions and older snapshots may not have a durable review identity.
  return previous.bookmark === current.bookmark && (previous.progressScope ?? previous.selected.change_id) === (current.progressScope ?? current.selected.change_id);
}

/** Retain stable message IDs and sequence numbers for reconnects and replies. */
export function appendMessage(review: ReviewSession, thread: ReviewThread, author: "user" | "agent", body: string) {
  thread.messages.push({ id: crypto.randomUUID(), author, body, createdAt: new Date().toISOString(), sequence: review.sequence });
}

/** Merge only the caller's edits so a concurrent local comment cannot be overwritten by an agent reply. */
function mergeThreadEdits(target: ReviewThread[], edited: ReviewThread[], before: ReviewThread[]): void {
  for (const thread of edited) {
    const existing = target.find((entry) => entry.id === thread.id);
    const previous = before.find((entry) => entry.id === thread.id);
    // An old session snapshot must not resurrect a concurrently deleted thread or message.
    if (!existing) { if (!previous) target.push(structuredClone(thread)); continue; }
    for (const message of thread.messages) if (!existing.messages.some((entry) => entry.id === message.id) && !previous?.messages.some((entry) => entry.id === message.id)) existing.messages.push(structuredClone(message));
    if (previous && previous.resolved !== thread.resolved) existing.resolved = thread.resolved;
  }
}
