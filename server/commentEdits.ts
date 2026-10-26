import type { ReviewThread } from "../shared/localReview";
import type { GitHub } from "./github";

/** Apply ownership and publication rules before changing a local or published message. */
export async function changeDiscussionMessage(threads: ReviewThread[], threadId: string, messageId: string, body: string | undefined, github?: Pick<GitHub, "changeComment">): Promise<ReviewThread> {
  const thread = threads.find((entry) => entry.id === threadId);
  if (!thread) throw new Error("Comment thread not found");
  const message = thread.messages.find((entry) => entry.id === messageId);
  if (!message) throw new Error("Comment not found");
  if (message.author !== "user") throw new Error("You can only change your own comments.");
  if (thread.messages.some((entry) => entry.publicationPending)) throw new Error("Finish the pending publication before changing this thread.");

  // Keep the local message intact unless GitHub acknowledges the published edit or deletion.
  if (message.published) {
    if (!github) throw new Error("GitHub is required to change a published comment");
    const [owner, name, number] = message.published.pr.split("/");
    await github.changeComment(`${owner}/${name}`, number, message.published.id, "inline", body);
  }
  changeMessage(threads, thread, messageId, body);
  return thread;
}

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
