import type { ReviewSession } from "../shared/localReview";
import { runCommand } from "../server/commands";

/** Expose structured feedback without coupling the review store to an agent host. */
export async function reviewCommand(args: string[], origin: string) {
  const action = args[0];
  const id = args[1];
  let review: ReviewSession;
  if (action === "start") {
    review = await call(origin, "", { path: process.cwd(), revision: option(args, "--rev") || "@", agentSession: option(args, "--session") });
    const url = `${origin}/workspaces/${review.snapshot.workspace.id}?review=${review.id}`;
    console.log(JSON.stringify({ ...review, url }));
    if (!args.includes("--no-open")) await runCommand([process.platform === "darwin" ? "open" : "xdg-open", url]);
    return;
  }
  if (!id || !/^[a-f0-9-]{36}$/.test(id)) throw new Error("Expected a review ID; run biff review start first");
  if (action === "get" || action === "wait") {
    const after = option(args, "--after");
    review = await call(origin, `/${id}${action === "wait" ? `/wait${after === undefined ? "" : `?after=${encodeURIComponent(after)}`}` : ""}`);
  } else if (action === "reply") {
    const body = option(args, "--body");
    if (!body || !args[2]) throw new Error("Usage: biff review reply ID THREAD --body TEXT");
    review = await call(origin, `/${id}/reply`, { threadId: args[2], body, author: "agent" });
  } else if (action === "resolve" || action === "reopen") {
    review = await call(origin, `/${id}/resolve`, { threadId: args[2], resolved: action === "resolve", author: "agent" });
  } else if (action === "ack") {
    const value = Number(args[2]);
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("Usage: biff review ack ID SEQUENCE");
    review = await call(origin, `/${id}/ack`, { sequence: value });
  } else if (action === "refresh" || action === "finish") review = await call(origin, `/${id}/${action}`, {});
  else throw new Error("Unknown review command. Use start, get, wait, reply, resolve, reopen, ack, refresh, or finish.");
  console.log(JSON.stringify(review));
}

/** Parse value flags without accidentally treating the next flag as their value. */
function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  if (!args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`Missing value for ${name}`);
  return args[index + 1];
}

/** Long polls have a bounded server timeout and can safely be repeated after disconnects. */
async function call(origin: string, path: string, body?: unknown): Promise<ReviewSession> {
  const response = await fetch(`${origin}/api/reviews${path}`, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const result = await response.json();
  if (response.status === 404) throw new Error("This Biff daemon does not support agent reviews. Restart the daemon after rebuilding Biff.");
  if (!response.ok) throw new Error(result.error || "Review request failed");
  return result;
}
