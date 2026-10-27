import { subscribeDiscussion, updateDiscussion, readDiscussion } from "./discussionThreads";
import { commentReadSnapshot } from "./reviewStore";
import type { Storage } from "./storage";
import type { LocalReview } from "../shared/types";
import type { ReviewSession, ReviewThread } from "../shared/localReview";
import { isDeepStrictEqual } from "node:util";
import { readAgentSession, saveAgentSession, messageDeliveries, threadDeliveries, bodyHash, threadFingerprint } from "./agentSessionStore";

const refreshes = new WeakMap<Storage, Map<string, number>>();

/** Persist independent agent sessions with per-session ordering and shared canonical discussions. */
export class Reviews {
  private listeners = new Set<() => void>();
  private unsubscribe?: () => void;

  constructor(private storage: Storage) {}

  /** Agent sessions subscribe to durable bookmark comments without owning their lifetime. */
  connectDiscussions() {
    this.unsubscribe ??= subscribeDiscussion(this.storage, () => { for (const wake of this.listeners) wake(); });
  }

  /** Recover host subscriptions from saved sessions after a plugin restart. */
  async list(workspace: string): Promise<ReviewSession[]> {
    return this.storage.serialize(`agent_workspace:${workspace}`, async () => {
      const rows = this.storage.db.query<{ id: string }, [string, string]>(`SELECT id FROM agent_sessions WHERE workspace_id=? AND updated_at>=?
        AND (finished=0 OR human_sequence>acknowledged)`).all(workspace, new Date(Date.now() - 7 * 86400_000).toISOString());
      const sessions = await Promise.all(rows.map((row) => this.get(row.id)));
      return sessions.filter((review) => !review.finished || review.humanSequence > review.acknowledged);
    });
  }

  /** Resume only the same review lifetime within this workspace and conversation. */
  async start(snapshot: LocalReview, agentSession: string): Promise<ReviewSession> {
    return this.storage.serialize(`agent_workspace:${snapshot.workspace.id}`, async () => {
      const cutoff = new Date(Date.now() - 7 * 86400_000).toISOString();
      const expired = this.storage.db.query<{ id: string }, [string]>("SELECT id FROM agent_sessions WHERE updated_at<?").all(cutoff);
      // An admitted reply can renew an old session before pruning reaches its write queue.
      await Promise.all(expired.map((row) => this.storage.serialize(`agent_session:${row.id}`, async () => {
        this.storage.db.query("DELETE FROM agent_sessions WHERE id=? AND updated_at<?").run(row.id, cutoff);
      })));
      const rows = this.storage.db.query<{ id: string }, [string, string]>("SELECT id FROM agent_sessions WHERE workspace_id=? AND agent_session=? AND finished=0").all(snapshot.workspace.id, agentSession);
      for (const row of rows) {
        const review = await this.get(row.id);
        if (agentSession && !review.finished && sameReviewLifetime(review.snapshot, snapshot)) return review;
      }
      const review: ReviewSession = { version: 1, id: crypto.randomUUID(), agentSession, snapshot, sequence: 0, humanSequence: 0, acknowledged: 0, updatedAt: new Date().toISOString(), finished: false, threads: [] };
      await this.syncDiscussion(review);
      await this.save(review);
      return review;
    });
  }

  /** Read after admitted writes so reconnecting clients see acknowledged mutations. */
  async get(id: string): Promise<ReviewSession> {
    return this.storage.serialize(`agent_session:${id}`, async () => {
      const review = await this.read(id);
      if (!review.finished && await this.syncDiscussion(review)) await this.save(review);
      review.commentReads = commentReadSnapshot(this.storage, review.discussionScope!);
      return review;
    });
  }

  /** Atomically persist before waking browser streams or waiting agents. */
  async update(id: string, human: boolean, change: (review: ReviewSession) => void | Promise<void>): Promise<ReviewSession> {
    return this.storage.serialize(`agent_session:${id}`, async () => {
      const review = await this.read(id);
      if (!review.finished) await this.syncDiscussion(review);
      const before = structuredClone(review.threads);
      review.sequence++;
      await change(review);
      if (human) review.humanSequence = review.sequence;
      review.updatedAt = new Date().toISOString();
      if (review.discussionScope) {
        await updateDiscussion(this.storage, review.discussionScope, (discussion) => {
          mergeThreadEdits(discussion.threads, review.threads, before);
          discussion.commentReads = [...new Set([...(discussion.commentReads ?? []), ...(review.commentReads ?? [])])];
        });
      }
      if (!review.finished) await this.syncDiscussion(review, review.threads);
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
  private async syncDiscussion(review: ReviewSession, edited?: ReviewThread[]): Promise<boolean> {
    const scope = review.snapshot.identity ? `jj/${review.snapshot.workspace.id}/${review.snapshot.progressScope}` : `collaboration/${review.id}`;
    const before = structuredClone(review);
    if (!review.discussionScope) {
      await updateDiscussion(this.storage, scope, (discussion) => mergeThreadEdits(discussion.threads, review.threads, []));
    }
    const sameScope = !review.discussionScope || review.discussionScope === scope;
    const observedMessages = edited ? edited.flatMap((thread) => thread.messages.map((message) => ({ message_id: message.id, sequence: message.sequence, body_hash: bodyHash(message.body) }))) : messageDeliveries(this.storage.db, review.id);
    const observedThreads = edited ? edited.map((thread) => ({ thread_id: thread.id, human_sequence: thread.humanSequence, fingerprint: threadFingerprint(thread) })) : threadDeliveries(this.storage.db, review.id);
    const messages = new Map((sameScope ? observedMessages : []).map((entry) => [entry.message_id, entry]));
    const threads = new Map((sameScope ? observedThreads : []).map((entry) => [entry.thread_id, entry]));
    review.discussionScope = scope;
    const discussion = await readDiscussion(this.storage, scope);
    review.commentReads = discussion.commentReads;
    review.threads = discussion.threads.filter((thread) => !thread.kind && !thread.discarded).map((source) => {
      const existing = threads.get(source.id);
      const thread = structuredClone(source);
      thread.humanSequence = existing?.human_sequence ?? 0;
      thread.messages = source.messages.map((message) => {
        const known = messages.get(message.id);
        if (known && known.body_hash === bodyHash(message.body)) return { ...message, sequence: known.sequence };
        const sequence = ++review.sequence;
        if (message.author === "user") review.humanSequence = thread.humanSequence = sequence;
        return { ...message, sequence };
      });
      // Relational reconstruction can change property order without changing a
      // message. Treat only domain changes as new delivery events.
      if (existing && threadFingerprint(thread) !== existing.fingerprint) review.sequence++;
      return thread;
    });
    // Deleting the final message removes the thread, but must still wake the browser and agent.
    if ([...messages.keys()].some((id) => !review.threads.some((entry) => entry.messages.some((current) => current.id === id)))) {
      review.humanSequence = ++review.sequence;
    }
    const changed = !isDeepStrictEqual(before, review);
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

  /** Fetch outside write queues; a superseded capture cannot replace the latest accepted snapshot. */
  async refresh(id: string, load: (previous: LocalReview) => Promise<LocalReview>): Promise<ReviewSession> {
    let versions = refreshes.get(this.storage);
    if (!versions) { versions = new Map(); refreshes.set(this.storage, versions); }
    const generation = (versions.get(id) ?? 0) + 1;
    versions.set(id, generation);
    const previous = await this.get(id);
    if (previous.finished) throw new Error("Review is finished. Start a new review.");
    const snapshot = await load(previous.snapshot);
    return this.update(id, false, (review) => {
      if (versions.get(id) !== generation) throw new Error("A newer snapshot refresh superseded this request.");
      if (review.finished) throw new Error("Review is finished. Start a new review.");
      if (snapshot.workspace.id !== review.snapshot.workspace.id) throw new Error("Snapshot belongs to another workspace.");
      review.snapshot = snapshot;
    });
  }

  /** Session IDs are opaque keys and must already exist. */
  private async read(id: string): Promise<ReviewSession> {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid review ID");
    return readAgentSession(this.storage.db, id);
  }

  /** Save counters and delivery observations atomically; snapshots and live comments are separate. */
  private async save(review: ReviewSession) {
    saveAgentSession(this.storage.db, review);
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
  for (const previous of before) if (!edited.some((thread) => thread.id === previous.id)) {
    const index = target.findIndex((thread) => thread.id === previous.id);
    if (index !== -1) target.splice(index, 1);
  }
  for (const thread of edited) {
    const existing = target.find((entry) => entry.id === thread.id);
    const previous = before.find((entry) => entry.id === thread.id);
    // An old session snapshot must not resurrect a concurrently deleted thread or message.
    if (!existing) { if (!previous) target.push(structuredClone(thread)); continue; }
    for (const message of thread.messages) if (!existing.messages.some((entry) => entry.id === message.id) && !previous?.messages.some((entry) => entry.id === message.id)) existing.messages.push(structuredClone(message));
    if (previous) {
      existing.messages = existing.messages.filter((message) => !previous.messages.some((entry) => entry.id === message.id) || thread.messages.some((entry) => entry.id === message.id));
      for (const message of thread.messages) {
        const old = previous.messages.find((entry) => entry.id === message.id);
        const current = existing.messages.find((entry) => entry.id === message.id);
        if (old && current && old.body !== message.body) current.body = message.body;
      }
    }
    if (previous && previous.resolved !== thread.resolved) existing.resolved = thread.resolved;
  }
}
