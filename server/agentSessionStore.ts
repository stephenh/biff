import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { ReviewSession, ReviewThread } from "../shared/localReview";
import { DiscussionThreads } from "./discussionThreads";
import { acceptSnapshot, readSnapshot } from "./reviewSnapshots";
import { ensureReview, ReviewStore } from "./reviewStore";

interface SessionRow {
  id: string; agent_session: string; snapshot_id: string; review_id: string; discussion_scope: string;
  sequence: number; human_sequence: number; acknowledged: number; updated_at: string; finished: number; finished_threads: string | null;
}
export interface MessageDelivery { message_id: string; sequence: number; body_hash: string }
export interface ThreadDelivery { thread_id: string; human_sequence: number; fingerprint: string }

/** Reconstruct the protocol view from canonical comments and this agent's delivery cursors. */
export function readAgentSession(db: Database, id: string): ReviewSession {
  const row = db.query<SessionRow, [string]>("SELECT * FROM agent_sessions WHERE id=?").get(id);
  if (!row) throw new Error("Review session not found");
  const threads = row.finished_threads ? JSON.parse(row.finished_threads) as ReviewThread[] : sessionThreads(db, row.review_id);
  if (!row.finished_threads) {
    const messages = new Map(messageDeliveries(db, id).map((entry) => [entry.message_id, entry.sequence]));
    const deliveries = new Map(threadDeliveries(db, id).map((entry) => [entry.thread_id, entry.human_sequence]));
    for (const thread of threads) {
      thread.humanSequence = deliveries.get(thread.id) ?? 0;
      for (const message of thread.messages) message.sequence = messages.get(message.id) ?? 0;
    }
  }
  return { version: 1, id, agentSession: row.agent_session, snapshot: readSnapshot(db, row.snapshot_id),
    discussionScope: row.discussion_scope, sequence: row.sequence, humanSequence: row.human_sequence,
    acknowledged: row.acknowledged, updatedAt: row.updated_at, finished: Boolean(row.finished), threads,
    commentReads: new ReviewStore(db).reads(row.review_id) };
}

/**
 * Commit session counters and delivery observations together, without copying live discussions.
 *
 * Finished sessions retain a frozen view, as before; later comments in the shared review must not
 * change an ended agent conversation. Only that historical view contains archived message bodies.
 */
export function saveAgentSession(db: Database, review: ReviewSession): void {
  db.transaction(() => {
    review.snapshot = acceptSnapshot(db, review.snapshot);
    const identity = ensureReview(db, review.discussionScope!);
    db.query(`INSERT INTO agent_sessions (id,workspace_id,agent_session,snapshot_id,review_id,discussion_scope,
      sequence,human_sequence,acknowledged,updated_at,finished,finished_threads) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET snapshot_id=excluded.snapshot_id,review_id=excluded.review_id,discussion_scope=excluded.discussion_scope,
      sequence=excluded.sequence,human_sequence=excluded.human_sequence,acknowledged=excluded.acknowledged,
      updated_at=excluded.updated_at,finished=excluded.finished,finished_threads=excluded.finished_threads`)
      .run(review.id, review.snapshot.workspace.id, review.agentSession, review.snapshot.snapshotId!, identity.id, review.discussionScope!,
        review.sequence, review.humanSequence, review.acknowledged, review.updatedAt, Number(review.finished), review.finished ? JSON.stringify(review.threads) : null);
    const threadIds = new Set(review.threads.map((thread) => thread.id));
    const messageIds = new Set(review.threads.flatMap((thread) => thread.messages.map((message) => message.id)));
    for (const previous of threadDeliveries(db, review.id)) if (!threadIds.has(previous.thread_id)) db.query("DELETE FROM agent_session_threads WHERE session_id=? AND thread_id=?").run(review.id, previous.thread_id);
    for (const previous of messageDeliveries(db, review.id)) if (!messageIds.has(previous.message_id)) db.query("DELETE FROM agent_session_messages WHERE session_id=? AND message_id=?").run(review.id, previous.message_id);
    for (const thread of review.threads) {
      db.query(`INSERT INTO agent_session_threads (session_id,thread_id,human_sequence,fingerprint) VALUES (?,?,?,?)
        ON CONFLICT(session_id,thread_id) DO UPDATE SET human_sequence=excluded.human_sequence,fingerprint=excluded.fingerprint
        WHERE human_sequence!=excluded.human_sequence OR fingerprint!=excluded.fingerprint`).run(review.id, thread.id, thread.humanSequence, threadFingerprint(thread));
      for (const message of thread.messages) db.query(`INSERT INTO agent_session_messages (session_id,message_id,sequence,body_hash) VALUES (?,?,?,?)
        ON CONFLICT(session_id,message_id) DO UPDATE SET sequence=excluded.sequence,body_hash=excluded.body_hash
        WHERE sequence!=excluded.sequence OR body_hash!=excluded.body_hash`).run(review.id, message.id, message.sequence, bodyHash(message.body));
    }
  })();
}

/** Observations outlive deleted messages until the agent session has recorded their removal. */
export function messageDeliveries(db: Database, session: string): MessageDelivery[] {
  return db.query<MessageDelivery, [string]>("SELECT message_id,sequence,body_hash FROM agent_session_messages WHERE session_id=?").all(session);
}

/** Track structural changes separately from user-message delivery. */
export function threadDeliveries(db: Database, session: string): ThreadDelivery[] {
  return db.query<ThreadDelivery, [string]>("SELECT thread_id,human_sequence,fingerprint FROM agent_session_threads WHERE session_id=?").all(session);
}

/** Hash only text to detect edits without retaining a competing message body. */
export function bodyHash(body: string): string { return createHash("sha256").update(body).digest("hex"); }

/** Delivery counters are session-specific and must not be part of shared thread change detection. */
export function threadFingerprint(thread: ReviewThread): string {
  return bodyHash(JSON.stringify({ ...thread, humanSequence: 0, messages: thread.messages.map((message) => ({ ...message, sequence: 0 })) }, sortedProperties));
}

/** SQLite reconstruction and API objects can enumerate the same fields in different orders. */
function sortedProperties(_key: string, value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
}

/** Agent feedback excludes review drafts and imported GitHub-only threads. */
function sessionThreads(db: Database, review: string): ReviewThread[] {
  return new DiscussionThreads(db).get(review).filter((thread) => !thread.kind && !thread.discarded);
}
