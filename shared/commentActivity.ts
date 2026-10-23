import type { Activity } from "./inbox";
import type { Conversation } from "./types";

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
  const participated = new Set(events.filter((event) => event.actor === viewer && event.thread).map((event) => event.thread));
  return events.filter((event) => event.actor !== viewer && (event.kind !== "review" || event.hasBody) &&
    (viewer === author || (event.kind === "reply" && event.thread && event.key !== event.thread && participated.has(event.thread))));
}
