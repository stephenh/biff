import { createHash } from "node:crypto";
import { parsePatchFiles, type FileDiffLoadedFiles } from "@pierre/diffs";
import type { ReviewThread } from "../shared/localReview";
import type { GitHub } from "./github";
import type { Progress } from "./progress";
import type { Workspaces } from "./workspaces";
import { changeDiscussionMessage } from "./commentEdits";
import { resolveDiscussionThread } from "./threadResolution";
import { anchorComment, commentHunks } from "../shared/commentHunks";

export interface DiscussionSource { scope: string; workspace?: string; repo?: string; number?: string }

/**
 * Store drafts locally; publishing and changes to published comments also update GitHub.
 *
 * Anchors include both source versions, so a changed PR base cannot silently move a comment.
 */
export async function discussionApi(request: Request, source: DiscussionSource, progress: Progress, workspaces: Workspaces, github: GitHub): Promise<Response> {
  if (request.method === "GET") return new URL(request.url).searchParams.has("events") ? discussionEvents(request, source.scope, progress) : json(await progress.discussion(source.scope));
  if (request.method !== "POST") throw new Error("Method not allowed");
  if (!request.headers.get("content-type")?.startsWith("application/json")) throw new Error("Expected application/json");
  const raw = await request.text();
  if (raw.length > 1_000_000) throw new Error("Request body is too large");
  const body: Record<string, unknown> = JSON.parse(raw);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Expected a JSON object");

  if (body.action === "create") {
    const path = text(body.path);
    const commitId = text(body.commitId);
    const baseCommitId = text(body.baseCommitId);
    await progress.requireSnapshot(source.scope, commitId);
    const line = positive(body.line);
    const endLine = body.endLine === undefined ? line : positive(body.endLine);
    if (endLine < line || endLine - line > 500) throw new Error("Invalid line range");
    if (body.side !== "LEFT" && body.side !== "RIGHT") throw new Error("Invalid side");
    const side = body.side;
    let contents: FileDiffLoadedFiles;
    let hunk: ReviewThread["hunk"];
    if (source.workspace) contents = await workspaces.contents(source.workspace, commitId, path, baseCommitId);
    else {
      const review = await github.review(source.repo!, source.number!, "all");
      if (review.pr.head.sha !== commitId || review.pr.base.sha !== baseCommitId) throw new Error("The PR changed. Refresh before saving this comment.");
      hunk = anchorComment(await commentHunks(review.patch), { path, side, line, body: "" }, endLine).anchor;
      const file = parsePatchFiles(review.patch).flatMap((patch) => patch.files).find((entry) => entry.name === path);
      if (!file) throw new Error("File is not in this PR diff");
      contents = await github.contents(source.repo!, source.number!, commitId, baseCommitId, path, file.prevName ?? path, false);
    }
    const sourceText = (side === "LEFT" ? contents.oldFile : contents.newFile).contents;
    const lines = sourceText.split("\n");
    if (sourceText.endsWith("\n") || !sourceText) lines.pop();
    if (endLine > lines.length) throw new Error("Line outside reviewed file");
    const thread: ReviewThread = {
      id: crypto.randomUUID(), resolved: false, humanSequence: 1,
      anchor: { path, side, line, endLine, commitId, baseCommitId, oldPath: contents.oldFile.name, fileHash: fileHash(contents), excerpt: lines.slice(Math.max(0, line - 3), endLine + 2).join("\n") },
      messages: [{ id: crypto.randomUUID(), author: "user", body: text(body.body), createdAt: new Date().toISOString(), sequence: 1 }],
      ...(hunk ? { hunk } : {}),
    };
    return json(await progress.updateDiscussion(source.scope, (discussion) => { discussion.threads.push(thread); }));
  }

  if (body.action === "publish") {
    const id = text(body.threadId);
    const identity = await progress.identity(source.scope);
    if (identity.pr) {
      const [owner, name, number] = identity.pr.split("/");
      await github.syncThreads(`${owner}/${name}`, number);
    }
    return json(await progress.publishDiscussion(source.scope, id, (thread, pr) => publishThread(thread, pr, github)));
  }

  return json(await progress.updateDiscussion(source.scope, async (discussion) => {
    const thread = discussion.threads.find((entry) => entry.id === text(body.threadId));
    if (!thread) throw new Error("Comment thread not found");
    if (body.action === "reply") {
      const sequence = Math.max(thread.humanSequence, ...thread.messages.map((message) => message.sequence)) + 1;
      thread.messages.push({ id: crypto.randomUUID(), author: "user", body: text(body.body), createdAt: new Date().toISOString(), sequence });
      thread.humanSequence = sequence;
      thread.resolved = false;
    } else if (body.action === "edit" || body.action === "delete") {
      const value = body.action === "edit" ? text(body.body) : undefined;
      await changeDiscussionMessage(discussion.threads, thread.id, text(body.messageId), value, github);
    } else if (body.action === "resolve") {
      if (typeof body.resolved !== "boolean") throw new Error("Invalid resolved state");
      await resolveDiscussionThread(discussion, thread, { resolved: body.resolved, author: "user", keys: body.keys }, github);
    } else throw new Error("Unknown discussion action");
  }));
}

/**
 * Publish only unsent messages, retaining a per-message receipt for honest mixed thread status.
 *
 * Stable hidden markers recover a successful GitHub write whose response or local save was lost.
 * They also prevent a retry after partial publication from duplicating earlier messages.
 */
async function publishThread(thread: ReviewThread, pr: string, github: GitHub): Promise<void> {
  const [owner, name, number] = pr.split("/");
  const repo = `${owner}/${name}`;
  const existing = await github.inlineComments(repo, number);
  let root = thread.messages[0].published?.id;
  for (const message of thread.messages) {
    if (message.published) continue;
    const marker = `<!-- biff:${thread.id}:${message.id} -->`;
    let posted = existing.find((comment) => comment.body.trimEnd().endsWith(marker));
    if (!posted) {
      const body = `${message.author === "agent" ? "**Agent:**\n\n" : ""}${message.body}\n\n${marker}`;
      if (root) posted = await github.comment(repo, number, body, root);
      else {
        const current = await github.pullRequest(repo, number);
        if (current.state !== "open") rejectPublication(thread, "The PR is closed.");
        const attachment = thread.attachment?.matched ? thread.attachment : undefined;
        if (current.head.sha !== (attachment?.commitId ?? thread.anchor.commitId) || attachment && current.base.sha !== attachment.baseCommitId) rejectPublication(thread, "This comment needs re-anchoring. It is still saved in Biff; choose its location on the current PR before publishing.");
        const contents = await github.contents(repo, number, current.head.sha, current.base.sha, thread.anchor.path, thread.anchor.oldPath ?? thread.anchor.path, false);
        if (!attachment && fileHash(contents) !== thread.anchor.fileHash) rejectPublication(thread, "The PR's file diff differs from this comment's snapshot. Keep this comment local and review the current diff.");
        const anchor = attachment ?? thread.anchor;
        posted = await github.inlineComment(repo, number, anchor.commitId, { path: anchor.path, side: anchor.side, line: anchor.endLine, ...(anchor.endLine > anchor.line ? { start_line: anchor.line, start_side: anchor.side } : {}), body });
      }
    }
    if (!posted || !Number.isSafeInteger(posted.id) || !posted.html_url) throw new Error("GitHub did not return a comment receipt. Retry to recover its publication status.");
    root ??= posted.id;
    message.published = { pr, id: posted.id, url: posted.html_url, publishedAt: new Date().toISOString() };
    delete message.publicationPending;
  }
}

/** A failed preflight made no external write, so these remaining messages are definitely local. */
function rejectPublication(thread: ReviewThread, reason: string): never {
  for (const message of thread.messages) if (!message.published) delete message.publicationPending;
  throw new Error(reason);
}

/** Compare complete file versions, independent of abbreviated Git blob IDs or context width. */
export function fileHash(contents: FileDiffLoadedFiles): string {
  return createHash("sha256").update(JSON.stringify([contents.oldFile?.contents ?? contents.newFile.contents, contents.newFile.contents])).digest("hex");
}

/** Reject empty or oversized text before storing it or forwarding it to GitHub. */
function text(value: unknown): string { if (typeof value !== "string" || !value.trim() || value.length > 65000) throw new Error("Invalid comment text or anchor"); return value; }
/** Lines are positive, one-based coordinates on the recorded file side. */
function positive(value: unknown): number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new Error("Invalid line"); return value; }

/**
 * Deliver agent replies to ordinary bookmark/PR tabs without requiring a page reload.
 *
 * Subscribe before the first read so comments posted during connection setup cannot be missed.
 */
function discussionEvents(request: Request, scope: string, progress: Progress): Response {
  const controller = new AbortController();
  const signal = AbortSignal.any([request.signal, controller.signal]);
  const stream = new ReadableStream<Uint8Array>({
    start(output) {
      let stopped = false;
      let pending = Promise.resolve();
      const encoder = new TextEncoder();
      /** Serialize reads so a slow earlier event cannot replace a later discussion snapshot. */
      function send() {
        pending = pending.then(async () => {
          if (stopped) return;
          const discussion = await progress.discussion(scope);
          if (!stopped) output.enqueue(encoder.encode(`data: ${JSON.stringify(discussion)}\n\n`));
        }).catch((error) => { if (!stopped) { cleanup(); output.error(error); } });
      }
      const unsubscribe = progress.subscribeDiscussion(send);
      const heartbeat = setInterval(() => { if (!stopped) output.enqueue(encoder.encode(": heartbeat\n\n")); }, 15_000);
      /** Drop the listener and timer when the browser leaves this review. */
      function stop() { cleanup(); try { output.close(); } catch { /* The browser may have already canceled the stream. */ } }
      function cleanup() { stopped = true; unsubscribe(); clearInterval(heartbeat); signal.removeEventListener("abort", stop); }
      signal.addEventListener("abort", stop, { once: true });
      if (signal.aborted) stop(); else send();
    },
    cancel() { controller.abort(); },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store" } });
}
/** Comments must reload after mutations or switching between linked views. */
function json(value: unknown) { return Response.json(value, { headers: { "Cache-Control": "no-store" } }); }
