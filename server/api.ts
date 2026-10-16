import type { DraftComment, ReviewSubmission } from "../shared/types";
import { GitHub } from "./github";
import { Workspaces } from "./workspaces";
import type { Reviews } from "./reviews";
import { reviewApi } from "./reviewApi";

export interface Services { workspaces: Workspaces; github: GitHub; reviews?: Reviews }

/** Route only local API requests; ordinary browser paths are handled by the SPA. */
export function createApi(services: Services) {
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
      if (path[1] === "reviews" && services.reviews) return await reviewApi(request, services.reviews, services.workspaces);
      if (url.pathname === "/api/health" && method === "GET") return json({ name: "biff", version: 1 });
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
        return json(await services.workspaces.review(path[2], url.searchParams.get("rev") || "@"));
      }
      if (url.pathname === "/api/github/prs" && method === "GET") return json(await services.github.dashboard(url.searchParams.get("view") || "authored"));
      if (path[1] === "workspaces" && path[3] === "contents" && path.length === 4 && method === "POST") {
        const body = await readBody(request);
        return json(await services.workspaces.contents(path[2], text(body.commit, "commit"), text(body.path, "path")));
      }
      if (path[1] === "github" && path[2] === "pr" && path.length === 7) {
        const repo = `${path[3]}/${path[4]}`;
        const number = path[5];
        const action = path[6];
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
        if (action === "review" && method === "GET") return json(await services.github.review(repo, number, url.searchParams.get("commit") || "all"));
        if (action === "conversation" && method === "GET") return json(await services.github.conversation(repo, number));
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
