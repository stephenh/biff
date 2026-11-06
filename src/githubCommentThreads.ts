import type { Conversation, DraftComment } from "../shared/types";
import { commentReadKey, conversationActivity, isCommentResolved, relevantComments } from "../shared/commentActivity";
import type { LineThread } from "./lineComments";
import { post } from "./api";
import type { useConversation } from "./useConversation";
import { publicationPending, publicationThreadId } from "./commentPublications";

/** Group replies under their roots and give local review comments their own previews. */
export function buildThreads(conversation: Conversation | undefined, drafts: DraftComment[]): LineThread[] {
  const inline = conversation?.inline ?? [];
  const threads: LineThread[] = inline.filter((entry) => !entry.in_reply_to_id && entry.path).map((entry) => ({
    id: publicationThreadId(entry, "inline"), location: entry.biffAttachment?.matched ? entry.biffAttachment : { path: entry.path!, line: entry.line ?? entry.original_line ?? 1, side: entry.side ?? "RIGHT" }, outdated: entry.biffAttachment ? !entry.biffAttachment.matched : entry.line == null,
    needsReanchoring: Boolean(entry.biffAttachment && !entry.biffAttachment.matched),
    resolved: entry.reviewThread?.resolved, canResolve: entry.reviewThread?.canResolve, canReopen: entry.reviewThread?.canReopen,
    comments: [entry, ...inline.filter((reply) => reply.in_reply_to_id === entry.id)],
  }));
  // The durable draft remains recovery text, but is not a second copy of its submitted message.
  const submitted = new Map(inline.filter((comment) => comment.publication?.draftId).map((comment) => [comment.publication!.draftId, comment.body]));
  return [...threads, ...drafts.flatMap((draft, index) => draft.id && submitted.get(draft.id) === draft.body ? [] : [{ id: `draft-${index}`, location: draft, draftIndex: index, outdated: draft.needsReanchoring, needsReanchoring: draft.needsReanchoring, comments: [{ id: -index - 1, body: draft.body, user: { login: "You (draft)" }, html_url: "" }] }])];
}

/** Keep unread eligibility identical to the dashboard, including non-inline feedback. */
export function buildDiscussionThreads(conversation: Conversation | undefined, inline: LineThread[], author: string): LineThread[] {
  if (!conversation) return inline;
  const relevant = conversation.viewer ? new Set(relevantComments(conversationActivity(conversation), conversation.viewer, author).map(commentReadKey)) : undefined;
  // GitHub issue comments are independent top-level messages, not replies to the first comment.
  const general: LineThread[] = conversation.comments.map((comment) => ({ ...generalDiscussionThread(), id: publicationThreadId(comment, "general"), comments: [comment], readKeys: publicationPending(comment) ? [] : [`general:${comment.id}`], resolved: isCommentResolved(comment), canResolve: !publicationPending(comment), canReopen: !publicationPending(comment) }));
  const reviews: LineThread[] = conversation.reviews.filter((review) => review.state !== "PENDING" && review.body?.trim()).map((review) => ({ id: `review:${review.id}`, kind: "review", location: { path: "Review summaries", line: 1, side: "RIGHT" }, comments: [review], readKeys: [`review:${review.id}`] }));
  return [...inline, ...general, ...reviews].map((thread) => {
    // These are the viewer's own submissions, even before GitHub returns the author's login.
    const submittedKeys = new Set(thread.comments.filter((comment) => comment.publication).map((comment) => `${thread.kind ?? "github"}:${comment.id}`));
    return { ...thread,
      comments: thread.comments.map((comment) => ({ ...comment, readKey: `${thread.kind ?? "github"}:${comment.id}`, own: !publicationPending(comment) && Boolean(comment.publication || conversation.viewer && conversation.viewer.toLowerCase() === comment.user.login.toLowerCase()) })),
      readKeys: (thread.readKeys ?? thread.comments.map((comment) => `github:${comment.id}`)).filter((key) => (!relevant || relevant.has(key)) && !submittedKeys.has(key)),
    };
  });
}

/** Supply the shared location and a stable composer for a new top-level PR comment. */
export function generalDiscussionThread(): LineThread {
  return { id: "general", kind: "general", location: { path: "PR discussion", line: 1, side: "RIGHT" }, comments: [], readKeys: [] };
}

/** Acknowledge resolution before refreshing permissions, so a refresh failure is not a failed write. */
export async function saveThreadResolution(endpoint: string, conversation: ReturnType<typeof useConversation>, id: string, resolved: boolean, keys?: string[], complete = false) {
  if (id.startsWith("general:")) {
    const comment = conversation.data?.comments.find((comment) => publicationThreadId(comment, "general") === id);
    if (!comment) throw new Error("This PR comment is no longer available.");
    const result = await post<{ resolved: boolean; version?: number }>(`${endpoint}/comment-resolution`, { id: comment.id, resolved });
    conversation.setData((current) => current && { ...current, version: result.version ?? current.version, comments: current.comments.map((entry) => entry.id === comment.id ? { ...entry, biffResolved: result.resolved } : entry) });
    return;
  }
  const target = conversation.data?.inline.find((comment) => publicationThreadId(comment, "inline") === id)?.reviewThread;
  if (!target) throw new Error("This GitHub thread cannot be resolved.");
  const result = await post<Conversation>(`${endpoint}/thread`, { id: target.id, resolved, keys, ...(complete ? { action: "complete" } : {}) });
  conversation.setData((current) => {
    if (!current) return result;
    // Different threads save independently; one response must not undo another acknowledgement.
    const changed = new Map(result.inline.filter((comment) => comment.reviewThread?.id === target.id).map((comment) => [comment.id, comment]));
    return { ...current, version: Math.max(current.version ?? 0, result.version ?? 0), commentReads: [...new Set([...(current.commentReads ?? []), ...(result.commentReads ?? [])])], inline: current.inline.map((comment) => changed.get(comment.id) ?? comment) };
  });
}
