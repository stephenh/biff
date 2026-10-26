import type { ReviewThread } from "../shared/localReview";
import type { Discussion } from "../shared/discussion";
import type { GitHub } from "./github";
import { receiptSnapshot } from "./commentReadsApi";

interface Resolution { resolved: boolean; author: "user" | "agent"; keys?: unknown }

/**
 * Resolve the same local/published thread regardless of which UI or agent route received the action.
 *
 * GitHub must acknowledge published changes before local state advances. Agent actions never read human messages.
 */
export async function resolveDiscussionThread(discussion: Pick<Discussion, "commentReads">, thread: ReviewThread, action: Resolution, github?: Pick<GitHub, "reviewThreads" | "resolveThread">) {
  const keys = action.author === "user" ? receiptSnapshot(action.keys, thread.messages.map((message) => `local:${message.id}`)) : [];
  const published = thread.messages.find((message) => message.published)?.published;
  if (published) {
    if (!github) throw new Error("GitHub is required to resolve a published thread");
    const [owner, name, number] = published.pr.split("/");
    const repo = `${owner}/${name}`;
    const remote = (await github.reviewThreads(repo, number)).find((entry) => entry.comments.nodes[0]?.databaseId === published.id);
    if (!remote) throw new Error("Published thread not found on GitHub");
    await github.resolveThread(repo, number, remote.id, action.resolved);
  }

  thread.resolved = action.resolved;
  if (action.author === "user" && action.resolved) discussion.commentReads = [...new Set([...(discussion.commentReads ?? []), ...keys])];
}
