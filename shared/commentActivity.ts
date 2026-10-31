import type { Activity } from "./inbox";
import type { Conversation, DiscussionComment } from "./types";

/** Use the same message identities in dashboard snapshots and every discussion view. */
export function commentReadKey(event: Activity): string {
  return event.key.replace(/^inline:/, "github:");
}

/** General comments form one conversation; review summaries have no reply API. */
export function conversationActivity(conversation: Conversation): Activity[] {
  return [
    ...conversation.comments.map((comment) => ({ key: `general:${comment.id}`, thread: "general", actor: comment.user.login, at: comment.created_at || "", kind: "reply" as const })),
    ...conversation.inline.map((comment) => ({ key: `inline:${comment.id}`, thread: `inline:${comment.in_reply_to_id ?? comment.id}`, actor: comment.user.login, at: comment.created_at || "", kind: "reply" as const })),
    ...conversation.reviews.filter((review) => review.state !== "PENDING").map((review) => ({ key: `review:${review.id}`, actor: review.user.login, at: review.submitted_at || "", kind: "review" as const, hasBody: Boolean(review.body?.trim()) })),
  ];
}

/** Authors read all feedback; reviewers read replies to conversations they joined. */
export function relevantComments(events: Activity[], viewer: string, author: string): Activity[] {
  const login = viewer.toLowerCase();
  const participated = new Set(events.filter((event) => event.actor.toLowerCase() === login && event.thread).map((event) => event.thread));
  return events.filter((event) => event.actor.toLowerCase() !== login && (event.kind !== "review" || event.hasBody) &&
    (login === author.toLowerCase() || (event.kind === "reply" && event.thread && event.key !== event.thread && participated.has(event.thread))));
}

/** Automated bookkeeping and audit comments stay visible without requiring reader acknowledgement. */
export function isAutoReadAuthor(login: string): boolean {
  return ["linear-code[bot]", "homebound-team-bot"].includes(login.toLowerCase());
}

/** Explicit reopen choices override the default collapse of automated PR-level comments. */
export function isCommentResolved(comment: DiscussionComment): boolean {
  return comment.biffResolved ?? (comment.user.type === "Bot" || comment.user.login.toLowerCase().endsWith("[bot]") || isAutoReadAuthor(comment.user.login));
}
