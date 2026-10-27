import type { Database } from "bun:sqlite";
import type { ReviewMessage, ReviewThread } from "../shared/localReview";
import type { CommentHunkAnchor } from "../shared/types";
import { logicalHunk } from "./logicalHunks";
import type { Storage } from "./storage";
import type { Discussion } from "../shared/discussion";
import { isDeepStrictEqual } from "node:util";
import { addCommentReads, ensureReview, findReview, newReviewId, ReviewStore } from "./reviewStore";
import { readDraftState, draftIntent } from "./reviewDrafts";

const listeners = new WeakMap<Storage, Set<() => void>>();
const publications = new WeakMap<Storage, Map<string, Promise<void>>>();

interface ThreadRow { id: string; kind: ReviewThread["kind"] | null; discarded: number; resolved: number; human_sequence: number; forked_from: string | null }
interface AnchorRow { id: number; hunk_id: string | null; path: string; side: "LEFT" | "RIGHT"; line: number; end_line: number; commit_id: string; base_commit_id: string | null; excerpt: string; file_hash: string | null; old_path: string | null; line_offset: number | null; selected_text: string | null; selected_line_count: number | null; hunk_old_line: number | null; hunk_new_line: number | null; hunk_duplicate: number | null }
interface HunkRow { id: string; path: string; hash: string; old_line: number; new_line: number; duplicate: number }
interface MessageRow { id: string; author: ReviewMessage["author"]; login: string | null; body: string; created_at: string; sequence: number; publication_pending: number; github_pr: string | null; github_id: number | null; github_url: string | null; published_at: string | null; body_known: number }
interface AttachmentRow { path: string; side: "LEFT" | "RIGHT"; line: number; end_line: number; commit_id: string; base_commit_id: string; matched: number }

/** Relational discussion storage keeps thread identity independent of snapshots and publication. */
export class DiscussionThreads {
  constructor(private db: Database) {}

  /** Reconstruct the existing discussion contract without exposing SQLite representation to callers. */
  get(review: string): ReviewThread[] {
    // This API serves anchored diff discussions. General conversations and metadata-only imports
    // live in the same tables but must not be interpreted as line comments or editable drafts.
    // A follow-up can also retain anchor evidence while its message awaits hydration.
    return this.db.query<ThreadRow, [string]>(`SELECT * FROM review_threads WHERE review_id=? AND EXISTS (SELECT 1 FROM thread_anchors WHERE thread_id=review_threads.id)
      AND EXISTS (SELECT 1 FROM review_messages WHERE thread_id=review_threads.id AND body_known=1) ORDER BY rowid`).all(review).map((row) => readThread(this.db, row));
  }

  /**
   * Keep original evidence as history when a person explicitly chooses a different anchor.
   *
   * A logical hunk can be shared, but each anchor retains its own duplicate-disambiguation coordinates and selected range.
   */
  save(review: string, thread: ReviewThread) {
    this.db.query(`INSERT INTO review_threads (id,review_id,kind,discarded,resolved,human_sequence,forked_from) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET review_id=excluded.review_id,kind=excluded.kind,discarded=excluded.discarded,resolved=excluded.resolved,human_sequence=excluded.human_sequence,forked_from=excluded.forked_from`)
      .run(thread.id, review, thread.kind ?? null, Number(Boolean(thread.discarded)), Number(thread.resolved), thread.humanSequence, thread.forkedFrom ?? null);
    const latest = this.db.query<AnchorRow, [string]>("SELECT * FROM thread_anchors WHERE thread_id=? ORDER BY id DESC LIMIT 1").get(thread.id);
    const anchor = thread.anchor;
    if (!latest || latest.path !== anchor.path || latest.side !== anchor.side || latest.line !== anchor.line || latest.end_line !== anchor.endLine || latest.commit_id !== anchor.commitId || latest.base_commit_id !== (anchor.baseCommitId ?? null)) {
      this.db.query(`INSERT INTO thread_anchors (thread_id,hunk_id,path,side,line,end_line,commit_id,base_commit_id,excerpt,file_hash,old_path,line_offset,selected_text,selected_line_count,hunk_old_line,hunk_new_line,hunk_duplicate)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(thread.id, this.hunk(review, thread.hunk), anchor.path, anchor.side, anchor.line, anchor.endLine, anchor.commitId, anchor.baseCommitId ?? null, anchor.excerpt, anchor.fileHash ?? null, anchor.oldPath ?? null, thread.hunk?.offset ?? null, thread.hunk?.text ?? null, thread.hunk?.lineCount ?? null, thread.hunk?.change.oldLine ?? null, thread.hunk?.change.newLine ?? null, thread.hunk ? Number(thread.hunk.change.duplicate) : null);
    } else if (!latest.hunk_id && thread.hunk) {
      this.db.query("UPDATE thread_anchors SET hunk_id=?,line_offset=?,selected_text=?,selected_line_count=?,hunk_old_line=?,hunk_new_line=?,hunk_duplicate=? WHERE id=?").run(this.hunk(review, thread.hunk), thread.hunk.offset, thread.hunk.text, thread.hunk.lineCount ?? null, thread.hunk.change.oldLine, thread.hunk.change.newLine, Number(thread.hunk.change.duplicate), latest.id);
    }
    if (thread.attachment) {
      const value = thread.attachment;
      this.db.query(`INSERT INTO thread_attachments (thread_id,path,side,line,end_line,commit_id,base_commit_id,matched) VALUES (?,?,?,?,?,?,?,?)
        ON CONFLICT(thread_id) DO UPDATE SET path=excluded.path,side=excluded.side,line=excluded.line,end_line=excluded.end_line,commit_id=excluded.commit_id,base_commit_id=excluded.base_commit_id,matched=excluded.matched`)
        .run(thread.id, value.path, value.side, value.line, value.endLine, value.commitId, value.baseCommitId, Number(value.matched));
    } else this.db.query("DELETE FROM thread_attachments WHERE thread_id=?").run(thread.id);
    const messages = new Set(thread.messages.map((message) => message.id));
    for (const row of this.db.query<{ id: string; body_known: number }, [string]>("SELECT * FROM review_messages WHERE thread_id=?").all(thread.id)) {
      // Metadata-only imports are not editable message text and must survive unrelated draft saves.
      if (row.body_known !== 0 && !messages.has(row.id)) this.db.query("DELETE FROM review_messages WHERE id=?").run(row.id);
    }
    for (const message of thread.messages) this.db.query(`INSERT INTO review_messages (id,thread_id,author,login,body,created_at,sequence,publication_pending,github_pr,github_id,github_url,published_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET thread_id=excluded.thread_id,author=excluded.author,login=excluded.login,body=excluded.body,sequence=excluded.sequence,
      publication_pending=excluded.publication_pending,github_pr=excluded.github_pr,github_id=excluded.github_id,github_url=excluded.github_url,published_at=excluded.published_at,body_known=1`)
      .run(message.id, thread.id, message.author, message.login ?? null, message.body, message.createdAt, message.sequence, Number(Boolean(message.publicationPending)), message.published?.pr ?? null, message.published?.id ?? null, message.published?.url ?? null, message.published?.publishedAt ?? null);
  }

  /** Unique edits share a logical hunk across moves; duplicate edits retain position-dependent identity. */
  private hunk(review: string, anchor: CommentHunkAnchor | undefined): string | null {
    if (!anchor) return null;
    return logicalHunk(this.db, review, anchor.change);
  }
}

/** Read only one review's discussion, preserving its shared local/PR identity. */
export function readDiscussion(storage: Storage, scope: string): Promise<Discussion> {
  return storage.serialize("review", async () => storage.db.transaction(() => {
    const identity = ensureReview(storage.db, scope);
    const row = storage.db.query<{ discussion_version: number }, [string]>("SELECT discussion_version FROM reviews WHERE id=?").get(identity.id)!;
    return { identity, version: row.discussion_version, threads: new DiscussionThreads(storage.db).get(identity.id), commentReads: new ReviewStore(storage.db).reads(identity.id) };
  })());
}

/**
 * Serialize discussion edits while completing network work outside the SQLite transaction.
 *
 * Only changed threads and read receipts are written. A failed callback never commits a partial
 * discussion or newly allocated lifetime; identity linking uses the same admission queue.
 */
export async function updateDiscussion(storage: Storage, scope: string, change: (discussion: Discussion) => void | Promise<void>): Promise<Discussion> {
  let changed = false;
  const result = await storage.serialize("review", async () => {
    const db = storage.db;
    const identity = findReview(db, scope) ?? { id: newReviewId(), closed: false };
    const row = db.query<{ discussion_version: number }, [string]>("SELECT discussion_version FROM reviews WHERE id=?").get(identity.id);
    const before = new DiscussionThreads(db).get(identity.id);
    const reads = new ReviewStore(db).reads(identity.id);
    const draft = readDraftState(db, identity.id);
    const discussion: Discussion = { identity, version: row?.discussion_version ?? 0, threads: structuredClone(before), commentReads: [...reads] };
    await change(discussion);
    discussion.commentReads = [...new Set(discussion.commentReads ?? [])];
    changed = !isDeepStrictEqual(before, discussion.threads) || !isDeepStrictEqual(reads, discussion.commentReads);
    db.transaction(() => {
      const saved = ensureReview(db, scope, identity.id);
      if (saved.id !== identity.id) throw new Error("This review changed while saving. Retry your changes.");
      saveThreadChanges(db, identity.id, before, discussion.threads);
      const nextReads = new Set(discussion.commentReads);
      for (const key of reads) if (!nextReads.has(key)) db.query("DELETE FROM review_comment_reads WHERE review_id=? AND receipt_key=?").run(identity.id, key);
      addCommentReads(db, identity.id, [...nextReads].filter((key) => !reads.includes(key)));
      if (draft && draftIntent(before, draft) !== draftIntent(discussion.threads, draft)) {
        db.query("UPDATE review_draft_state SET version=version+1 WHERE review_id=?").run(identity.id);
      }
      if (changed) {
        db.query("UPDATE reviews SET discussion_version=discussion_version+1 WHERE id=?").run(identity.id);
        discussion.version++;
      }
    })();
    return discussion;
  });
  if (changed) notifyDiscussion(storage);
  return result;
}

/** Persist changed anchored threads only; unanchored imports and general conversations stay untouched. */
export function saveThreadChanges(db: Database, review: string, before: ReviewThread[], after: ReviewThread[]): void {
  const previous = new Map(before.map((thread) => [thread.id, thread]));
  const retained = new Set(after.map((thread) => thread.id));
  for (const thread of before) if (!retained.has(thread.id)) db.query("DELETE FROM review_threads WHERE id=? AND review_id=?").run(thread.id, review);
  const store = new DiscussionThreads(db);
  for (const thread of after) if (!isDeepStrictEqual(previous.get(thread.id), thread)) store.save(review, thread);
}

/** Wake attached agents and browser streams only after durable discussion writes. */
export function notifyDiscussion(storage: Storage): void {
  for (const listener of listeners.get(storage) ?? []) listener();
}

/** All callers sharing a database receive the same committed discussion notifications. */
export function subscribeDiscussion(storage: Storage, listener: () => void): () => void {
  let subscribers = listeners.get(storage);
  if (!subscribers) { subscribers = new Set(); listeners.set(storage, subscribers); }
  subscribers.add(listener);
  return () => { subscribers.delete(listener); };
}

/**
 * Publish captured pending messages without holding the discussion write queue during GitHub calls.
 *
 * Thread publication is serialized across callers. Replies saved in flight remain local and are never
 * silently added to the captured outgoing batch; successful partial receipts survive failed writes.
 */
export function publishDiscussion(storage: Storage, scope: string, threadId: string, publish: (thread: ReviewThread, pr: string) => Promise<void>): Promise<Discussion> {
  let pending = publications.get(storage);
  if (!pending) { pending = new Map(); publications.set(storage, pending); }
  const previous = pending.get(threadId) ?? Promise.resolve();
  const result = previous.then(async () => {
    const snapshot = await updateDiscussion(storage, scope, (discussion) => {
      if (!discussion.identity.pr) throw new Error("Open the matching PR in Biff before publishing.");
      const thread = discussion.threads.find((entry) => entry.id === threadId);
      if (!thread) throw new Error("Comment thread not found");
      for (const message of thread.messages) if (!message.published) message.publicationPending = true;
    });
    const sent = snapshot.threads.find((entry) => entry.id === threadId)!;
    let publicationError: string | undefined;
    try { await publish(sent, snapshot.identity.pr!); }
    catch (error) { publicationError = error instanceof Error ? error.message : String(error); }
    const saved = await updateDiscussion(storage, scope, (discussion) => {
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
  pending.set(threadId, settled);
  void settled.then(() => { if (pending.get(threadId) === settled) pending.delete(threadId); });
  return result;
}

/**
 * Project stable thread/message identity together with the latest chosen anchor and current attachment.
 *
 * Anchor evidence keeps its own duplicate coordinates even when another thread shares the logical hunk.
 */
function readThread(db: Database, row: ThreadRow): ReviewThread {
  const anchor = db.query<AnchorRow, [string]>("SELECT * FROM thread_anchors WHERE thread_id=? ORDER BY id DESC LIMIT 1").get(row.id)!;
  const hunk = anchor.hunk_id ? db.query<HunkRow, [string]>("SELECT * FROM logical_hunks WHERE id=?").get(anchor.hunk_id) : undefined;
  const attachment = db.query<AttachmentRow, [string]>("SELECT * FROM thread_attachments WHERE thread_id=?").get(row.id);

  return {
    id: row.id, ...(row.kind ? { kind: row.kind } : {}), ...(row.discarded ? { discarded: true } : {}), resolved: Boolean(row.resolved), humanSequence: row.human_sequence,
    ...(row.forked_from ? { forkedFrom: row.forked_from } : {}),
    anchor: { path: anchor.path, side: anchor.side, line: anchor.line, endLine: anchor.end_line, commitId: anchor.commit_id, excerpt: anchor.excerpt,
      ...(anchor.base_commit_id ? { baseCommitId: anchor.base_commit_id } : {}), ...(anchor.file_hash ? { fileHash: anchor.file_hash } : {}), ...(anchor.old_path ? { oldPath: anchor.old_path } : {}) },
    ...(hunk ? { hunk: { change: { path: hunk.path, hash: hunk.hash, oldLine: anchor.hunk_old_line!, newLine: anchor.hunk_new_line!, duplicate: Boolean(anchor.hunk_duplicate) }, offset: anchor.line_offset!, text: anchor.selected_text!, ...(anchor.selected_line_count && anchor.selected_line_count > 1 ? { lineCount: anchor.selected_line_count } : {}) } } : {}),
    ...(attachment ? { attachment: { path: attachment.path, side: attachment.side, line: attachment.line, endLine: attachment.end_line, commitId: attachment.commit_id, baseCommitId: attachment.base_commit_id, matched: Boolean(attachment.matched) } } : {}),
    messages: db.query<MessageRow, [string]>("SELECT * FROM review_messages WHERE thread_id=? ORDER BY sequence").all(row.id).filter((message) => message.body_known !== 0).map(messageFromRow),
  };
}

/** Publication receipts belong to the message, never to its current attachment. */
function messageFromRow(row: MessageRow): ReviewMessage {
  return { id: row.id, author: row.author, body: row.body, createdAt: row.created_at, sequence: row.sequence,
    ...(row.login ? { login: row.login } : {}), ...(row.publication_pending ? { publicationPending: true } : {}),
    ...(row.github_id !== null ? { published: { pr: row.github_pr!, id: row.github_id, url: row.github_url!, publishedAt: row.published_at! } } : {}),
  };
}
