import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { LocalReview } from "../shared/types";
import type { ReviewSession, ReviewThread } from "../shared/localReview";
import type { Progress } from "./progress";

/** Own short-lived review files; all mutations pass through one serialized writer. */
export class Reviews {
  private writes: Promise<unknown> = Promise.resolve();
  private listeners = new Set<() => void>();
  private progress?: Progress;
  private unsubscribe?: () => void;

  constructor(private directory: string) {}

  /** Agent sessions subscribe to durable bookmark comments without owning their lifetime. */
  connect(progress: Progress) {
    if (this.progress === progress) return;
    this.unsubscribe?.();
    this.progress = progress;
    this.unsubscribe = progress.subscribeDiscussion(() => { for (const wake of this.listeners) wake(); });
  }

  /** Recover host subscriptions from the review files themselves after a plugin restart. */
  async list(workspace: string): Promise<ReviewSession[]> {
    await this.writes;
    let files: string[];
    try { files = await readdir(this.directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    const reviews = await Promise.all(files.filter((file) => /^[a-f0-9-]{36}\.json$/.test(file)).map((file) => this.read(file.slice(0, -5))));
    return reviews.filter((review) => review.snapshot.workspace.path === workspace && (!review.finished || review.humanSequence > review.acknowledged) && Date.now() - Date.parse(review.updatedAt) <= 7 * 86400_000);
  }

  /** Reuse only an unfinished review belonging to this workspace and conversation. */
  async start(snapshot: LocalReview, agentSession: string): Promise<ReviewSession> {
    return this.serialize(async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      for (const file of await readdir(this.directory)) {
        if (!/^[a-f0-9-]{36}\.json$/.test(file)) continue;
        const review = await this.read(file.slice(0, -5));
        if (Date.now() - Date.parse(review.updatedAt) > 7 * 86400_000) {
          await unlink(join(this.directory, file));
          continue;
        }
        if (agentSession && !review.finished && review.agentSession === agentSession && review.snapshot.workspace.path === snapshot.workspace.path) return review;
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
      if (!review.finished && await this.syncDiscussion(review)) await this.save(review);
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
        await this.progress.updateDiscussion(review.discussionScope, (discussion) => mergeThreadEdits(discussion.threads, review.threads, before));
      }
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
    review.threads = discussion.threads.map((source) => {
      const existing = previous.find((thread) => thread.id === source.id);
      const thread = structuredClone(source);
      thread.humanSequence = existing?.humanSequence ?? 0;
      thread.messages = source.messages.map((message) => {
        const known = existing?.messages.find((entry) => entry.id === message.id);
        if (known) return { ...message, sequence: known.sequence };
        const sequence = ++review.sequence;
        if (message.author === "user") review.humanSequence = thread.humanSequence = sequence;
        return { ...message, sequence };
      });
      if (existing && JSON.stringify({ ...thread, humanSequence: 0 }) !== JSON.stringify({ ...existing, humanSequence: 0 })) review.sequence++;
      return thread;
    });
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
    const pending = this.writes.then(operation);
    this.writes = pending.catch(() => {});
    return pending;
  }

  /** IDs are opaque filenames, never paths supplied by the client. */
  private async read(id: string): Promise<ReviewSession> {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid review ID");
    return JSON.parse(await readFile(join(this.directory, `${id}.json`), "utf8"));
  }

  /** Rename on the same filesystem so a crash cannot expose half-written JSON. */
  private async save(review: ReviewSession) {
    const file = join(this.directory, `${review.id}.json`);
    await writeFile(`${file}.tmp`, JSON.stringify(review) + "\n", { mode: 0o600 });
    await rename(`${file}.tmp`, file);
  }
}

/** Retain stable message IDs and sequence numbers for reconnects and replies. */
export function appendMessage(review: ReviewSession, thread: ReviewThread, author: "user" | "agent", body: string) {
  thread.messages.push({ id: crypto.randomUUID(), author, body, createdAt: new Date().toISOString(), sequence: review.sequence });
}

/** Merge only the caller's edits so a concurrent local comment cannot be overwritten by an agent reply. */
function mergeThreadEdits(target: ReviewThread[], edited: ReviewThread[], before: ReviewThread[]): void {
  for (const thread of edited) {
    const existing = target.find((entry) => entry.id === thread.id);
    if (!existing) { target.push(structuredClone(thread)); continue; }
    const previous = before.find((entry) => entry.id === thread.id);
    for (const message of thread.messages) if (!existing.messages.some((entry) => entry.id === message.id)) existing.messages.push(structuredClone(message));
    if (previous && previous.resolved !== thread.resolved) existing.resolved = thread.resolved;
  }
}
