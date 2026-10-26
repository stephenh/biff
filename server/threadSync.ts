import { anchorComment, commentHunks, followComment, type CommentHunks } from "../shared/commentHunks";
import type { CommentAttachment, DiscussionComment, DraftComment, GitHubReview, ReviewDraft, ReviewLine } from "../shared/types";
import type { ReviewThread } from "../shared/localReview";
import type { GitHub } from "./github";
import { Progress } from "./progress";
import type { Storage } from "./storage";

/** Move Biff attachments independently of GitHub's immutable publication coordinates. */
export class ThreadSync {
  private progress: Progress;
  private running = new Map<string, Promise<void>>();
  private patches = new Map<string, Promise<CommentHunks>>();

  constructor(private storage: Storage, private github: GitHub) { this.progress = new Progress(storage); }

  /**
   * Save an exact source anchor before acknowledging a review comment, even if the PR has since moved.
   *
   * The durable write succeeds independently of attachment refresh; a failed read must not undo acknowledged text.
   */
  async saveDraft(repo: string, number: string, draft: ReviewDraft, importing = false): Promise<ReviewDraft> {
    const scope = `${repo.toLowerCase()}/${number}`;
    const threads: ReviewThread[] = [];
    for (const comment of draft.comments) {
      if (!comment.id) throw new Error("Missing review comment ID");
      const commitId = comment.commitId ?? draft.commitId;
      const baseCommitId = comment.baseCommitId;
      let anchored = comment;
      // Legacy drafts have no base evidence. Keep them recoverable instead of inventing an anchor.
      if (baseCommitId) anchored = anchorComment(await this.hunks(repo, baseCommitId, commitId), comment);
      threads.push({ id: comment.id, kind: "review", resolved: false, humanSequence: 1,
        anchor: { path: comment.path, side: comment.side, line: comment.line, endLine: comment.line, commitId, ...(baseCommitId ? { baseCommitId } : {}), excerpt: anchored.anchor?.text ?? comment.body },
        ...(anchored.anchor ? { hunk: anchored.anchor } : {}),
        messages: [{ id: comment.id, author: "user", body: comment.body, sequence: 1, createdAt: new Date().toISOString() }],
      });
    }
    await this.progress.saveReviewDraft(scope, draft, threads, importing);
    try { await this.refresh(repo, number); }
    catch (cause) { console.warn("Review draft saved; attachment refresh will retry:", cause instanceof Error ? cause.message : String(cause)); }
    return this.progress.reviewDraft(scope);
  }

  /** Queue polling and open-PR work per PR; a later head always gets a fresh pass after earlier work. */
  refresh(repo: string, number: string, review?: GitHubReview, known?: { head: string; base: string }): Promise<void> {
    const scope = `${repo.toLowerCase()}/${number}`;
    const previous = this.running.get(scope) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(() => this.sync(repo, number, review, 0, known));
    this.running.set(scope, task);
    void task.finally(() => { if (this.running.get(scope) === task) this.running.delete(scope); }).catch(() => {});
    return task;
  }

  /**
   * Import GitHub roots/replies by their remote IDs without changing existing local thread identity.
   *
   * Publication markers reconnect a lost acknowledgement. A newer local edit becomes a separate unsent draft, not published text.
   */
  async observe(repo: string, number: string, comments: DiscussionComment[], localThreadId?: string): Promise<void> {
    if (!comments.length) return;
    const scope = `${repo.toLowerCase()}/${number}`;
    await this.progress.updateDiscussion(scope, (discussion) => {
      for (const root of comments.filter((entry) => !entry.in_reply_to_id && entry.path)) {
        const marker = root.body.match(/<!-- biff:([a-f0-9-]+):([a-f0-9-]+) -->\s*$/);
        let thread = discussion.threads.find((entry) => entry.messages[0]?.published?.id === root.id);
        if (!thread) {
          const source = discussion.threads.find((entry) => marker?.[1] === entry.id || localThreadId === entry.id);
          if (source?.messages[0]?.published) {
            // Two immutable submissions can originate from one edited draft. Each
            // GitHub root keeps its own receipt and attachment instead of replacing the first.
            thread = { ...source, id: crypto.randomUUID(), kind: "github", discarded: false, forkedFrom: source.id, messages: [] };
            discussion.threads.push(thread);
          } else thread = source;
        }
        if (!thread) {
          const saved = this.storage.db.query<{ thread_id: string }, [string, number]>("SELECT thread_id FROM review_messages WHERE github_pr=? AND github_kind='inline_comment' AND github_id=?").get(scope, root.id);
          thread = { id: saved?.thread_id ?? crypto.randomUUID(), kind: "github", resolved: root.reviewThread?.resolved ?? false, humanSequence: 0,
            anchor: { path: root.path!, side: root.side ?? "RIGHT", line: root.original_line ?? root.line ?? 1, endLine: root.original_line ?? root.line ?? 1, commitId: root.original_commit_id ?? root.commit_id ?? "", excerpt: root.diff_hunk ?? root.body }, messages: [] };
          discussion.threads.push(thread);
        }
        if (root.reviewThread) thread.resolved = root.reviewThread.resolved;
        for (const comment of [root, ...comments.filter((entry) => entry.in_reply_to_id === root.id)]) {
          const publishedBody = comment.body.replace(/\n\n<!-- biff:[a-f0-9-]+:[a-f0-9-]+ -->\s*$/, "");
          let message = thread.messages.find((entry) => entry.published?.id === comment.id || comment.id === root.id && (marker?.[2] === entry.id || localThreadId === entry.id));
          const body = message?.author === "agent" && publishedBody.startsWith("**Agent:**\n\n") ? publishedBody.slice("**Agent:**\n\n".length) : publishedBody;
          if (message && !thread.discarded && !message.published && message.body !== body) {
            // A review published the earlier text while the author was editing. Keep
            // the newer text as its own unsent thread rather than acknowledging it too.
            const id = crypto.randomUUID();
            discussion.threads.push({ ...thread, id, forkedFrom: thread.id, kind: "review", discarded: false, messages: [{ ...message, id, publicationPending: undefined }] });
          }
          if (!message) {
            const saved = this.storage.db.query<{ id: string }, [string, number]>("SELECT id FROM review_messages WHERE github_pr=? AND github_kind='inline_comment' AND github_id=?").get(scope, comment.id);
            message = { id: saved?.id ?? crypto.randomUUID(), author: "user", body, createdAt: comment.created_at ?? new Date().toISOString(), sequence: Math.max(0, ...thread.messages.map((entry) => entry.sequence)) + 1 };
            thread.messages.push(message);
          }
          message.body = body; message.login = comment.user.login;
          message.published = { pr: scope, id: comment.id, url: comment.html_url, publishedAt: comment.created_at ?? new Date().toISOString() };
          delete message.publicationPending;
        }
      }
    });
    await this.refresh(repo, number);
  }

  /** Return Biff's attachment alongside GitHub's unchanged IDs, permissions, and original coordinates. */
  async attach(repo: string, number: string, comments: DiscussionComment[]): Promise<DiscussionComment[]> {
    const discussion = await this.progress.discussion(`${repo.toLowerCase()}/${number}`);
    return comments.map((comment) => {
      const thread = discussion.threads.find((entry) => entry.messages[0]?.published?.id === comment.id);
      return thread?.attachment ? { ...comment, biffAttachment: thread.attachment } : comment;
    });
  }

  /**
   * Explicitly move a published thread inside Biff without editing GitHub's original coordinates.
   *
   * The expected attachment prevents a second tab from overwriting a location it has not seen.
   */
  async reanchor(repo: string, number: string, githubId: number, location: ReviewLine, head: string, base: string, expected: CommentAttachment): Promise<CommentAttachment> {
    const current = await this.github.pullRequest(repo, number);
    if (current.head.sha !== head || current.base.sha !== base) throw new Error("The PR changed. Refresh before choosing the thread's new location.");
    const anchored = anchorComment(await this.hunks(repo, base, head), { ...location, body: "" });
    if (!anchored.anchor) throw new Error("Choose a line inside a reviewable hunk.");
    const attachment = { ...location, endLine: location.line, commitId: head, baseCommitId: base, matched: true };
    await this.progress.updateDiscussion(`${repo.toLowerCase()}/${number}`, (discussion) => {
      const thread = discussion.threads.find((entry) => entry.messages[0]?.published?.id === githubId);
      if (!thread) throw new Error("Published thread not found in this review.");
      const existing = thread.attachment;
      if (!existing || existing.path !== expected.path || existing.side !== expected.side || existing.line !== expected.line || existing.commitId !== expected.commitId || existing.baseCommitId !== expected.baseCommitId) throw new Error("This thread's attachment changed in another tab. Reload before moving it.");
      thread.anchor = { ...location, endLine: location.line, commitId: head, baseCommitId: base, excerpt: anchored.anchor!.text };
      thread.hunk = anchored.anchor;
      thread.attachment = attachment;
    });
    return attachment;
  }

  /** Translate a pinned review immediately before publication; changed or ambiguous edits remain unsent. */
  async submission(repo: string, number: string, draft: ReviewDraft, current: GitHubReview): Promise<DraftComment[]> {
    const discussion = await this.progress.discussion(`${repo.toLowerCase()}/${number}`);
    const hunks = await this.hunks(repo, current.pr.base.sha, current.pr.head.sha, current.patch);
    return draft.comments.map((comment) => {
      const thread = discussion.threads.find((entry) => entry.id === comment.id);
      const hunk = thread?.hunk ?? comment.anchor;
      const followed = hunk ? followComment(hunks, { ...comment, anchor: hunk }) : undefined;
      if (!followed) throw new Error(`Your comment on ${comment.path}:${comment.line} needs re-anchoring. It is still saved in Biff; select its new location before submitting.`);
      return { ...followed, commitId: current.pr.head.sha, baseCommitId: current.pr.base.sha, needsReanchoring: false };
    });
  }

  /**
   * Reconcile only changed comparisons, verifying the head again before committing attachment updates.
   *
   * Fingerprints exclude coordinates, but matching still requires the selected text and duplicate evidence to agree.
   */
  private async sync(repo: string, number: string, supplied?: GitHubReview, attempt = 0, known?: { head: string; base: string }): Promise<void> {
    const scope = `${repo.toLowerCase()}/${number}`;
    let discussion = await this.progress.discussion(scope);
    if (!discussion.threads.length) return;
    const previous = this.storage.db.query<{ head: string; base: string }, [string]>("SELECT head,base FROM thread_comparisons WHERE review_id=?").get(discussion.identity.id);
    // The queue already fetched both SHAs in its batched GraphQL query. Unchanged
    // comparisons need neither another metadata request nor another diff download.
    if (known && previous?.head === known.head && previous.base === known.base && attachmentsReady(discussion.threads, known.head, known.base)) return;
    const pr = supplied?.pr ?? await this.github.pullRequest(repo, number);
    if (previous?.head === pr.head.sha && previous.base === pr.base.sha && attachmentsReady(discussion.threads, pr.head.sha, pr.base.sha)) return;
    await this.progress.pullRequest(scope, [pr.head.sha], pr.state === "closed", pr.head.sha);
    discussion = await this.progress.discussion(scope);
    const current = await this.hunks(repo, pr.base.sha, pr.head.sha, supplied?.patch);
    const changes: { id: string; original: string; hunk: ReviewThread["hunk"]; attachment: NonNullable<ReviewThread["attachment"]> }[] = [];
    for (const thread of discussion.threads) {
      if (thread.discarded && !thread.messages[0]?.published) continue;
      let hunk = thread.hunk;
      if (!hunk) {
        const original = thread.anchor;
        try {
          const source = original.baseCommitId ? await this.hunks(repo, original.baseCommitId, original.commitId)
            : original.commitId === pr.head.sha ? current : original.commitId ? await this.hunks(repo, pr.base.sha, original.commitId) : undefined;
          if (source) hunk = anchorComment(source, { ...original, body: "" }, original.endLine).anchor;
        } catch { /* Keep unavailable historical anchors visible and available for manual re-anchoring. */ }
      }
      const followed = hunk ? followComment(current, { ...thread.anchor, body: "", anchor: hunk }) : undefined;
      const matched = Boolean(followed);
      changes.push({ id: thread.id, original: JSON.stringify(thread.anchor), hunk,
        attachment: { path: followed?.path ?? thread.anchor.path, side: thread.anchor.side, line: followed?.line ?? thread.anchor.line, endLine: followed ? followed.line + (hunk?.lineCount ?? 1) - 1 : thread.anchor.endLine, commitId: pr.head.sha, baseCommitId: pr.base.sha, matched } });
    }
    const latest = await this.github.pullRequest(repo, number);
    if (latest.head.sha !== pr.head.sha || latest.base.sha !== pr.base.sha) {
      if (attempt < 2) return this.sync(repo, number, undefined, attempt + 1);
      throw new Error("The PR kept changing during attachment sync. Your comments are saved; refresh to retry.");
    }
    await this.progress.updateDiscussion(scope, (value) => {
      for (const change of changes) {
        const thread = value.threads.find((entry) => entry.id === change.id);
        if (!thread || JSON.stringify(thread.anchor) !== change.original) continue;
        thread.hunk ??= change.hunk;
        thread.attachment = change.attachment;
      }
    });
    this.storage.db.query("INSERT INTO thread_comparisons VALUES (?,?,?) ON CONFLICT(review_id) DO UPDATE SET head=excluded.head,base=excluded.base").run(discussion.identity.id, pr.head.sha, pr.base.sha);
  }

  /** Cache immutable comparisons, not mutable PR metadata; failed reads remain retryable. */
  private hunks(repo: string, base: string, head: string, patch?: string): Promise<CommentHunks> {
    const key = `${repo.toLowerCase()}:${base}:${head}`;
    let pending = this.patches.get(key);
    if (!pending) {
      pending = (patch === undefined ? this.github.patch(repo, base, head) : Promise.resolve(patch)).then(commentHunks);
      this.patches.set(key, pending);
      void pending.catch(() => this.patches.delete(key));
      // Comparisons are immutable, but a long-running service should not retain every historical diff.
      if (this.patches.size > 30) this.patches.delete(this.patches.keys().next().value!);
    }
    return pending;
  }
}

/** Unmatched attachments are also a completed sync result; they remain visible without repeated diff downloads. */
function attachmentsReady(threads: ReviewThread[], head: string, base: string): boolean {
  return threads.every((thread) => thread.discarded && !thread.messages[0]?.published || thread.attachment?.commitId === head && thread.attachment.baseCommitId === base);
}
