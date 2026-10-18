import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { matchesChange, type ChangeIdentity, type ReviewedChange, type ReviewIdentity } from "../shared/progress";
import type { LocalReview } from "../shared/types";
import type { GitHub } from "./github";
import type { ReviewThread } from "../shared/localReview";
import type { Discussion } from "../shared/discussion";

interface ReviewRecord extends ReviewIdentity {
  records: ReviewedChange[];
  commits: string[];
  changes: string[];
  threads?: ReviewThread[];
  discussionVersion?: number;
  commentReads?: string[];
}
interface Registry { reviews: Record<string, ReviewRecord>; aliases: Record<string, string>; locals: Record<string, string> }

/** One atomic registry owns review lifetimes, aliases, and progress; legacy scopes migrate on first use. */
export class Progress {
  private writes: Promise<unknown> = Promise.resolve();
  private discussionListeners = new Set<() => void>();
  private publications = new Map<string, Promise<void>>();
  constructor(private directory: string) {}

  /** Attach the same durable lifetime to ordinary workspace and agent-collaboration snapshots. */
  async prepare(snapshot: LocalReview, github: GitHub): Promise<LocalReview> {
    if (snapshot.changes !== "all") return snapshot;
    let identity = await this.local(snapshot);
    if (identity.pr) {
      const [owner, repo, number] = identity.pr.split("/");
      const pr = await github.pullRequest(`${owner}/${repo}`, number);
      if (pr.state === "closed") {
        await this.close(identity.pr);
        identity = await this.local(snapshot);
      }
    }
    return { ...snapshot, identity, progressScope: identity.id };
  }

  /** Read through aliases so a linked PR and local snapshot always see the same records. */
  get(scope: string): Promise<ReviewedChange[]> {
    return this.transaction(async (state) => (await this.resolve(state, scope)).records);
  }

  /** Batch file and block marks together, including their removal, before acknowledging the UI. */
  update(scope: string, identity: ChangeIdentity, reviewed: boolean, head: string, blocks: ChangeIdentity[] = []): Promise<ReviewedChange[]> {
    return this.transaction(async (state) => {
      const review = await this.resolve(state, scope);
      for (const entry of [identity, ...blocks]) {
        review.records = review.records.filter((saved) => !matchesChange(saved, entry));
        if (reviewed) review.records.push({ ...entry, head, reviewedAt: new Date().toISOString() });
      }
      // Changing a block makes an explicit file mark stale, even when undoing a previous approval.
      if (!identity.kind && !reviewed) review.records = review.records.filter((entry) => entry.kind !== "file" || entry.path !== identity.path);
      return review.records;
    });
  }

  /**
   * Follow exact JJ identities into subsequent snapshots.
   *
   * A bookmark is a lookup key, not proof of continuity. Disjoint change IDs or an ended
   * review create a new lifetime; older snapshot URLs keep addressing the previous one.
   */
  local(snapshot: LocalReview, fresh = false): Promise<ReviewIdentity> {
    return this.transaction(async (state) => {
      const key = JSON.stringify([snapshot.workspace.id, snapshot.bookmark || ""]);
      const commits = snapshot.revisions.map((revision) => revision.commit_id);
      const changes = snapshot.revisions.map((revision) => revision.change_id);
      let review = state.reviews[state.locals[key]];
      const unrelated = review && changes.length > 0 && review.changes.length > 0 && !changes.some((id) => review.changes.includes(id)) && !commits.some((id) => review.commits.includes(id));
      if (!review || fresh || review.closed || unrelated) {
        const first = !review;
        if (review) delete review.local;
        // Only the first lifetime may adopt the old bookmark/base-policy progress.
        review = first && snapshot.progressScope ? await this.resolve(state, `jj/${snapshot.workspace.id}/${snapshot.progressScope}`) : newReview();
        state.reviews[review.id] = review;
        state.locals[key] = review.id;
        state.aliases[`jj/${snapshot.workspace.id}/${review.id}`] = review.id;
      }
      review.commits = [...new Set([...review.commits, ...commits])];
      review.changes = [...new Set([...review.changes, ...changes])];
      review.local = { workspace: snapshot.workspace.id, bookmark: snapshot.bookmark || "" };
      discoverLinks(state);
      return identityOf(state.reviews[state.locals[key]]);
    });
  }

  /** Inspect the attached PR without exposing mutable storage objects. */
  identity(scope: string): Promise<ReviewIdentity> {
    return this.transaction(async (state) => identityOf(await this.resolve(state, scope)));
  }

  /** Durable comments share the same aliases and lifetime as file/hunk progress. */
  discussion(scope: string): Promise<Discussion> {
    return this.transaction(async (state) => {
      const review = await this.resolve(state, scope);
      return { identity: identityOf(review), version: review.discussionVersion ?? 0, threads: review.threads ?? [] };
    });
  }

  /** Remember individual messages so new replies never inherit a thread's read state. */
  commentReads(scope: string, keys: string[] = []): Promise<string[]> {
    return this.transaction(async (state) => {
      const review = await this.resolve(state, scope);
      review.commentReads = [...new Set([...(review.commentReads ?? []), ...keys])];
      return review.commentReads;
    });
  }

  /** Reject comments attached to a snapshot that was never recorded for this review. */
  requireSnapshot(scope: string, commitId: string): Promise<void> {
    return this.transaction(async (state) => {
      const review = await this.resolve(state, scope);
      if (!review.commits.includes(commitId)) throw new Error("This snapshot does not belong to the review. Refresh before commenting.");
    });
  }

  /** Serialize thread edits and publication so concurrent tabs cannot publish the same message twice. */
  async updateDiscussion(scope: string, change: (discussion: Discussion) => void | Promise<void>): Promise<Discussion> {
    let changed = false;
    const result = await this.transaction(async (state) => {
      const review = await this.resolve(state, scope);
      const discussion = { identity: identityOf(review), version: review.discussionVersion ?? 0, threads: review.threads ??= [] };
      const before = JSON.stringify(discussion.threads);
      await change(discussion);
      changed = before !== JSON.stringify(discussion.threads);
      if (changed) review.discussionVersion = discussion.version += 1;
      return discussion;
    });
    if (changed) for (const listener of this.discussionListeners) listener();
    return result;
  }

  /** Wake attached agents only after the durable discussion mutation is saved. */
  subscribeDiscussion(listener: () => void): () => void {
    this.discussionListeners.add(listener);
    return () => { this.discussionListeners.delete(listener); };
  }

  /**
   * Publish a snapshot of the pending messages without locking unrelated review progress.
   *
   * Persist intent before external writes and receipts afterward. Only this thread is serialized;
   * replies saved during publication remain local and are not silently added to the outgoing batch.
   */
  publishDiscussion(scope: string, threadId: string, publish: (thread: ReviewThread, pr: string) => Promise<void>): Promise<Discussion> {
    const previous = this.publications.get(threadId) ?? Promise.resolve();
    const result = previous.then(async () => {
      const snapshot = await this.updateDiscussion(scope, (discussion) => {
        if (!discussion.identity.pr) throw new Error("Open the matching PR in Biff before publishing.");
        const thread = discussion.threads.find((entry) => entry.id === threadId);
        if (!thread) throw new Error("Comment thread not found");
        for (const message of thread.messages) if (!message.published) message.publicationPending = true;
      });
      const sent = snapshot.threads.find((entry) => entry.id === threadId)!;
      let publicationError: string | undefined;
      try { await publish(sent, snapshot.identity.pr!); }
      catch (error) { publicationError = error instanceof Error ? error.message : String(error); }
      const saved = await this.updateDiscussion(scope, (discussion) => {
        const thread = discussion.threads.find((entry) => entry.id === threadId)!;
        for (const message of sent.messages) {
          const target = thread.messages.find((entry) => entry.id === message.id)!;
          if (message.published) target.published = message.published;
          if (message.publicationPending) target.publicationPending = true;
          else delete target.publicationPending;
        }
      });
      return { ...saved, publicationError };
    });
    const settled = result.then(() => {}, () => {});
    this.publications.set(threadId, settled);
    void settled.then(() => { if (this.publications.get(threadId) === settled) this.publications.delete(threadId); });
    return result;
  }

  /**
   * Record a PR snapshot and discover its local review using exact commit IDs.
   *
   * Redirect every alias in the same transaction as the merge so later removals cannot
   * be restored by another tab reading the old PR records.
   */
  pullRequest(scope: string, commits: string[], closed = false): Promise<ReviewIdentity> {
    return this.transaction(async (state) => {
      const remote = await this.resolve(state, scope);
      remote.pr = scope;
      remote.commits = [...new Set([...remote.commits, ...commits])];
      remote.closed ||= closed;
      discoverLinks(state);
      return identityOf(state.reviews[state.aliases[scope]]);
    });
  }

  /** A closed/merged PR ends this lifetime; reopening the PR does not reuse a new bookmark review. */
  close(scope: string): Promise<void> {
    return this.transaction(async (state) => { (await this.resolve(state, scope)).closed = true; });
  }

  /** Import each old scope once so removing a shared mark cannot resurrect it from legacy files. */
  private async resolve(state: Registry, scope: string): Promise<ReviewRecord> {
    const existing = state.reviews[state.aliases[scope]];
    if (existing) return existing;
    const review = newReview();
    review.records = await this.legacy(scope);
    state.reviews[review.id] = review;
    state.aliases[scope] = review.id;
    return review;
  }

  /** Serialize the entire read/modify/rename, including linking and progress edits from other tabs. */
  private transaction<T>(operation: (state: Registry) => Promise<T>): Promise<T> {
    const pending = this.writes.then(async () => {
      const path = join(this.directory, "reviews.json");
      const state: Registry = await readJson(path) ?? { reviews: {}, aliases: {}, locals: {} };
      const result = await operation(state);
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await writeFile(`${path}.tmp`, JSON.stringify(state), { mode: 0o600 });
      await rename(`${path}.tmp`, path);
      return result;
    });
    this.writes = pending.catch(() => {});
    return pending;
  }

  /** Hash old scopes so repository names never become filesystem paths. */
  private async legacy(scope: string): Promise<ReviewedChange[]> {
    return await readJson(join(this.directory, `${createHash("sha256").update(scope).digest("hex")}.json`)) ?? [];
  }
}

/**
 * Join only mutually unique matches, regardless of which view was opened first.
 *
 * A PR with JJ change history has already belonged to a local lifetime. If its bookmark
 * was detached by Start new review, never rediscover it as an unassociated PR.
 * Compute candidates before merging so iteration order cannot resolve ambiguous stacks.
 */
function discoverLinks(state: Registry): void {
  const reviews = Object.values(state.reviews);
  const locals = reviews.filter((review) => review.local && !review.pr && !review.closed);
  const remotes = reviews.filter((review) => review.pr && !review.local && !review.closed && review.changes.length === 0);
  const matches = remotes.map((remote) => ({ remote, locals: locals.filter((local) => remote.commits.some((commit) => local.commits.includes(commit))) }));
  for (const match of matches) {
    if (match.locals.length !== 1) continue;
    const local = match.locals[0];
    if (matches.filter((candidate) => candidate.locals.includes(local)).length !== 1) continue;
    const remote = match.remote;
    for (const entry of remote.records) if (!local.records.some((saved) => matchesChange(saved, entry))) local.records.push(entry);
    local.threads = [...(local.threads ?? []), ...(remote.threads ?? []).filter((thread) => !local.threads?.some((entry) => entry.id === thread.id))];
    local.discussionVersion = Math.max(local.discussionVersion ?? 0, remote.discussionVersion ?? 0) + 1;
    local.commentReads = [...new Set([...(local.commentReads ?? []), ...(remote.commentReads ?? [])])];
    local.commits = [...new Set([...local.commits, ...remote.commits])];
    local.pr = remote.pr;
    for (const [alias, id] of Object.entries(state.aliases)) if (id === remote.id) state.aliases[alias] = local.id;
    delete state.reviews[remote.id];
  }
}

/** Allocate a lifetime independently of a mutable bookmark name. */
function newReview(): ReviewRecord {
  return { id: createHash("sha256").update(crypto.randomUUID()).digest("hex"), closed: false, records: [], commits: [], changes: [] };
}

/** Keep persistence details out of API responses. */
function identityOf(review: ReviewRecord): ReviewIdentity { return { id: review.id, pr: review.pr, local: review.local, closed: review.closed }; }

/** Missing files are first-use state; corrupt data must remain an error. */
async function readJson<T>(path: string): Promise<T | undefined> {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
