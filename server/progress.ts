import { createHash } from "node:crypto";
import type { Storage } from "./storage";
import type { ChangeIdentity, ReviewedChange, ReviewIdentity } from "../shared/progress";
import type { DraftComment, LocalReview, ReviewDraft, ViewedFiles } from "../shared/types";
import type { GitHub } from "./github";
import type { Workspaces } from "./workspaces";
import type { ReviewThread } from "../shared/localReview";
import type { Discussion } from "../shared/discussion";
import type { FollowUp, ThreadFollowUp } from "../shared/followUps";
import { parsePatchFiles } from "@pierre/diffs";
import { identifyChanges, identifyMetadata } from "../shared/changeProgress";
import { splitSemanticChanges } from "../shared/semanticChanges";
import { DiscussionThreads } from "./discussionThreads";
import { ReviewStore } from "./reviewStore";
import { readViewedSync, mergeViewedSync, type ViewedSync } from "./viewedFiles";
import { logicalHunk, mergeLogicalHunks, reviewedHunks, reviewHunk, type LogicalHunk } from "./logicalHunks";
import { flagThread, readFollowUps } from "./followUps";

interface ReviewRecord extends ReviewIdentity {
  commits: string[];
  changes: string[];
  bookmarkTips?: string[];
  prHeads?: string[];
  threads?: ReviewThread[];
  discussionVersion?: number;
  commentReads?: string[];
  draft?: { version: number; body: string; commitId: string };
  draftReceipts?: { kind: "import" | "publication"; token: string }[];
}
interface Registry { reviews: Record<string, ReviewRecord>; aliases: Record<string, string>; locals: Record<string, string> }
const sharedDiscussionListeners = new WeakMap<Storage, Set<() => void>>();
const sharedReconciliations = new WeakMap<Storage, Map<string, number>>();
export interface HunkReconciliation { review: string; source: "local" | "pr"; version: number }

/** One transactional registry owns review lifetimes, aliases, progress, and durable discussions. */
export class Progress {
  private threads: DiscussionThreads;
  private discussionListeners = new Set<() => void>();
  private publications = new Map<string, Promise<void>>();
  private reconciliations: Map<string, number>;
  constructor(private storage: Storage) {
    this.threads = new DiscussionThreads(storage.db);
    this.reconciliations = sharedReconciliations.get(storage) ?? new Map();
    sharedReconciliations.set(storage, this.reconciliations);
    this.discussionListeners = sharedDiscussionListeners.get(storage) ?? new Set();
    sharedDiscussionListeners.set(storage, this.discussionListeners);
  }

  /** Attach the same durable lifetime to ordinary workspace and agent-collaboration snapshots. */
  async prepare(snapshot: LocalReview, github: GitHub, workspaces?: Workspaces): Promise<LocalReview> {
    if (snapshot.changes !== "all") return snapshot;
    let identity = await this.local(snapshot);
    const reconciliation = this.beginHunkReconciliation(identity.id, "local");
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
    if (snapshot.tip && !snapshot.baseOverride) await this.reconcileFollowUps(identity.id, snapshot.patch, snapshot.selected.commit_id, "local", reconciliation);
    return { ...snapshot, identity, progressScope: identity.id };
  }

  /** Read through aliases so a linked PR and local snapshot always see the same records. */
  get(scope: string): Promise<ReviewedChange[]> {
    return this.storage.serialize("progress", async () => reviewedHunks(this.storage.db, this.lookup(scope)));
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
        reviewHunk(this.storage.db, id, change.identity, head, change.reviewed ? new Date().toISOString() : null);
      }
      this.invalidateReconciliations(id);
      return reviewedHunks(this.storage.db, id);
    })());
  }

  /** Resolve a single scope without scanning the registry; reads never allocate a lifetime. */
  private lookup(scope: string, create = false): string {
    const row = this.storage.db.query<{ id: string }, [string, string]>("SELECT id FROM reviews WHERE id=? OR id=(SELECT review_id FROM review_aliases WHERE alias=?)").get(scope, scope);
    if (row) return row.id;
    if (!create) return "";
    const review = newReview();
    new ReviewStore(this.storage.db).save(review);
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

  /** File completion is a query over canonical approvals, never a second persisted intent. */
  viewedSync(scope: string, path?: string): ViewedSync | undefined { return readViewedSync(this.storage.db, this.lookup(scope), path); }

  /** Resume registered PRs after restart without retaining their diffs or classifications as JSON. */
  viewedSyncScopes(): string[] {
    return this.storage.db.query<{ pr: string }, []>("SELECT pr FROM reviews WHERE viewed_sync_head IS NOT NULL AND pr IS NOT NULL").all().map((row) => row.pr);
  }

  /**
   * Observe GitHub's file flags against an already reconciled comparison.
   *
   * A user action during the fetch invalidates its token, so importing a remote Viewed mark cannot
   * overwrite newer local intent. Import only once per head, including across classification upgrades.
   */
  observeGitHubViewed(scope: string, head: string, base: string, remote: ViewedFiles, token: HunkReconciliation, importRemote: boolean): Promise<boolean> {
    return this.storage.serialize("progress", async () => this.storage.db.transaction(() => {
      const db = this.storage.db;
      const review = this.lookup(scope);
      if (!review) return false;
      if (token.review !== review || token.source !== "pr" || this.reconciliations.get(`${review}:pr`) !== token.version || this.needsPrComparison(scope, head, base)) {
        // Keep a durable retry registration even if a user's action interrupted the first snapshot.
        this.deferViewedSync(scope, head);
        return false;
      }
      const previous = this.viewedSync(scope);
      for (const [path, state] of Object.entries(remote.files)) {
        const githubViewed = state === "VIEWED";
        db.query(`INSERT INTO review_files (review_id,path,github_viewed) VALUES (?,?,?)
          ON CONFLICT(review_id,path) DO UPDATE SET github_viewed=excluded.github_viewed,sync_error=NULL`).run(review, path, Number(githubViewed));
        if (importRemote && previous?.head !== head && githubViewed) {
          db.query(`UPDATE logical_hunks SET reviewed_head=?,reviewed_at=?
            WHERE review_id=? AND path=? AND pr_head=? AND pr_reviewable=1 AND reviewed_at IS NULL`)
            .run(head, new Date().toISOString(), review, path, head);
        }
      }
      const paths = new Set(Object.keys(remote.files));
      for (const row of db.query<{ id: number; path: string }, [string]>("SELECT id,path FROM review_files WHERE review_id=?").all(review)) {
        if (!paths.has(row.path)) db.query("DELETE FROM review_files WHERE id=?").run(row.id);
      }
      db.query("UPDATE reviews SET pr=?,viewed_sync_head=?,viewed_sync_base=? WHERE id=?").run(scope, head, base, review);
      return true;
    })());
  }

  /** Keep interrupted first observations retryable without reimporting a stale remote Viewed flag. */
  deferViewedSync(scope: string, head: string): void {
    this.storage.db.query("UPDATE reviews SET viewed_sync_head=COALESCE(viewed_sync_head,?),viewed_sync_base=NULL WHERE id=?").run(head, this.lookup(scope));
  }

  /** Save GitHub's confirmed flag only for the comparison that was sent. */
  saveGitHubViewed(scope: string, head: string, base: string | null, path: string, githubViewed: boolean | undefined, error?: string): void {
    this.storage.db.query(`UPDATE review_files SET github_viewed=COALESCE(?,github_viewed),sync_error=?
      WHERE review_id=? AND path=? AND EXISTS (SELECT 1 FROM reviews WHERE id=review_files.review_id AND viewed_sync_head=? AND viewed_sync_base IS ?)`)
      .run(githubViewed === undefined ? null : Number(githubViewed), error ?? null, this.lookup(scope), path, head, base);
  }

  /** A failed remote read leaves file receipts and local approvals intact for the next retry. */
  failViewedSync(scope: string, error: string): void {
    this.storage.db.query("UPDATE review_files SET sync_error=? WHERE review_id=?").run(error, this.lookup(scope));
  }

  /** A write that races a push must be reconciled without importing its accidental new-head flag. */
  invalidateViewedSync(scope: string, previous: ViewedSync, head: string): void {
    this.storage.db.query("UPDATE reviews SET viewed_sync_head=?,viewed_sync_base=NULL WHERE id=? AND viewed_sync_head=? AND viewed_sync_base IS ?")
      .run(head, this.lookup(scope), previous.head, previous.base);
    this.failViewedSync(scope, "PR changed while synchronizing Viewed flags; retrying on the next refresh");
  }

  /** Read without allocating a review just to count dashboard follow-ups. */
  followUps(scope: string): FollowUp[] {
    return readFollowUps(this.storage.db, this.lookup(scope), scope.startsWith("jj/") ? "local" : "pr");
  }

  /** Flagging a hunk and marking it reviewed is one durable operation; clearing preserves progress. */
  followUpHunk(scope: string, block: ChangeIdentity, head: string, enabled: boolean): Promise<FollowUp[]> {
    return this.storage.serialize("progress", async () => this.storage.db.transaction(() => {
      const db = this.storage.db;
      const review = this.lookup(scope, true);
      const id = logicalHunk(db, review, block);
      const column = scope.startsWith("jj/") ? "local_head" : "pr_head";
      db.query(`UPDATE logical_hunks SET follow_up=?,${column}=? WHERE id=?`).run(Number(enabled), head, id);
      if (enabled) reviewHunk(db, review, block, head, new Date().toISOString());
      db.query("UPDATE reviews SET local_reconciled_head=NULL,pr_reconciled_head=NULL WHERE id=?").run(review);
      this.invalidateReconciliations(review);
      return this.followUps(scope);
    })());
  }

  /** One flag follows the whole discussion, including a locally published thread. */
  followUpThread(scope: string, thread: ThreadFollowUp, enabled: boolean): Promise<FollowUp[]> {
    return this.storage.serialize("progress", async () => this.storage.db.transaction(() => {
      flagThread(this.storage.db, this.lookup(scope, true), thread, enabled);
      return this.followUps(scope);
    })());
  }

  /** Capture before fetching a diff; all Progress instances share these in-flight generations. */
  beginHunkReconciliation(scope: string, source: "local" | "pr"): HunkReconciliation {
    const review = this.lookup(scope);
    const key = `${review}:${source}`;
    const version = (this.reconciliations.get(key) ?? 0) + 1;
    this.reconciliations.set(key, version);
    return { review, source, version };
  }

  /** Only a complete current comparison can establish presence or clear disconnected flags. */
  async reconcileFollowUps(scope: string, patch: string, head: string, source: "pr" | "local", token = this.beginHunkReconciliation(scope, source)): Promise<void> {
    const files = patch.trim() ? parsePatchFiles(patch, undefined, true).flatMap((entry) => entry.files) : [];
    if (patch.trim() && !files.length) throw new Error("Could not identify follow-up hunks from this diff");
    const semantic = splitSemanticChanges(files);
    const units = [...await identifyChanges(semantic), ...await identifyMetadata(semantic, head)];
    await this.reconcileHunks(scope, units, head, source, token);
  }

  /**
   * Advance one source without erasing presence in the other source.
   *
   * Generations protect both out-of-order fetches and same-head flag reversals. They need not survive
   * restart because in-flight fetches cannot survive it; durable heads resume reconciliation afterward.
   */
  async reconcileHunks(scope: string, blocks: (ChangeIdentity & { reviewable?: boolean })[], head: string, source: "local" | "pr", token: HunkReconciliation, base?: string): Promise<boolean> {
    return this.storage.serialize("progress", async () => this.storage.db.transaction(() => {
      const review = this.lookup(scope);
      if (!review || token.review !== review || token.source !== source || this.reconciliations.get(`${review}:${source}`) !== token.version) return false;
      const db = this.storage.db;
      const column = source === "local" ? "local_head" : "pr_head";
      // Register unapproved units too: completion must not ignore edits nobody has interacted with.
      const present = new Set<string>();
      for (const block of blocks) {
        const id = logicalHunk(db, review, block);
        present.add(id);
        if (source === "pr" && block.reviewable !== undefined) db.query("UPDATE logical_hunks SET pr_reviewable=? WHERE id=?").run(Number(block.reviewable), id);
      }
      for (const row of db.query<LogicalHunk, [string]>("SELECT * FROM logical_hunks WHERE review_id=?").all(review)) {
        db.query(`UPDATE logical_hunks SET ${column}=? WHERE id=?`).run(present.has(row.id) ? head : null, row.id);
      }
      db.query("UPDATE logical_hunks SET follow_up=0 WHERE review_id=? AND local_head IS NULL AND pr_head IS NULL").run(review);
      const cursor = source === "local" ? "local_reconciled_head" : "pr_reconciled_head";
      db.query(`UPDATE reviews SET ${cursor}=? WHERE id=?`).run(head, review);
      if (source === "pr") db.query("UPDATE reviews SET pr_reconciled_base=? WHERE id=?").run(base ?? null, review);
      return true;
    })());
  }

  /** Classification covers both sides of the complete PR comparison. */
  needsPrComparison(scope: string, head: string, base: string): boolean {
    return !this.storage.db.query("SELECT id FROM reviews WHERE id=? AND pr_reconciled_head=? AND pr_reconciled_base=?").get(this.lookup(scope), head, base);
  }

  /** Background refreshes fetch a diff only when a flagged PR needs a new head reconciled. */
  needsFollowUpDiff(scope: string, head: string): boolean {
    return Boolean(this.storage.db.query(`SELECT id FROM reviews WHERE id=? AND pr_reconciled_head IS NOT ?
      AND EXISTS (SELECT 1 FROM logical_hunks WHERE review_id=reviews.id AND follow_up=1)`).get(this.lookup(scope), head));
  }

  /** A source cursor covers every review unit, even when none is flagged or approved. */
  needsHunkReconciliation(scope: string, source: "local" | "pr", head: string): boolean {
    const column = source === "local" ? "local_reconciled_head" : "pr_reconciled_head";
    return Boolean(this.storage.db.query(`SELECT id FROM reviews WHERE id=? AND ${column} IS NOT ?`).get(this.lookup(scope), head));
  }

  /** Delete flags only after a successful complete GitHub conversation fetch; resolution keeps flags. */
  async reconcileFollowUpThreads(scope: string, existingIds: number[]): Promise<void> {
    if (!this.followUps(scope).some((item) => item.type === "thread" && item.id.startsWith("github:"))) return;
    const ids = new Set(existingIds.map((id) => `github:${id}`));
    await this.storage.serialize("progress", async () => this.storage.db.transaction(() => {
      for (const flag of this.followUps(scope)) if (flag.type === "thread" && flag.id.startsWith("github:") && !ids.has(flag.id)) {
        flagThread(this.storage.db, this.lookup(scope), flag, false);
      }
    })());
  }

  /** A later user action or review merge invalidates any earlier source snapshot. */
  private invalidateReconciliations(review: string): void {
    for (const source of ["local", "pr"]) {
      const key = `${review}:${source}`;
      this.reconciliations.set(key, (this.reconciliations.get(key) ?? 0) + 1);
    }
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
      const rows = db.query<{ id: string }, []>("SELECT id FROM reviews").all();
      const aliases = db.query<{ alias: string; review_id: string }, []>("SELECT * FROM review_aliases").all();
      const locals = db.query<{ scope: string; review_id: string }, []>("SELECT * FROM local_reviews").all();
      const state: Registry = {
        reviews: Object.fromEntries(rows.map((row) => {
          const review: ReviewRecord = reviewStore.get(row.id);
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
          const { threads, draft, draftReceipts } = review;
          if (previous.get(review.id) !== JSON.stringify(review)) reviewStore.save(review);
          if (JSON.stringify(this.threads.get(review.id)) !== JSON.stringify(threads ?? [])) this.threads.replace(review.id, threads ?? []);
          if (draft) db.query("INSERT INTO review_draft_state VALUES (?,?,?,?) ON CONFLICT(review_id) DO UPDATE SET version=excluded.version,body=excluded.body,commit_id=excluded.commit_id").run(review.id, draft.version, draft.body, draft.commitId);
          for (const receipt of draftReceipts ?? []) db.query("INSERT INTO review_draft_receipts VALUES (?,?,?) ON CONFLICT DO NOTHING").run(review.id, receipt.kind, receipt.token);
        }
        for (const row of rows) if (!state.reviews[row.id]) {
          // Unanchored imports and general conversations are not part of the diff-thread projection.
          // Move their ownership too before the retired lifetime cascades its remaining children.
          const alias = aliases.find((entry) => entry.review_id === row.id && state.aliases[entry.alias] !== row.id);
          if (alias) {
            const target = state.aliases[alias.alias];
            db.query("UPDATE review_threads SET review_id=? WHERE review_id=?").run(target, row.id);
            mergeLogicalHunks(db, row.id, target);
            mergeViewedSync(db, row.id, target);
            this.invalidateReconciliations(row.id);
            this.invalidateReconciliations(target);
          }
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
    local.threads = [...(local.threads ?? []), ...(remote.threads ?? []).filter((thread) => !local.threads?.some((entry) => entry.id === thread.id))];
    local.discussionVersion = Math.max(local.discussionVersion ?? 0, remote.discussionVersion ?? 0) + 1;
    local.commentReads = [...new Set([...(local.commentReads ?? []), ...(remote.commentReads ?? [])])];
    local.draft = remote.draft ?? local.draft;
    local.draftReceipts = [...(local.draftReceipts ?? []), ...(remote.draftReceipts ?? [])].filter((receipt, index, receipts) => receipts.findIndex((entry) => entry.kind === receipt.kind && entry.token === receipt.token) === index);
    local.commits = [...new Set([...local.commits, ...remote.commits])];
    local.prHeads = [...new Set([...(local.prHeads ?? []), ...(remote.prHeads ?? [])])];
    local.pr = remote.pr;
    for (const [alias, id] of Object.entries(state.aliases)) if (id === remote.id) state.aliases[alias] = local.id;
    delete state.reviews[remote.id];
  }
}

/** Allocate a lifetime independently of a mutable bookmark name. */
function newReview(): ReviewRecord {
  return { id: createHash("sha256").update(crypto.randomUUID()).digest("hex"), closed: false, commits: [], changes: [] };
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
