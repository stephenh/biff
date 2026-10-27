import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { Storage } from "./storage";
import type { DraftComment, ReviewDraft } from "../shared/types";
import type { ReviewThread } from "../shared/localReview";
import { ensureReview } from "./reviewStore";
import { DiscussionThreads, saveThreadChanges, notifyDiscussion } from "./discussionThreads";

interface DraftState { version: number; body: string; commitId: string }

/** Read only the summary and edit version belonging to this review. */
export function readDraftState(db: Database, review: string): DraftState | undefined {
  const row = db.query<{ version: number; body: string; commit_id: string }, [string]>("SELECT version,body,commit_id FROM review_draft_state WHERE review_id=?").get(review);
  return row ? { version: row.version, body: row.body, commitId: row.commit_id } : undefined;
}

/** Review comments remain canonical threads; summary state belongs to the review, not its head. */
export function readReviewDraft(storage: Storage, scope: string): Promise<ReviewDraft> {
  return storage.serialize("review", async () => storage.db.transaction(() => {
    const review = ensureReview(storage.db, scope).id;
    const comparison = storage.db.query<{ head: string; base: string }, [string]>("SELECT head,base FROM thread_comparisons WHERE review_id=?").get(review);
    return { ...draftOf(new DiscussionThreads(storage.db).get(review), readDraftState(storage.db, review)),
      ...(comparison ? { currentHead: comparison.head, currentBase: comparison.base } : {}) };
  })());
}

/**
 * Reject stale draft versions while retaining idempotent imports and already published comments.
 *
 * Import receipts and thread tombstones prevent an older browser from resurrecting submitted text.
 */
export async function saveReviewDraft(storage: Storage, scope: string, draft: ReviewDraft, incoming: ReviewThread[], importing = false): Promise<ReviewDraft> {
  let changed = false;
  const result = await storage.serialize("review", async () => storage.db.transaction(() => {
    const db = storage.db;
    const review = ensureReview(db, scope).id;
    const current = readDraftState(db, review) ?? { version: 0, body: "", commitId: draft.commitId };
    const before = new DiscussionThreads(db).get(review);
    const threads = structuredClone(before);
    const importHash = createHash("sha256").update(JSON.stringify([draft.commitId, draft.body, draft.comments.map((comment) => [comment.id, comment.body])])).digest("hex");
    if (importing && db.query("SELECT token FROM review_draft_receipts WHERE review_id=? AND kind='import' AND token=?").get(review, importHash)) return draftOf(threads, current);
    if (!importing && current.version !== draft.version) {
      const saved = draftOf(threads, current);
      if (saved.body === draft.body && saved.comments.length === draft.comments.length && saved.comments.every((comment, index) => comment.id === draft.comments[index].id && comment.body === draft.comments[index].body && !draft.comments[index].reanchor)) return saved;
      throw new Error("This review draft changed in another tab. Your text is kept in this browser; reload the draft before retrying.");
    }
    for (const thread of incoming) {
      const owner = db.query<{ review_id: string }, [string]>("SELECT review_id FROM review_threads WHERE id=?").get(thread.id);
      if (owner && owner.review_id !== review) throw new Error("This comment belongs to another review.");
      const existing = threads.find((entry) => entry.id === thread.id);
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
      } else threads.push(thread);
    }
    if (!importing) for (const thread of threads) {
      if (thread.kind === "review" && !thread.messages[0]?.published && !incoming.some((entry) => entry.id === thread.id)) thread.discarded = true;
    }
    const next = { version: current.version + 1, body: importing ? current.body || draft.body : draft.body, commitId: draft.commitId };
    saveThreadChanges(db, review, before, threads);
    db.query(`INSERT INTO review_draft_state (review_id,version,body,commit_id) VALUES (?,?,?,?)
      ON CONFLICT(review_id) DO UPDATE SET version=excluded.version,body=excluded.body,commit_id=excluded.commit_id`).run(review, next.version, next.body, next.commitId);
    if (importing) db.query("INSERT INTO review_draft_receipts (review_id,kind,token) VALUES (?,'import',?)").run(review, importHash);
    db.query("UPDATE reviews SET discussion_version=discussion_version+1 WHERE id=?").run(review);
    changed = true;
    return draftOf(threads, next);
  })());
  if (changed) notifyDiscussion(storage);
  return result;
}

/**
 * Clear only acknowledged text; edits made during publication remain unsent.
 *
 * Newer text gets a separate thread identity, and publication receipts prevent a recovered response
 * from consuming another summary typed after the original acknowledgement.
 */
export async function acknowledgeReview(storage: Storage, scope: string, sent: ReviewDraft, publicationId?: number): Promise<void> {
  let changed = false;
  await storage.serialize("review", async () => storage.db.transaction(() => {
    const db = storage.db;
    const review = ensureReview(db, scope).id;
    if (publicationId !== undefined) {
      const inserted = db.query("INSERT INTO review_draft_receipts (review_id,kind,token) VALUES (?,'publication',?) ON CONFLICT DO NOTHING").run(review, String(publicationId));
      if (!inserted.changes) return;
    }
    db.query("UPDATE review_draft_state SET body=CASE WHEN body=? THEN '' ELSE body END,version=version+1 WHERE review_id=?").run(sent.body, review);
    const before = new DiscussionThreads(db).get(review);
    const threads = structuredClone(before);
    for (const comment of sent.comments) {
      for (const pending of threads) {
        if (pending.kind === "review" && pending.forkedFrom === comment.id && !pending.messages[0]?.published && pending.messages[0]?.body === comment.body && samePublicationAnchor(pending, comment)) pending.discarded = true;
      }
      const thread = threads.find((entry) => entry.id === comment.id);
      if (!thread || thread.discarded) continue;
      if (!thread.messages[0]?.published && thread.messages[0]?.body !== comment.body) {
        const id = crypto.randomUUID();
        threads.push({ ...thread, id, forkedFrom: thread.id, kind: "review", discarded: false, messages: [{ ...thread.messages[0], id, publicationPending: undefined }] });
        thread.messages[0].body = comment.body;
      }
      thread.discarded = true;
    }
    saveThreadChanges(db, review, before, threads);
    db.query("UPDATE reviews SET discussion_version=discussion_version+1 WHERE id=?").run(review);
    changed = true;
  })());
  if (changed) notifyDiscussion(storage);
}

/** Attachment movement is not a text edit; publication and imported replies can change membership. */
export function draftIntent(threads: ReviewThread[], state: DraftState): string {
  const draft = draftOf(threads, state);
  return JSON.stringify([draft.body, draft.comments.map((comment) => [comment.id, comment.body])]);
}

/** Missing attachments remain actionable draft notes rather than disappearing. */
function draftOf(threads: ReviewThread[], state?: DraftState): ReviewDraft {
  return { version: state?.version ?? 0, body: state?.body ?? "", commitId: state?.commitId ?? "", comments: threads.filter((thread) => thread.kind === "review" && !thread.discarded && !thread.messages[0]?.published).map((thread) => {
    const location = thread.attachment?.matched ? thread.attachment : thread.anchor;
    return { id: thread.id, ...(thread.forkedFrom ? { supersedes: thread.forkedFrom } : {}), path: location.path, side: location.side, line: location.line, body: thread.messages[0].body, commitId: location.commitId, baseCommitId: location.baseCommitId,
      ...(thread.hunk ? { anchor: thread.hunk } : {}), needsReanchoring: !thread.attachment?.matched };
  }) };
}

/** Identical words moved to another hunk are a different pending comment. */
function samePublicationAnchor(thread: ReviewThread, comment: DraftComment): boolean {
  if (thread.hunk && comment.anchor) return thread.anchor.side === comment.side && thread.hunk.change.path === comment.anchor.change.path && thread.hunk.change.hash === comment.anchor.change.hash && thread.hunk.offset === comment.anchor.offset;
  const location = thread.attachment?.matched ? thread.attachment : thread.anchor;
  return location.path === comment.path && location.side === comment.side && location.line === comment.line;
}
