import type { ReviewSession, ReviewThread } from "../shared/localReview";
import { appendMessage, Reviews } from "./reviews";
import type { Workspaces } from "./workspaces";

/** Serve the same review protocol to the browser, portable CLI, and host adapters. */
export async function reviewApi(request: Request, reviews: Reviews, workspaces: Workspaces): Promise<Response> {
  const url = new URL(request.url);
  const parts = url.pathname.split("/");
  const id = parts[3];
  const action = parts[4];
  if (request.method === "GET") {
    if (!id) return json(await reviews.list(text(url.searchParams.get("workspace"))));
    if (action === "events") return streamReview(request, reviews, id);
    if (action === "wait") {
      const after = url.searchParams.get("after");
      return json(await reviews.wait(id, after === null ? undefined : sequence(Number(after)), request.signal));
    }
    if (!action && id) return json(await reviews.get(id));
  }
  if (request.method !== "POST") throw new Error("Unknown review endpoint");
  if (!request.headers.get("content-type")?.startsWith("application/json")) throw new Error("Expected application/json");
  const raw = await request.text();
  if (raw.length > 1_000_000) throw new Error("Request body is too large");
  const body: Record<string, unknown> = JSON.parse(raw);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Expected JSON object");
  if (!id) {
    const workspace = await workspaces.add(text(body.path));
    return json(await reviews.start(body.revision === undefined ? await workspaces.bookmarkReview(workspace.id) : await workspaces.review(workspace.id, text(body.revision)), body.agentSession === undefined ? "" : text(body.agentSession)));
  }
  if (action === "refresh") {
    const current = await reviews.get(id);
    const previous = current.snapshot;
    const snapshot = previous.tip ? await workspaces.bookmarkReview(previous.workspace.id, previous.bookmark, previous.changes, previous.baseOverride) : await workspaces.review(previous.workspace.id, "@");
    return json(await reviews.update(id, false, (review) => { requireOpen(review); review.snapshot = snapshot; }));
  }
  if (action === "ack") return json(await reviews.update(id, false, (review) => {
    const value = sequence(body.sequence);
    if (value > review.sequence - 1) throw new Error("Cannot acknowledge unseen feedback");
    review.acknowledged = Math.max(review.acknowledged, value);
  }));
  if (action === "finish") return json(await reviews.update(id, true, (review) => { review.finished = true; }));
  if (action === "threads") {
    const current = await reviews.get(id);
    const commitId = text(body.commitId);
    const baseCommitId = current.snapshot.changes === "all" ? current.snapshot.base?.commit_id : undefined;
    if (body.baseCommitId !== baseCommitId) throw new Error("The diff changed. Refresh before posting this comment.");
    if (commitId !== current.snapshot.selected.commit_id) throw new Error("The diff changed. Refresh before posting this comment.");
    const path = text(body.path);
    const line = positive(body.line);
    const endLine = body.endLine === undefined ? line : positive(body.endLine);
    if (endLine < line || endLine - line > 500) throw new Error("Invalid line range");
    if (body.side !== "LEFT" && body.side !== "RIGHT") throw new Error("Invalid side");
    const side = body.side;
    const contents = await workspaces.contents(current.snapshot.workspace.id, commitId, path, current.snapshot.changes === "all" ? current.snapshot.base?.commit_id : undefined);
    const lines = (side === "LEFT" ? contents.oldFile : contents.newFile).contents.split("\n");
    if (endLine > lines.length) throw new Error("Line outside reviewed file");
    const excerpt = lines.slice(Math.max(0, line - 3), endLine + 2).join("\n");
    return json(await reviews.update(id, true, (review) => {
      requireOpen(review);
      if (review.snapshot.selected.commit_id !== commitId) throw new Error("The diff changed. Refresh before posting this comment.");
      if ((review.snapshot.changes === "all" ? review.snapshot.base?.commit_id : undefined) !== baseCommitId) throw new Error("The diff changed. Refresh before posting this comment.");
      const thread: ReviewThread = { id: crypto.randomUUID(), anchor: { path, line, endLine, side, commitId, baseCommitId, excerpt }, resolved: false, humanSequence: review.sequence, messages: [] };
      appendMessage(review, thread, "user", text(body.body));
      review.threads.push(thread);
    }));
  }
  if (action === "reply" || action === "resolve") {
    const author = body.author ?? "user";
    if (author !== "user" && author !== "agent") throw new Error("Invalid author");
    return json(await reviews.update(id, author === "user", (review) => {
      requireOpen(review);
      const thread = review.threads.find((entry) => entry.id === body.threadId);
      if (!thread) throw new Error("Thread not found");
      if (author === "user") thread.humanSequence = review.sequence;
      if (action === "reply") { appendMessage(review, thread, author, text(body.body)); thread.resolved = false; }
      else {
        if (typeof body.resolved !== "boolean") throw new Error("Invalid resolved state");
        thread.resolved = body.resolved;
      }
    }));
  }
  throw new Error("Unknown review endpoint");
}

/** Send full state on reconnect; short heartbeats keep the local HTTP connection alive. */
function streamReview(request: Request, reviews: Reviews, id: string): Response {
  const controller = new AbortController();
  const signal = AbortSignal.any([request.signal, controller.signal]);
  const stream = new ReadableStream<Uint8Array>({
    async start(output) {
      let after = -1;
      try {
        while (!signal.aborted) {
          const review = await reviews.wait(id, after, signal, true);
          output.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(review)}\n\n`));
          after = review.sequence;
          if (review.finished) break;
        }
        output.close();
      } catch (error) { if (!signal.aborted) output.error(error); }
    },
    cancel() { controller.abort(); },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store" } });
}

/** Keep completed reviews readable without accepting new work. */
function requireOpen(review: ReviewSession) { if (review.finished) throw new Error("Review is finished. Start a new review."); }
/** Bound user text before it enters the temporary review file. */
function text(value: unknown): string { if (typeof value !== "string" || !value.trim() || value.length > 65000) throw new Error("Invalid text"); return value; }
/** Validate delivery cursors without allowing acknowledgments to skip future comments. */
function sequence(value: unknown): number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("Invalid sequence"); return value; }
/** Line numbers are one-based on both sides of the diff. */
function positive(value: unknown): number { const number = sequence(value); if (!number) throw new Error("Invalid line"); return number; }
/** Avoid browser caching of session state. */
function json(value: unknown) { return Response.json(value, { headers: { "Cache-Control": "no-store" } }); }
