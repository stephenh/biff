import type { ReviewSession } from "../shared/localReview";

export interface FeedbackPrompt { sessionID: string; id: string; delivery: "steer"; text: string }

/** Deliver feedback at least once, with stable host IDs to deduplicate admission retries. */
export async function forwardReview(options: {
  review: ReviewSession;
  signal: AbortSignal;
  read(): Promise<ReviewSession>;
  acknowledge(sequence: number): Promise<unknown>;
  deliver(prompt: FeedbackPrompt): Promise<unknown>;
}) {
  const sessionID = options.review.agentSession.slice("opencode:".length);
  while (!options.signal.aborted) {
    const review = await options.read();
    if (review.humanSequence > review.acknowledged) {
      const threads = review.threads.filter((thread) => thread.humanSequence > review.acknowledged);
      const instructions = review.finished
        ? "The user finished the review. Stop waiting and summarize outstanding threads; posting is now closed."
        : "Read these threads as user feedback, address the requests, and reply with biff review reply. After edits, run biff review refresh. Do not repeat already-addressed message IDs.";
      await options.deliver({ sessionID, id: `msg_biff_${review.id}_${review.humanSequence}`, delivery: "steer", text: `Biff review ${review.id}. Push delivery is active; do not run wait or ack. ${instructions}\n${JSON.stringify({ sequence: review.humanSequence, finished: review.finished, threads })}` });
      // Only advance the batch we admitted, not feedback posted while admission was in flight.
      await options.acknowledge(review.humanSequence);
    }
    if (review.finished) return;
  }
}
