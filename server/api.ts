import type { DraftComment, ReviewSubmission } from "../shared/types";
import { GitHub } from "./github";
import { Workspaces } from "./workspaces";
import type { Reviews } from "./reviews";
import { reviewApi } from "./reviewApi";
import type { Progress } from "./progress";
import type { ChangeIdentity } from "../shared/progress";
import { discussionApi } from "./discussionApi";
import { changeMessage } from "./commentEdits";
import { commentReadsResponse } from "./commentReadsApi";
import type { Inbox } from "./inbox";
import type { InboxAction } from "../shared/inbox";

export interface Services { workspaces: Workspaces; github: GitHub; reviews?: Reviews; progress?: Progress; inbox?: Inbox }

/** Route only local API requests; ordinary browser paths are handled by the SPA. */
export function createApi(services: Services) {
  if (services.reviews && services.progress) services.reviews.connect(services.progress);
  return async function handle(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      // Reject cross-site requests and DNS rebinding to the local command runner.
      if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return failure("Local requests only", 403);
      const origin = request.headers.get("origin");
      if (origin && new URL(origin).origin !== url.origin) return failure("Cross-origin requests are not allowed", 403);
      if (request.headers.get("sec-fetch-site") === "cross-site") return failure("Cross-site requests are not allowed", 403);
      const path = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
      const method = request.method;
      if (path[1] === "reviews" && services.reviews) return await reviewApi(request, services.reviews, services.workspaces, services.progress, services.github);
      if (url.pathname === "/api/health" && method === "GET") return json({ name: "biff", version: 1 });
      if (url.pathname === "/api/inbox/preferences" && method === "POST" && services.inbox) {
        const body = await readBody(request);
        if ((body.sort !== "attention" && body.sort !== "recent") || typeof body.repository !== "string" || body.repository.length > 200) throw new Error("Invalid queue preferences");
        return json(services.inbox.preferences(url.searchParams.get("view") === "requested" ? "requested" : "authored", { sort: body.sort, repository: body.repository }));
      }
      if (url.pathname === "/api/inbox" && services.inbox) {
        const view = url.searchParams.get("view") === "requested" ? "requested" : "authored";
        if (method === "POST") void services.inbox.refresh(view);
        if (method === "GET" || method === "POST") return json(services.inbox.queue(view));
      }
      if (url.pathname === "/api/workspaces" && method === "GET") return json(await services.workspaces.list());
      if (url.pathname === "/api/workspaces" && method === "POST") {
        const body = await readBody(request);
        return json(await services.workspaces.add(text(body.path, "path"), body.name === undefined ? undefined : text(body.name, "name")));
      }
      if (url.pathname === "/api/workspaces/discover" && method === "POST") {
        const body = await readBody(request);
        return json(await services.workspaces.discover(text(body.path, "path")));
      }
      if (path[1] === "workspaces" && path.length === 3 && method === "DELETE") {
        await services.workspaces.remove(path[2]);
        return json({ ok: true });
      }
      if (path[1] === "workspaces" && path[3] === "review" && path.length === 4 && method === "GET") {
        const revision = url.searchParams.get("rev");
        const snapshot = revision ? await services.workspaces.review(path[2], revision) : await services.workspaces.bookmarkReview(path[2], url.searchParams.get("bookmark") ?? undefined, url.searchParams.get("changes") || "all", url.searchParams.get("base") || undefined);
        return json(services.progress ? await services.progress.prepare(snapshot, services.github) : snapshot);
      }
      if (path[1] === "workspaces" && path[3] === "review" && path.length === 4 && method === "POST" && services.progress) {
        const body = await readBody(request);
        const snapshot = await services.workspaces.bookmarkReview(path[2], typeof body.bookmark === "string" ? body.bookmark : undefined, "all", typeof body.base === "string" ? body.base : undefined);
        return json(await services.progress.local(snapshot, true));
      }
      if (path[1] === "workspaces" && path[3] === "changes" && path.length === 6 && path[5] === "identity" && method === "GET" && services.progress) {
        if (!/^[a-f0-9]{64}$/.test(path[4])) throw new Error("Invalid review ID");
        if (!(await services.workspaces.list()).some((workspace) => workspace.id === path[2])) throw new Error("Working copy not found");
        const scope = `jj/${path[2]}/${path[4]}`;
        return json(await services.progress.identity(scope));
      }
      if (path[1] === "workspaces" && path[3] === "changes" && ["progress", "comment-reads"].includes(path[5]) && path.length === 6 && services.progress) {
        if (!/^(?:[k-z]{32}|[a-f0-9]{64})$/.test(path[4])) throw new Error("Invalid review progress scope");
        if (!(await services.workspaces.list()).some((workspace) => workspace.id === path[2])) throw new Error("Working copy not found");
        return await (path[5] === "comment-reads" ? commentReadsResponse : progressResponse)(request, services.progress, `jj/${path[2]}/${path[4]}`);
      }
      if (path[1] === "workspaces" && path[3] === "changes" && path[5] === "discussion" && path.length === 6 && services.progress) {
        if (!/^[a-f0-9]{64}$/.test(path[4])) throw new Error("Invalid review ID");
        if (!(await services.workspaces.list()).some((workspace) => workspace.id === path[2])) throw new Error("Working copy not found");
        return await discussionApi(request, { scope: `jj/${path[2]}/${path[4]}`, workspace: path[2] }, services.progress, services.workspaces, services.github);
      }
      if (url.pathname === "/api/github/prs" && method === "GET") return json(await services.github.dashboard(url.searchParams.get("view") || "authored"));
      if (path[1] === "workspaces" && path[3] === "contents" && path.length === 4 && method === "POST") {
        const body = await readBody(request);
        return json(await services.workspaces.contents(path[2], text(body.commit, "commit"), text(body.path, "path"), body.base === undefined ? undefined : text(body.base, "base")));
      }
      if (path[1] === "github" && path[2] === "pr" && path.length === 7) {
        const repo = `${path[3]}/${path[4]}`;
        const number = path[5];
        const action = path[6];
        if (action === "inbox" && method === "POST" && services.inbox) {
          if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !/^\d+$/.test(number)) throw new Error("Invalid PR");
          return json(services.inbox.act(`${repo.toLowerCase()}/${number}`, inboxAction(await readBody(request))));
        }
        if (action === "comment-reads" && services.progress) return await commentReadsResponse(request, services.progress, `${repo.toLowerCase()}/${number}`);
        if (action === "discussion" && services.progress) return await discussionApi(request, { scope: `${repo.toLowerCase()}/${number}`, repo, number }, services.progress, services.workspaces, services.github);
        if (action === "progress" && services.progress) {
          return await progressResponse(request, services.progress, `${repo.toLowerCase()}/${number}`);
        }
        if (action === "identity" && method === "GET" && services.progress) return json(await services.progress.identity(`${repo.toLowerCase()}/${number}`));
        if (action === "stack" && method === "GET") return json(await services.github.stack(repo, number));
        if (action === "mentions" && method === "GET") return json(await services.github.mentionUsers(repo, number, url.searchParams.get("q") || ""));
        if (action === "contents" && method === "POST") {
          const body = await readBody(request);
          return json(await services.github.contents(repo, number, text(body.head, "head"), text(body.base, "base"), text(body.path, "path"), text(body.oldPath, "oldPath"), body.single === true));
        }
        if (action === "viewed" && method === "GET") return json(await services.github.viewedFiles(repo, number));
        if (action === "viewed" && method === "POST") {
          const body = await readBody(request);
          if (typeof body.viewed !== "boolean") throw new Error("Invalid viewed state");
          return json(await services.github.setFileViewed(repo, number, text(body.path, "path"), body.viewed));
        }
        if (action === "review" && method === "GET") {
          const review = await services.github.review(repo, number, url.searchParams.get("commit") || "all");
          if (services.progress) await services.progress.pullRequest(`${repo.toLowerCase()}/${number}`, review.commits.map((commit) => commit.sha), review.pr.state === "closed");
          return json(review);
        }
        if (action === "conversation" && method === "GET") return json(await services.github.conversation(repo, number));
        if (action === "thread" && method === "POST") {
          const body = await readBody(request);
          if (typeof body.resolved !== "boolean") throw new Error("Invalid resolved state");
          const resolved = body.resolved;
          const root = await services.github.resolveThread(repo, number, text(body.id, "thread ID"), resolved);
          if (services.progress && root !== undefined) await services.progress.updateDiscussion(`${repo.toLowerCase()}/${number}`, (discussion) => {
            for (const thread of discussion.threads) if (thread.messages.some((message) => message.published?.id === root)) thread.resolved = resolved;
          });
          return json({ saved: true });
        }
        if (action === "review" && method === "POST") return json(await services.github.submitReview(repo, number, reviewSubmission(await readBody(request))));
        if (action === "inline-comment" && method === "POST") {
          const body = await readBody(request);
          const submission = reviewSubmission({ event: "COMMENT", commitId: body.commitId, body: "", comments: [body.comment] });
          return json(await services.github.inlineComment(repo, number, submission.commitId, submission.comments[0]));
        }
        if (action === "comment" && method === "POST") {
          const body = await readBody(request);
          const replyTo = body.replyTo === undefined ? undefined : positiveInteger(body.replyTo, "replyTo");
          return json(await services.github.comment(repo, number, text(body.body, "comment"), replyTo));
        }
        if (action === "comment-edit" && method === "POST") {
          const body = await readBody(request);
          const id = positiveInteger(body.id, "comment ID");
          if (body.kind !== "inline" && body.kind !== "general") throw new Error("Invalid comment kind");
          if (body.action !== "edit" && body.action !== "delete") throw new Error("Invalid comment action");
          const value = body.action === "edit" ? text(body.body, "comment") : undefined;
          if (services.progress && body.kind === "inline") await services.progress.updateDiscussion(`${repo.toLowerCase()}/${number}`, async (discussion) => {
            const linked = discussion.threads.find((thread) => thread.messages.some((entry) => entry.published?.id === id));
            if (linked?.messages.some((entry) => entry.publicationPending)) throw new Error("Finish the pending publication before changing this thread.");
            await services.github.changeComment(repo, number, id, "inline", value);
            for (const thread of [...discussion.threads]) {
              const message = thread.messages.find((entry) => entry.published?.id === id);
              if (message) changeMessage(discussion.threads, thread, message.id, value);
            }
          });
          else await services.github.changeComment(repo, number, id, body.kind, value);
          return json({ saved: true });
        }
      }
      return failure("API endpoint not found", 404);
    } catch (error) {
      return failure(error instanceof Error ? error.message : "Request failed", 400);
    }
  };
}

/** Parse bounded JSON bodies before running any command. */
async function readBody(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get("content-type")?.startsWith("application/json")) throw new Error("Expected application/json");
  const raw = await request.text();
  if (raw.length > 1_000_000) throw new Error("Request body is too large");
  const body: unknown = JSON.parse(raw);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Expected a JSON object");
  return body as Record<string, unknown>;
}

/** Use the same durable change matching for PRs and JJ changes. */
async function progressResponse(request: Request, progress: Progress, scope: string): Promise<Response> {
  if (request.method === "GET") return json(await progress.get(scope));
  if (request.method !== "POST") return failure("Method not allowed", 405);
  const body = await readBody(request);
  if (typeof body.reviewed !== "boolean") throw new Error("Invalid reviewed state");
  const identity = changeIdentity(body);
  if (body.blocks !== undefined && (identity.kind !== "file" || !Array.isArray(body.blocks) || body.blocks.length > 10000)) throw new Error("Invalid file changes");
  const blocks = (body.blocks as unknown[] | undefined)?.map(changeIdentity) ?? [];
  if (blocks.some((block) => block.path !== identity.path || block.kind)) throw new Error("File changes must belong to this file");
  return json(await progress.update(scope, identity, body.reviewed, text(body.head, "head"), blocks));
}

/** Accept content identities without trusting browser-only navigation fields. */
function changeIdentity(value: unknown): ChangeIdentity {
  if (!value || typeof value !== "object") throw new Error("Invalid change identity");
  const body = value as Record<string, unknown>;
  if (typeof body.duplicate !== "boolean" || !Number.isSafeInteger(body.oldLine) || !Number.isSafeInteger(body.newLine) || Number(body.oldLine) < 0 || Number(body.newLine) < 0 || typeof body.hash !== "string" || !/^[a-f0-9]{64}$/.test(body.hash) || body.kind !== undefined && body.kind !== "file") throw new Error("Invalid change identity");
  return { path: text(body.path, "path"), hash: body.hash, oldLine: Number(body.oldLine), newLine: Number(body.newLine), duplicate: body.duplicate, ...(body.kind === "file" ? { kind: "file" as const } : {}) };
}

/** Validate review coordinates before forwarding them to GitHub. */
function reviewSubmission(body: Record<string, unknown>): ReviewSubmission {
  if (!["COMMENT", "APPROVE", "REQUEST_CHANGES"].includes(String(body.event))) throw new Error("Invalid review action");
  const commitId = text(body.commitId, "commitId");
  if (!/^[a-f0-9]{40}$/.test(commitId)) throw new Error("Invalid head commit");
  if (typeof body.body !== "string" || body.body.length > 65000) throw new Error("Invalid review body");
  if (!Array.isArray(body.comments) || body.comments.length > 100) throw new Error("Invalid inline comments");
  const comments: DraftComment[] = body.comments.map((value: unknown) => {
    if (!value || typeof value !== "object") throw new Error("Invalid inline comment");
    const comment = value as Record<string, unknown>;
    if (comment.side !== "LEFT" && comment.side !== "RIGHT") throw new Error("Invalid comment side");
    return { path: text(comment.path, "path"), line: positiveInteger(comment.line, "line"), side: comment.side, body: text(comment.body, "comment") };
  });
  if (body.event !== "APPROVE" && !body.body.trim() && comments.length === 0) throw new Error("Write a review or add an inline comment first");
  return { event: body.event as ReviewSubmission["event"], body: body.body, commitId, comments };
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 65000) throw new Error(`Invalid ${label}`);
  return value;
}
function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid ${label}`);
  return value;
}
function json(value: unknown): Response { return Response.json(value, { headers: { "Cache-Control": "no-store" } }); }
function failure(error: string, status: number): Response { return Response.json({ error }, { status, headers: { "Cache-Control": "no-store" } }); }

/** Accept only bounded personal-state commands, never arbitrary database fields. */
function inboxAction(body: Record<string, unknown>): InboxAction {
  const action = body.action;
  if (action === "ignore" || action === "restore" || action === "pin" || action === "unpin" || action === "unread" || action === "unsnooze") return { action };
  if (action === "snooze") return { action, wakeOnActivity: body.wakeOnActivity !== false };
  if (action === "undo" && typeof body.token === "string") return { action, token: body.token };
  if (action === "read" || action === "seen") {
    if (body.head !== undefined && (typeof body.head !== "string" || !/^[a-f0-9]{40,64}$/.test(body.head))) throw new Error("Invalid head SHA");
    if (body.events !== undefined && (!Array.isArray(body.events) || body.events.length > 100_000 || !body.events.every((key) => typeof key === "string" && /^(general|inline|review):\d+$/.test(key)))) throw new Error("Invalid activity IDs");
    return { action, head: body.head as string | undefined, events: body.events as string[] | undefined };
  }
  throw new Error("Invalid inbox action");
}
