import type { ReviewThread } from "../shared/localReview";

/** Delete empty threads along with their last message; other replies keep their anchors. */
export function changeMessage(threads: ReviewThread[], thread: ReviewThread, messageId: string, body?: string): void {
  const message = thread.messages.find((entry) => entry.id === messageId);
  if (!message) throw new Error("Comment not found");
  if (body === undefined) {
    thread.messages = thread.messages.filter((entry) => entry.id !== messageId);
    if (!thread.messages.length) threads.splice(threads.indexOf(thread), 1);
  } else {
    message.body = body;
    message.sequence = Math.max(thread.humanSequence, ...thread.messages.map((entry) => entry.sequence)) + 1;
    if (message.author === "user") thread.humanSequence = message.sequence;
  }
}
