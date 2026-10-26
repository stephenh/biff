import { createHash } from "node:crypto";
import type { Storage } from "./storage";
import { matchesChange, type ChangeIdentity, type ReviewedChange, type ReviewIdentity } from "../shared/progress";
import type { DraftComment, LocalReview, ReviewDraft } from "../shared/types";
import type { GitHub } from "./github";
import type { Workspaces } from "./workspaces";
import type { ReviewThread } from "../shared/localReview";
import type { Discussion } from "../shared/discussion";
import type { FollowUp, ThreadFollowUp } from "../shared/followUps";
import { parsePatchFiles } from "@pierre/diffs";
import { identifyChanges, identifyFiles, identifyMetadata } from "../shared/changeProgress";
import { HunkApprovals } from "./hunkApprovals";
import type { FileDiffMetadata } from "@pierre/diffs";
import { splitSemanticChanges } from "../shared/semanticChanges";
import type { GitHubFileReview } from "./githubViewedSync";
import { DiscussionThreads } from "./discussionThreads";
import { ReviewStore, reviewMetadataValue } from "./reviewStore";

interface ReviewRecord extends ReviewIdentity {
  records: ReviewedChange[];
  commits: string[];
  changes: string[];
  bookmarkTips?: string[];
  prHeads?: string[];
  threads?: ReviewThread[];
  discussionVersion?: number;
  commentReads?: string[];
  githubFileReview?: GitHubFileReview;
  followUps?: FollowUp[];
  followUpHeads?: Record<string, string>;
  draft?: { version: number; body: string; commitId: string };
  draftReceipts?: { kind: "import" | "publication"; token: string }[];
}
interface Registry { reviews: Record<string, ReviewRecord>; aliases: Record<string, string>; locals: Record<string, string> }
const sharedDiscussionListeners = new WeakMap<Storage, Set<() => void>>();

/** One transactional registry owns review lifetimes, aliases, progress, and durable discussions. */
export class Progress {
  private approvals: HunkApprovals;
  private threads: DiscussionThreads;
  private discussionListeners = new Set<() => void>();
  private publications = new Map<string, Promise<void>>();
  constructor(private storage: Storage) {
    this.approvals = new HunkApprovals(storage.db);
    this.threads = new DiscussionThreads(storage.db);
    this.discussionListeners = sharedDiscussionListeners.get(storage) ?? new Set();
    sharedDiscussionListeners.set(storage, this.discussionListeners);
  }

  /** Attach the same durable lifetime to ordinary workspace and agent-collaboration snapshots. */
  async prepare(snapshot: LocalReview, github: GitHub, workspaces?: Workspaces): Promise<LocalReview> {
    if (snapshot.changes !== "all") {
      await this.migrateFileApprovals(`jj/${snapshot.workspace.id}/${snapshot.selected.change_id}`, snapshot.patch, snapshot.selected.commit_id);
      return snapshot;
    }
    let identity = await this.local(snapshot);
    if (identity.pr) {
      const [owner, repo, number] = identity.pr.split("/");
      const pr = await github.pullRequest(`${owner}/${repo}`, number);
      if (pr.state === "closed") {
        await this.close(identity.pr);
        identity = await this.local(snapshot);
      } else if (workspaces && snapshot.tip) {
        // The target tip may not exist locally. Its GitHub fork is part of the pushed
        // history and avoids guessing from a stale local branch with the same name.
        const base = await github.mergeBase(`${owner}/${repo}`, pr.base.sha, pr.head.sha);
        snapshot = await workspaces.bookmarkReview(snapshot.workspace.id, snapshot.bookmark, snapshot.changes, base, snapshot.followWorkingCopy);
        snapshot.baseLabel = pr.base.ref;
        snapshot.baseOverride = undefined;
      }
    }
    if (snapshot.tip && !snapshot.baseOverride) await this.reconcileFollowUps(identity.id, snapshot.patch, snapshot.selected.commit_id, "local", snapshot.revisions.map((revision) => revision.commit_id));
    await this.migrateFileApprovals(identity.id, snapshot.patch, snapshot.selected.commit_id);
    return { ...snapshot, identity, progressScope: identity.id };
  }

  /** Read through aliases so a linked PR and local snapshot always see the same records. */
  get(scope: string): Promise<ReviewedChange[]> {
    return this.storage.serialize("progress", async () => this.approvals.get(this.lookup(scope)));
  }

  /** Batch file and block marks together, including their removal, before acknowledging the UI. */
  update(scope: string, identity: ChangeIdentity, reviewed: boolean, head: string, blocks: ChangeIdentity[] = []): Promise<ReviewedChange[]> {
    return this.updateBatch(scope, (identity.kind === "file" ? blocks : [identity]).map((entry) => ({ identity: entry, reviewed })), head);
  }

  /** A file action changes its units atomically; no independent file approval is written. */
  updateBatch(scope: string, changes: { identity: ChangeIdentity; reviewed: boolean }[], head: string): Promise<ReviewedChange[]> {
    return this.storage.serialize("progress", async () => this.storage.db.transaction(() => {
      const id = this.lookup(scope, true);
      for (const change of changes) {
        if (change.identity.kind === "file") throw new Error("Expected a hunk or metadata unit");
        this.approvals.update(id, change.identity, change.reviewed, head);
      }
      // Once a reader changes this file, old file evidence must never resurrect removed approvals.
      const row = this.storage.db.query<{ value: string }, [string]>("SELECT value FROM reviews WHERE id=?").get(id)!;
      const review = JSON.parse(row.value) as ReviewRecord;
      review.records = review.records.filter((record) => !changes.some((change) => change.identity.path === record.path));
      this.storage.db.query("UPDATE reviews SET value=? WHERE id=?").run(JSON.stringify(review), id);
      return this.approvals.get(id);
    })());
  }

  /** Translate legacy file evidence only when the exact content fingerprint is available again. */
  async migrateFileApprovals(scope: string, comparison: FileDiffMetadata[] | string, head: string) {
    const row = this.storage.db.query<{ value: string }, [string]>("SELECT value FROM reviews WHERE id=?").get(this.lookup(scope));
    if (!row || !(JSON.parse(row.value) as ReviewRecord).records.some((record) => record.kind === "file")) return;
    const files = typeof comparison === "string" ? splitSemanticChanges(parsePatchFiles(comparison, undefined, true).flatMap((entry) => entry.files)) : comparison;
    const blocks = await identifyChanges(files);
    const identities = await identifyFiles(files, blocks, head);
    const metadata = await identifyMetadata(files, head);
    await this.transaction(async (state) => {
      const review = await this.resolve(state, scope);
      for (const file of identities) {
        const legacy = review.records.find((record) => record.kind === "file" && matchesChange(record, file));
        if (!legacy) continue;
        review.records = review.records.filter((record) => record !== legacy);
        for (const unit of [...blocks, ...metadata].filter((unit) => unit.path === file.path)) {
          if (!review.records.some((record) => matchesChange(record, unit))) review.records.push({ ...unit, head: legacy.head, reviewedAt: legacy.reviewedAt });
        }
      }
    });
  }

  /** Resolve a single scope without scanning the registry; reads never allocate a lifetime. */
  private lookup(scope: string, create = false): string {
    const row = this.storage.db.query<{ id: string }, [string, string]>("SELECT id FROM reviews WHERE id=? OR id=(SELECT review_id FROM review_aliases WHERE alias=?)").get(scope, scope);
    if (row) return row.id;
    if (!create) return "";
    const review = newReview();
    new ReviewStore(this.storage.db).save(review, reviewMetadataValue(review));
    this.storage.db.query("INSERT INTO review_aliases VALUES (?,?)").run(scope, review.id);
    return review.id;
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
        if (review) delete review.local;
        review = newReview();
        state.reviews[review.id] = review;
        state.locals[key] = review.id;
        state.aliases[`jj/${snapshot.workspace.id}/${review.id}`] = review.id;
      }
      review.commits = [...new Set([...review.commits, ...commits])];
      // Old range commits cannot establish tip evidence retroactively. Record it only
      // from a newly resolved snapshot, keeping unbookmarked agent extensions separate.
      review.bookmarkTips = [...new Set([...(review.bookmarkTips ?? []), (snapshot.bookmarkTip ?? snapshot.tip ?? snapshot.selected).commit_id])];
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
      return { identity: identityOf(review), version: review.discussionVersion ?? 0, threads: review.threads ?? [], commentReads: review.commentReads ?? [] };
    });
  }

  /** Review comments are durable threads; the summary and edit version belong to the PR, not its head. */
  reviewDraft(scope: string): Promise<ReviewDraft> {
    return this.transaction(async (state) => {
      const review = await this.resolve(state, scope);
      const comparison = this.storage.db.query<{ head: string; base: string }, [string]>("SELECT head,base FROM thread_comparisons WHERE review_id=?").get(review.id);
      return { ...draftOf(review), ...(comparison ? { currentHead: comparison.head, currentBase: comparison.base } : {}) };
    });
  }

  /**
   * Compare versions before replacing a draft so stale tabs fail visibly instead of dropping newer notes.
   *
   * Imports only add unseen IDs; tombstones and import receipts prevent old browsers from resurrecting submitted text.
   */
  async saveReviewDraft(scope: string, draft: ReviewDraft, incoming: ReviewThread[], importing = false): Promise<ReviewDraft> {
    let changed = false;
    const result = await this.transaction(async (state) => {
      const review = await this.resolve(state, scope);
      const current = review.draft ?? { version: 0, body: "", commitId: draft.commitId };
      const importHash = createHash("sha256").update(JSON.stringify([draft.commitId, draft.body, draft.comments.map((comment) => [comment.id, comment.body])])).digest("hex");
      if (importing && review.draftReceipts?.some((receipt) => receipt.kind === "import" && receipt.token === importHash)) return draftOf(review);
      if (!importing && current.version !== draft.version) {
        const saved = draftOf(review);
        if (saved.body === draft.body && saved.comments.length === draft.comments.length && saved.comments.every((comment, index) => comment.id === draft.comments[index].id && comment.body === draft.comments[index].body && !draft.comments[index].reanchor)) return saved;
        throw new Error("This review draft changed in another tab. Your text is kept in this browser; reload the draft before retrying.");
      }
      review.threads ??= [];
      for (const thread of incoming) {
        const owner = this.storage.db.query<{ review_id: string }, [string]>("SELECT review_id FROM review_threads WHERE id=?").get(thread.id);
        if (owner && owner.review_id !== review.id) throw new Error("This comment belongs to another review.");
        const existing = review.threads.find((entry) => entry.id === thread.id);
        if (existing) {
          if (importing) continue;
          if (existing.discarded || existing.messages[0]?.published) {
            if (existing.messages[0]?.body !== thread.messages[0].body) throw new Error("This comment was published while you were editing. Your text is kept; reload the saved draft before retrying.");
            continue;
          }
          existing.messages[0].body = thread.messages[0].body;
          if (draft.comments.find((comment) => comment.id === thread.id)?.reanchor) {
            existing.anchor = thread.anchor; existing.hunk = thread.hunk; existing.attachment = thread.attachment;
          }
        } else review.threads.push(thread);
      }
      if (!importing) for (const thread of review.threads) {
        if (thread.kind === "review" && !thread.messages[0]?.published && !incoming.some((entry) => entry.id === thread.id)) thread.discarded = true;
      }
      review.draft = { version: current.version + 1, body: importing ? current.body || draft.body : draft.body, commitId: draft.commitId };
      if (importing) (review.draftReceipts ??= []).push({ kind: "import", token: importHash });
      review.discussionVersion = (review.discussionVersion ?? 0) + 1;
      changed = true;
      return draftOf(review);
    });
    if (changed) for (const listener of this.discussionListeners) listener();
    return result;
  }

  /**
   * Clear only acknowledged text; edits made while publication was in flight remain unsent.
   *
   * Newer message text gets its own thread identity so a later receipt for the sent text cannot consume it.
   */
  async acknowledgeReview(scope: string, sent: ReviewDraft, publicationId?: number): Promise<void> {
    let changed = false;
    await this.transaction(async (state) => {
      const review = await this.resolve(state, scope);
      // Recovering a lost HTTP response must not consume another summary typed
      // after the original acknowledgement, even if its text happens to match.
      if (publicationId !== undefined) {
        const token = String(publicationId);
        if (review.draftReceipts?.some((receipt) => receipt.kind === "publication" && receipt.token === token)) return;
        (review.draftReceipts ??= []).push({ kind: "publication", token });
      }
      if (review.draft) {
        if (review.draft.body === sent.body) review.draft.body = "";
        review.draft.version++;
      }
      for (const comment of sent.comments) {
        for (const pending of review.threads ?? []) {
          if (pending.kind === "review" && pending.forkedFrom === comment.id && !pending.messages[0]?.published && pending.messages[0]?.body === comment.body && samePublicationAnchor(pending, comment)) pending.discarded = true;
        }
        const thread = review.threads?.find((entry) => entry.id === comment.id);
        if (!thread || thread.discarded) continue;
        if (!thread.messages[0]?.published && thread.messages[0]?.body !== comment.body) {
          const id = crypto.randomUUID();
          review.threads!.push({ ...thread, id, forkedFrom: thread.id, kind: "review", discarded: false, messages: [{ ...thread.messages[0], id, publicationPending: undefined }] });
          thread.messages[0].body = comment.body;
        }
        thread.discarded = true;
      }
      review.discussionVersion = (review.discussionVersion ?? 0) + 1;
      changed = true;
    });
    if (changed) for (const listener of this.discussionListeners) listener();
  }

  /** Remember individual messages so new replies never inherit a thread's read state. */
  commentReads(scope: string, keys: string[] = []): Promise<string[]> {
    return this.transaction(async (state) => {
      const review = await this.resolve(state, scope);
      review.commentReads = [...new Set([...(review.commentReads ?? []), ...keys])];
      return review.commentReads;
    });
  }

  /** Dashboard counts use the same receipts as comment views without allocating a lifetime. */
  commentReadSnapshot(scope: string): string[] {
    return new ReviewStore(this.storage.db).reads(this.lookup(scope));
  }

  /** Keep GitHub acknowledgement and retry state with the review lifetime it belongs to. */
  async saveGitHubFileReview(scope: string, value: GitHubFileReview): Promise<void> {
    await this.transaction(async (state) => { (await this.resolve(state, scope)).githubFileReview = value; });
  }

  /** Read synchronization state through the same local/PR aliases as reviewed hunks. */
  githubFileReview(scope: string): GitHubFileReview | undefined {
    const row = this.storage.db.query<{ value: string }, [string, string]>("SELECT value FROM reviews WHERE id=? OR id=(SELECT review_id FROM review_aliases WHERE alias=?)").get(scope, scope);
    return row ? (JSON.parse(row.value) as ReviewRecord).githubFileReview : undefined;
  }

  /** Resume registered reviews after restart without needing a browser to reopen them. */
  githubFileReviews(): GitHubFileReview[] {
    return this.storage.db.query<{ value: string }, []>("SELECT value FROM reviews WHERE json_type(value, '$.githubFileReview')='object'").all().map((row) => (JSON.parse(row.value) as ReviewRecord).githubFileReview!);
  }

  /** Read without allocating a review just to count dashboard follow-ups. */
  followUps(scope: string): FollowUp[] {
    const row = this.storage.db.query<{ value: string }, [string, string]>("SELECT value FROM reviews WHERE id=? OR id=(SELECT review_id FROM review_aliases WHERE alias=?)").get(scope, scope);
    if (!row) return [];
    const review = JSON.parse(row.value) as ReviewRecord;
    return normalizedFollowUps(review);
  }

  /** Flagging a hunk and marking it reviewed is one durable operation; clearing preserves progress. */
  followUpHunk(scope: string, block: ChangeIdentity, head: string, enabled: boolean): Promise<FollowUp[]> {
    return this.transaction(async (state) => {
      const review = await this.resolve(state, scope);
      review.followUps = normalizedFollowUps(review).filter((item) => item.type !== "hunk" || !matchesChange(item, block));
      if (enabled) {
        review.followUps.push({ ...block, type: "hunk", head, source: scope.startsWith("jj/") ? "local" : "pr" });
        review.records = review.records.filter((entry) => !matchesChange(entry, block));
        review.records.push({ ...block, head, reviewedAt: new Date().toISOString() });
      }
      review.followUpHeads = {};
      return review.followUps;
    });
  }

  /** One flag follows the whole discussion, including a locally published thread. */
  followUpThread(scope: string, thread: ThreadFollowUp, enabled: boolean): Promise<FollowUp[]> {
    return this.transaction(async (state) => {
      const review = await this.resolve(state, scope);
      const id = canonicalThread(review, thread.id);
      if (enabled && id.startsWith("local:") && !review.threads?.some((entry) => `local:${entry.id}` === id)) throw new Error("Thread not found");
      review.followUps = normalizedFollowUps(review).filter((item) => item.type !== "thread" || item.id !== id);
      if (enabled) review.followUps.push({ ...thread, id });
      return review.followUps;
    });
  }

  /** Only complete current snapshots may remove hunk flags; readers never submit pruning lists. */
  async reconcileFollowUps(scope: string, patch: string, head: string, source: "pr" | "local", commits: string[] = [], candidates = this.followUps(scope)): Promise<void> {
    if (!candidates.some((item) => item.type === "hunk")) return;
    const files = patch.trim() ? parsePatchFiles(patch, undefined, true).flatMap((entry) => entry.files) : [];
    if (patch.trim() && !files.length) throw new Error("Could not identify follow-up hunks from this diff");
    const blocks = await identifyChanges(splitSemanticChanges(files));
    await this.transaction(async (state) => {
      const review = await this.resolve(state, scope);
      review.followUps = normalizedFollowUps(review).filter((item) => item.type !== "hunk" ||
        // A flag created while the diff was fetching belongs to a later reader snapshot.
        !candidates.some((candidate) => candidate.type === "hunk" && candidate.head === item.head && matchesChange(candidate, item)) ||
        // Local work ahead of the PR must not be discarded by the older remote snapshot (or vice versa).
        (item.source !== source && !commits.includes(item.head)) || blocks.some((block) => matchesChange(item, block)));
      if (!review.followUps.some((item) => item.type === "hunk" && !candidates.some((candidate) => candidate.type === "hunk" && candidate.head === item.head && matchesChange(candidate, item)))) (review.followUpHeads ??= {})[source] = head;
    });
  }

  /** Background refreshes fetch a diff only when a flagged PR needs a new head reconciled. */
  needsFollowUpDiff(scope: string, head: string): boolean {
    const row = this.storage.db.query<{ value: string }, [string]>("SELECT value FROM reviews WHERE id=(SELECT review_id FROM review_aliases WHERE alias=?)").get(scope);
    if (!row) return false;
    const review = JSON.parse(row.value) as ReviewRecord;
    return Boolean(review.followUps?.some((item) => item.type === "hunk") && review.followUpHeads?.pr !== head);
  }

  /** Delete flags only after a successful complete GitHub conversation fetch; resolution keeps flags. */
  async reconcileFollowUpThreads(scope: string, existingIds: number[]): Promise<void> {
    if (!this.followUps(scope).some((item) => item.type === "thread" && item.id.startsWith("github:"))) return;
    const ids = new Set(existingIds.map((id) => `github:${id}`));
    await this.transaction(async (state) => {
      const review = await this.resolve(state, scope);
      review.followUps = normalizedFollowUps(review).filter((item) => item.type !== "thread" || !item.id.startsWith("github:") || ids.has(item.id));
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
      const discussion: Discussion = { identity: identityOf(review), version: review.discussionVersion ?? 0, threads: review.threads ??= [], commentReads: review.commentReads ?? [] };
      const before = JSON.stringify([discussion.threads, discussion.commentReads]);
      const draftBefore = draftIntent(review);
      await change(discussion);
      if (review.draft && draftBefore !== draftIntent(review)) review.draft.version++;
      review.commentReads = [...new Set(discussion.commentReads ?? [])];
      review.followUps = normalizedFollowUps(review).filter((item) => item.type !== "thread" || !item.id.startsWith("local:") || review.threads?.some((thread) => `local:${thread.id}` === item.id));
      changed = before !== JSON.stringify([discussion.threads, discussion.commentReads]);
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
  pullRequest(scope: string, commits: string[], closed = false, head?: string): Promise<ReviewIdentity> {
    return this.transaction(async (state) => {
      const remote = await this.resolve(state, scope);
      remote.pr = scope;
      remote.commits = [...new Set([...remote.commits, ...commits])];
      if (head) remote.prHeads = [...new Set([...(remote.prHeads ?? []), head])];
      remote.closed ||= closed;
      discoverLinks(state);
      return identityOf(state.reviews[state.aliases[scope]]);
    });
  }

  /** A closed/merged PR ends this lifetime; reopening the PR does not reuse a new bookmark review. */
  close(scope: string): Promise<void> {
    return this.transaction(async (state) => { (await this.resolve(state, scope)).closed = true; });
  }

  /** Resolve a scope to one durable lifetime, allocating it on first use. */
  private async resolve(state: Registry, scope: string): Promise<ReviewRecord> {
    const existing = state.reviews[scope] ?? state.reviews[state.aliases[scope]];
    if (existing) return existing;
    const review = newReview();
    state.reviews[review.id] = review;
    state.aliases[scope] = review.id;
    return review;
  }

  /**
   * Serialize review changes and commit records with all alias redirects atomically.
   *
   * Mutations may call GitHub, so their asynchronous work finishes before the SQLite write transaction.
   */
  private transaction<T>(operation: (state: Registry) => Promise<T>): Promise<T> {
    return this.storage.serialize("progress", async () => {
      const db = this.storage.db;
      const reviewStore = new ReviewStore(db);
      const rows = db.query<{ id: string; value: string }, []>("SELECT * FROM reviews").all();
      const aliases = db.query<{ alias: string; review_id: string }, []>("SELECT * FROM review_aliases").all();
      const locals = db.query<{ scope: string; review_id: string }, []>("SELECT * FROM local_reviews").all();
      const state: Registry = {
        reviews: Object.fromEntries(rows.map((row) => {
          const review = { ...JSON.parse(row.value), ...reviewStore.get(row.id) } as ReviewRecord;
          review.records = [...review.records, ...this.approvals.get(row.id)];
          review.threads = this.threads.get(row.id);
          const draft = db.query<{ version: number; body: string; commit_id: string }, [string]>("SELECT * FROM review_draft_state WHERE review_id=?").get(row.id);
          if (draft) review.draft = { version: draft.version, body: draft.body, commitId: draft.commit_id };
          review.draftReceipts = db.query<{ kind: "import" | "publication"; token: string }, [string]>("SELECT kind,token FROM review_draft_receipts WHERE review_id=?").all(row.id);
          return [row.id, review];
        })),
        aliases: Object.fromEntries(aliases.map((row) => [row.alias, row.review_id])),
        locals: Object.fromEntries(locals.map((row) => [row.scope, row.review_id])),
      };
      const previous = new Map(Object.values(state.reviews).map((review) => [review.id, JSON.stringify(review)]));
      const result = await operation(state);
      db.transaction(() => {
        for (const review of Object.values(state.reviews)) {
          const { threads, draft, draftReceipts, ...metadata } = review;
          const value = reviewMetadataValue({ ...metadata, records: review.records.filter((record) => record.kind === "file") });
          if (previous.get(review.id) !== JSON.stringify(review)) reviewStore.save(review, value);
          const approvals = review.records.filter((record) => record.kind !== "file");
          if (JSON.stringify(this.approvals.get(review.id)) !== JSON.stringify(approvals)) this.approvals.replace(review.id, approvals);
          if (JSON.stringify(this.threads.get(review.id)) !== JSON.stringify(threads ?? [])) this.threads.replace(review.id, threads ?? []);
          if (draft) db.query("INSERT INTO review_draft_state VALUES (?,?,?,?) ON CONFLICT(review_id) DO UPDATE SET version=excluded.version,body=excluded.body,commit_id=excluded.commit_id").run(review.id, draft.version, draft.body, draft.commitId);
          for (const receipt of draftReceipts ?? []) db.query("INSERT INTO review_draft_receipts VALUES (?,?,?) ON CONFLICT DO NOTHING").run(review.id, receipt.kind, receipt.token);
        }
        // Linking local and PR lifetimes moves thread ownership before deleting the retired review.
        db.exec(`UPDATE logical_hunks SET review_id=(SELECT t.review_id FROM thread_anchors a JOIN review_threads t ON t.id=a.thread_id WHERE a.hunk_id=logical_hunks.id LIMIT 1)
          WHERE EXISTS (SELECT 1 FROM thread_anchors a JOIN review_threads t ON t.id=a.thread_id WHERE a.hunk_id=logical_hunks.id AND t.review_id!=logical_hunks.review_id)`);
        for (const row of rows) if (!state.reviews[row.id]) {
          // Unanchored imports and general conversations are not part of the diff-thread projection.
          // Move their ownership too before the retired lifetime cascades its remaining children.
          const alias = aliases.find((entry) => entry.review_id === row.id && state.aliases[entry.alias] !== row.id);
          if (alias) db.query("UPDATE review_threads SET review_id=? WHERE review_id=?").run(state.aliases[alias.alias], row.id);
          db.query("DELETE FROM reviews WHERE id=?").run(row.id);
        }
        for (const [alias, id] of Object.entries(state.aliases)) db.query("INSERT INTO review_aliases VALUES (?, ?) ON CONFLICT(alias) DO UPDATE SET review_id=excluded.review_id WHERE review_id != excluded.review_id").run(alias, id);
        for (const [scope, id] of Object.entries(state.locals)) db.query("INSERT INTO local_reviews VALUES (?, ?) ON CONFLICT(scope) DO UPDATE SET review_id=excluded.review_id WHERE review_id != excluded.review_id").run(scope, id);
      })();
      return result;
    });
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
  const matches = remotes.map((remote) => ({ remote, locals: locals.filter((local) => remote.prHeads?.some((head) => local.bookmarkTips?.includes(head))) }));
  for (const match of matches) {
    if (match.locals.length !== 1) continue;
    const local = match.locals[0];
    if (matches.filter((candidate) => candidate.locals.includes(local)).length !== 1) continue;
    const remote = match.remote;
    for (const entry of remote.records) if (!local.records.some((saved) => matchesChange(saved, entry))) local.records.push(entry);
    local.threads = [...(local.threads ?? []), ...(remote.threads ?? []).filter((thread) => !local.threads?.some((entry) => entry.id === thread.id))];
    local.discussionVersion = Math.max(local.discussionVersion ?? 0, remote.discussionVersion ?? 0) + 1;
    local.commentReads = [...new Set([...(local.commentReads ?? []), ...(remote.commentReads ?? [])])];
    local.githubFileReview = remote.githubFileReview ?? local.githubFileReview;
    local.draft = remote.draft ?? local.draft;
    local.draftReceipts = [...(local.draftReceipts ?? []), ...(remote.draftReceipts ?? [])].filter((receipt, index, receipts) => receipts.findIndex((entry) => entry.kind === receipt.kind && entry.token === receipt.token) === index);
    local.followUps = normalizedFollowUps({ ...local, followUps: [...(local.followUps ?? []), ...(remote.followUps ?? [])] });
    local.followUpHeads = {};
    local.commits = [...new Set([...local.commits, ...remote.commits])];
    local.prHeads = [...new Set([...(local.prHeads ?? []), ...(remote.prHeads ?? [])])];
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

/** Missing attachments stay in the draft as actionable notes rather than disappearing from the review. */
function draftOf(review: ReviewRecord): ReviewDraft {
  return { version: review.draft?.version ?? 0, body: review.draft?.body ?? "", commitId: review.draft?.commitId ?? "", comments: (review.threads ?? []).filter((thread) => thread.kind === "review" && !thread.discarded && !thread.messages[0]?.published).map((thread) => {
    const location = thread.attachment?.matched ? thread.attachment : thread.anchor;
    return { id: thread.id, ...(thread.forkedFrom ? { supersedes: thread.forkedFrom } : {}), path: location.path, side: location.side, line: location.line, body: thread.messages[0].body, commitId: location.commitId, baseCommitId: location.baseCommitId,
      ...(thread.hunk ? { anchor: thread.hunk } : {}), needsReanchoring: !thread.attachment?.matched };
  }) };
}

/** Attachment movement is not a text edit; publication and imported replies can change draft membership. */
function draftIntent(review: ReviewRecord): string {
  const draft = draftOf(review);
  return JSON.stringify([draft.body, draft.comments.map((comment) => [comment.id, comment.body])]);
}

/** Identical words moved to a different hunk are a different pending comment, not an acknowledgement target. */
function samePublicationAnchor(thread: ReviewThread, comment: DraftComment): boolean {
  if (thread.hunk && comment.anchor) return thread.anchor.side === comment.side && thread.hunk.change.path === comment.anchor.change.path && thread.hunk.change.hash === comment.anchor.change.hash && thread.hunk.offset === comment.anchor.offset;
  const location = thread.attachment?.matched ? thread.attachment : thread.anchor;
  return location.path === comment.path && location.side === comment.side && location.line === comment.line;
}

/** Publication changes presentation, not the identity of a personal thread follow-up. */
function canonicalThread(review: ReviewRecord, id: string): string {
  if (!id.startsWith("github:")) return id;
  const local = review.threads?.find((thread) => !thread.kind && thread.messages[0]?.published?.id === Number(id.slice(7)));
  return local ? `local:${local.id}` : id;
}

/** Linked lifetimes and published local threads must not count the same follow-up twice. */
function normalizedFollowUps(review: ReviewRecord): FollowUp[] {
  const result: FollowUp[] = [];
  for (const saved of review.followUps ?? []) {
    const item = saved.type === "thread" ? { ...saved, id: canonicalThread(review, saved.id) } : saved;
    if (item.type === "thread" && item.id.startsWith("local:")) item.githubId = review.threads?.find((thread) => `local:${thread.id}` === item.id)?.messages[0]?.published?.id;
    if (!result.some((entry) => item.type === "thread" ? entry.type === "thread" && entry.id === item.id : entry.type === "hunk" && matchesChange(entry, item))) result.push(item);
  }
  return result;
}
