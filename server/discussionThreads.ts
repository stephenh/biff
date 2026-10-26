import type { Database } from "bun:sqlite";
import type { ReviewMessage, ReviewThread } from "../shared/localReview";
import type { CommentHunkAnchor } from "../shared/types";
import { matchesChange } from "../shared/progress";

interface ThreadRow { id: string; kind: ReviewThread["kind"] | null; discarded: number; resolved: number; human_sequence: number; forked_from: string | null }
interface AnchorRow { id: number; hunk_id: string | null; path: string; side: "LEFT" | "RIGHT"; line: number; end_line: number; commit_id: string; base_commit_id: string | null; excerpt: string; file_hash: string | null; old_path: string | null; line_offset: number | null; selected_text: string | null; selected_line_count: number | null; hunk_old_line: number | null; hunk_new_line: number | null; hunk_duplicate: number | null }
interface HunkRow { id: string; path: string; hash: string; old_line: number; new_line: number; duplicate: number }
interface MessageRow { id: string; author: ReviewMessage["author"]; login: string | null; body: string; created_at: string; sequence: number; publication_pending: number; github_pr: string | null; github_id: number | null; github_url: string | null; published_at: string | null }
interface AttachmentRow { path: string; side: "LEFT" | "RIGHT"; line: number; end_line: number; commit_id: string; base_commit_id: string; matched: number }

/** Relational discussion storage keeps thread identity independent of snapshots and publication. */
export class DiscussionThreads {
  constructor(private db: Database) {}

  /** Reconstruct the existing discussion contract without exposing SQLite representation to callers. */
  get(review: string): ReviewThread[] {
    return this.db.query<ThreadRow, [string]>("SELECT * FROM review_threads WHERE review_id=? ORDER BY rowid").all(review).map((row) => readThread(this.db, row));
  }

  /** The review registry owns the transaction, including alias merges and explicit deletions. */
  replace(review: string, threads: ReviewThread[]) {
    const retained = new Set(threads.map((thread) => thread.id));
    for (const row of this.db.query<{ id: string }, [string]>("SELECT id FROM review_threads WHERE review_id=?").all(review)) {
      if (!retained.has(row.id)) this.db.query("DELETE FROM review_threads WHERE id=?").run(row.id);
    }
    for (const thread of threads) this.save(review, thread);
  }

  /**
   * Keep original evidence as history when a person explicitly chooses a different anchor.
   *
   * A logical hunk can be shared, but each anchor retains its own duplicate-disambiguation coordinates and selected range.
   */
  private save(review: string, thread: ReviewThread) {
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
    for (const row of this.db.query<{ id: string }, [string]>("SELECT id FROM review_messages WHERE thread_id=?").all(thread.id)) if (!messages.has(row.id)) this.db.query("DELETE FROM review_messages WHERE id=?").run(row.id);
    for (const message of thread.messages) this.db.query(`INSERT INTO review_messages (id,thread_id,author,login,body,created_at,sequence,publication_pending,github_pr,github_id,github_url,published_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET thread_id=excluded.thread_id,author=excluded.author,login=excluded.login,body=excluded.body,sequence=excluded.sequence,
      publication_pending=excluded.publication_pending,github_pr=excluded.github_pr,github_id=excluded.github_id,github_url=excluded.github_url,published_at=excluded.published_at`)
      .run(message.id, thread.id, message.author, message.login ?? null, message.body, message.createdAt, message.sequence, Number(Boolean(message.publicationPending)), message.published?.pr ?? null, message.published?.id ?? null, message.published?.url ?? null, message.published?.publishedAt ?? null);
  }

  /** Unique edits share a logical hunk across moves; duplicate edits retain position-dependent identity. */
  private hunk(review: string, anchor: CommentHunkAnchor | undefined): string | null {
    if (!anchor) return null;
    const change = anchor.change;
    const candidates = this.db.query<HunkRow, [string, string, string]>("SELECT * FROM logical_hunks WHERE review_id=? AND path=? AND hash=?").all(review, change.path, change.hash);
    const existing = candidates.find((row) => matchesChange({ path: row.path, hash: row.hash, oldLine: row.old_line, newLine: row.new_line, duplicate: Boolean(row.duplicate) }, change));
    if (existing) return existing.id;
    const id = crypto.randomUUID();
    this.db.query("INSERT INTO logical_hunks (id,review_id,path,hash,old_line,new_line,duplicate) VALUES (?,?,?,?,?,?,?)").run(id, review, change.path, change.hash, change.oldLine, change.newLine, Number(change.duplicate));
    return id;
  }
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
    messages: db.query<MessageRow, [string]>("SELECT * FROM review_messages WHERE thread_id=? ORDER BY sequence").all(row.id).map(messageFromRow),
  };
}

/** Publication receipts belong to the message, never to its current attachment. */
function messageFromRow(row: MessageRow): ReviewMessage {
  return { id: row.id, author: row.author, body: row.body, createdAt: row.created_at, sequence: row.sequence,
    ...(row.login ? { login: row.login } : {}), ...(row.publication_pending ? { publicationPending: true } : {}),
    ...(row.github_id !== null ? { published: { pr: row.github_pr!, id: row.github_id, url: row.github_url!, publishedAt: row.published_at! } } : {}),
  };
}
