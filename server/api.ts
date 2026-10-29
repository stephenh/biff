import type { Storage } from "./storage";
import { acceptSnapshot } from "./reviewSnapshots";
import { prepareLocalReview } from "./localReview";
import { localReview, reviewIdentity, recordPullRequest, commentReads } from "./reviewStore";
import { readReviewDraft, acknowledgeReview } from "./reviewDrafts";
import { reconcileFollowUpThreads, followUps, followUpHunk, followUpThread } from "./followUps";
import { updateDiscussion, readDiscussion } from "./discussionThreads";
import { hunkApprovals, updateHunkApprovals, updateHunkApproval } from "./logicalHunks";
import type { DraftComment, ReviewDraft, ReviewSubmission } from "../shared/types";
import { GitHub } from "./github";
import { Workspaces } from "./workspaces";
import type { Reviews } from "./reviews";
import { reviewApi } from "./reviewApi";
import type { ChangeIdentity } from "../shared/progress";
import { discussionApi } from "./discussionApi";
import { changeMessage } from "./commentEdits";
import { autoReadComments, commentReadsResponse, receiptSnapshot } from "./commentReadsApi";
import { conversationActivity } from "../shared/commentActivity";
import type { Inbox } from "./inbox";
import { queueView, type InboxAction } from "../shared/inbox";
import type { GitHubViewedSync } from "./githubViewedSync";

export interface Services { workspaces: Workspaces; github: GitHub; reviews?: Reviews; storage?: Storage; inbox?: Inbox; githubViewedSync?: GitHubViewedSync }

/**
 * Route local and explicitly configured public API requests; browser paths use the SPA.
 *
 * The public origin is deployment configuration, never a value inferred from request headers.
 */
export function createApi(services: Services, publicOrigin?: string) {
  const publicUrl = configuredPublicOrigin(publicOrigin);
  const threadWrites = new Map<string, Promise<Response>>();
  if (services.reviews && services.storage) services.reviews.connectDiscussions();
  return async function handle(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      // Reject cross-site requests and DNS rebinding to the local command runner.
      const local = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
      // Caddy preserves Host but terminates HTTPS. Never derive trust from forwarded headers.
      const publicHost = publicUrl && url.host === publicUrl.host && ["http:", "https:"].includes(url.protocol);
      if (!local && !publicHost) return failure(publicUrl ? "Host is not allowed" : "Local requests only", 403);

      const origin = request.headers.get("origin");
      const expectedOrigin = local ? url.origin : publicUrl?.origin;
      if (origin !== null && origin !== expectedOrigin) return failure("Cross-origin requests are not allowed", 403);
      if (request.headers.get("sec-fetch-site") === "cross-site") return failure("Cross-site requests are not allowed", 403);

      const path = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
      const method = request.method;
      if (path[1] === "reviews" && services.reviews) return await reviewApi(request, services.reviews, services.workspaces, services.storage, services.github);
      if (url.pathname === "/api/health" && method === "GET") return json({ name: "biff", version: 1 });
      if (path[1] === "github" && path[2] === "attachment" && path.length === 4 && method === "GET") return await services.github.attachment(path[3]);
      if (url.pathname === "/api/inbox/preferences" && method === "POST" && services.inbox) {
        const body = await readBody(request);
        if (typeof body.repository !== "string" || body.repository.length > 200) throw new Error("Invalid queue preferences");
        return json(services.inbox.preferences(queueView(url.searchParams.get("view")), { repository: body.repository }));
      }
      if (url.pathname === "/api/inbox" && services.inbox) {
        const view = queueView(url.searchParams.get("view"));
        if (method === "POST") void services.inbox.refresh(view, url.searchParams.get("archived") === "1");
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
      if (path[1] === "workspaces" && path[3] === "snapshots" && path.length === 5 && method === "GET") {
        return json(services.workspaces.snapshot(path[2], path[4]));
      }
      if (path[1] === "workspaces" && path[3] === "review" && path.length === 4 && method === "GET") {
        const revision = url.searchParams.get("rev");
        const snapshot = revision ? await services.workspaces.review(path[2], revision) : await services.workspaces.bookmarkReview(path[2], url.searchParams.get("bookmark") ?? undefined, "all", undefined, url.searchParams.get("follow") === "1" ? true : undefined);
        const prepared = services.storage ? await prepareLocalReview(services.storage, snapshot, services.github, services.workspaces) : snapshot;
        const changes = url.searchParams.get("changes") || "all";
        // Resolve the relationship before selecting a commit: the PR range can include
        // commits below the locally inferred parent bookmark.
        if (!revision && changes !== "all") {
          const selected = await services.workspaces.bookmarkReview(path[2], prepared.bookmark, changes, prepared.base!.commit_id, prepared.followWorkingCopy);
          const snapshot = { ...selected, baseLabel: prepared.baseLabel, baseOverride: undefined };
          return json(services.storage ? acceptSnapshot(services.storage.db, snapshot) : snapshot);
        }
        return json(prepared);
      }
      if (path[1] === "workspaces" && path[3] === "review" && path.length === 4 && method === "POST" && services.storage) {
        const body = await readBody(request);
        const snapshot = await services.workspaces.bookmarkReview(path[2], typeof body.bookmark === "string" ? body.bookmark : undefined);
        return json(await localReview(services.storage, snapshot, true));
      }
      if (path[1] === "workspaces" && path[3] === "changes" && path.length === 6 && path[5] === "identity" && method === "GET" && services.storage) {
        if (!/^[a-f0-9]{64}$/.test(path[4])) throw new Error("Invalid review ID");
        if (!(await services.workspaces.list()).some((workspace) => workspace.id === path[2])) throw new Error("Working copy not found");
        const scope = `jj/${path[2]}/${path[4]}`;
        return json(await reviewIdentity(services.storage, scope));
      }
      if (path[1] === "workspaces" && path[3] === "changes" && ["progress", "comment-reads", "follow-ups"].includes(path[5]) && path.length === 6 && services.storage) {
        if (!/^(?:[k-z]{32}|[a-f0-9]{64})$/.test(path[4])) throw new Error("Invalid review progress scope");
        if (!(await services.workspaces.list()).some((workspace) => workspace.id === path[2])) throw new Error("Working copy not found");
        return await (path[5] === "follow-ups" ? followUpsResponse : path[5] === "comment-reads" ? commentReadsResponse : progressResponse)(request, services.storage, `jj/${path[2]}/${path[4]}`);
      }
      if (path[1] === "workspaces" && path[3] === "changes" && path[5] === "discussion" && path.length === 6 && services.storage) {
        if (!/^[a-f0-9]{64}$/.test(path[4])) throw new Error("Invalid review ID");
        if (!(await services.workspaces.list()).some((workspace) => workspace.id === path[2])) throw new Error("Working copy not found");
        return await discussionApi(request, { scope: `jj/${path[2]}/${path[4]}`, workspace: path[2] }, services.storage, services.workspaces, services.github);
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
        if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !/^[1-9]\d*$/.test(number)) throw new Error("Invalid GitHub repository or PR number.");
        if (action === "track" && method === "POST" && services.inbox) {
          if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !/^\d+$/.test(number)) throw new Error("Invalid PR");
          await services.inbox.track(repo, number);
          return json({ ok: true });
        }
        if (action === "follow-ups" && services.storage) return await followUpsResponse(request, services.storage, `${repo.toLowerCase()}/${number}`, services.github, repo, number);
        if (action === "inbox" && method === "POST" && services.inbox) {
          if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !/^\d+$/.test(number)) throw new Error("Invalid PR");
          return json(await services.inbox.save(`${repo.toLowerCase()}/${number}`, inboxAction(await readBody(request))));
        }
        if (action === "comment-reads" && services.storage) return await commentReadsResponse(request, services.storage, `${repo.toLowerCase()}/${number}`);
        if (action === "discussion" && services.storage) return await discussionApi(request, { scope: `${repo.toLowerCase()}/${number}`, repo, number }, services.storage, services.workspaces, services.github);
        if (action === "progress" && services.storage) {
          const response = await progressResponse(request, services.storage, `${repo.toLowerCase()}/${number}`);
          if (method === "POST") services.githubViewedSync?.wake();
          return response;
        }
        if (action === "identity" && method === "GET" && services.storage) return json(await reviewIdentity(services.storage, `${repo.toLowerCase()}/${number}`));
        if (action === "stack" && method === "GET") return json(await services.github.stack(repo, number));
        if (action === "status" && method === "GET") return json(await services.github.status(repo, number));
        if (action === "failed-checks" && method === "GET") return json(await services.github.failedChecks(repo, number));
        if (action === "metadata" && method === "GET") return json(await services.github.pullRequest(repo, number));
        if (action === "mentions" && method === "GET") return json(await services.github.mentionUsers(repo, number, url.searchParams.get("q") || ""));
        if (action === "contents" && method === "POST") {
          const body = await readBody(request);
          return json(await services.github.contents(repo, number, text(body.head, "head"), text(body.base, "base"), text(body.path, "path"), text(body.oldPath, "oldPath"), body.single === true));
        }
        if (action === "viewed" && method === "GET") return json(services.githubViewedSync?.status(`${repo.toLowerCase()}/${number}`) ?? await services.github.viewedFiles(repo, number));
        if (action === "viewed-sync" && method === "POST" && services.githubViewedSync) {
          await services.githubViewedSync.retry(`${repo.toLowerCase()}/${number}`);
          return json(services.githubViewedSync.status(`${repo.toLowerCase()}/${number}`));
        }
        if (action === "viewed" && method === "POST") {
          const body = await readBody(request);
          if (typeof body.viewed !== "boolean") throw new Error("Invalid viewed state");
          return json(await services.github.setFileViewed(repo, number, text(body.path, "path"), body.viewed));
        }
        if (action === "review" && method === "GET") {
          const review = await services.github.review(repo, number, url.searchParams.get("commit") || "all");
          if (services.storage) await recordPullRequest(services.storage, `${repo.toLowerCase()}/${number}`, review.commits.map((commit) => commit.sha), review.pr.state === "closed", review.pr.head.sha);
          if (review.commit === "all") await services.githubViewedSync?.prepare(repo, number, review);
          if (review.commit === "all") await services.github.syncThreads(repo, number, review);
          return json(review);
        }
        if (action === "review-draft" && services.storage) {
          if (method === "GET") {
            await services.github.syncThreads(repo, number);
            return json(await readReviewDraft(services.storage, `${repo.toLowerCase()}/${number}`));
          }
          if (method === "POST" && services.github.threadSync) {
            const body = await readBody(request);
            const draft = reviewSubmission({ ...body, event: "APPROVE" });
            if (!Number.isSafeInteger(body.version) || Number(body.version) < 0) throw new Error("Invalid draft version");
            return json(await services.github.threadSync.saveDraft(repo, number, { ...draft, version: Number(body.version) }, body.importing === true));
          }
        }
        if (action === "thread-anchor" && method === "POST" && services.github.threadSync) {
          const body = await readBody(request);
          const location = reviewSubmission({ event: "APPROVE", commitId: body.commitId, body: "", comments: [{ ...body, body: "anchor" }] }).comments[0];
          const expected = body.expected as Record<string, unknown> | undefined;
          if (!expected || typeof expected.matched !== "boolean" || expected.side !== "LEFT" && expected.side !== "RIGHT") throw new Error("Missing thread attachment evidence");
          return json(await services.github.threadSync.reanchor(repo, number, positiveInteger(body.githubId, "GitHub comment"), location, text(body.commitId, "head"), text(body.baseCommitId, "base"),
            { path: text(expected.path, "expected path"), line: positiveInteger(expected.line, "expected line"), side: expected.side, commitId: text(expected.commitId, "expected head"), baseCommitId: text(expected.baseCommitId, "expected base"), matched: expected.matched }));
        }
        if (action === "conversation" && method === "GET") {
          const conversation = await services.github.conversation(repo, number);
          if (services.storage) await autoReadComments(services.storage, `${repo.toLowerCase()}/${number}`, conversationActivity(conversation));
          if (services.storage) await reconcileFollowUpThreads(services.storage, `${repo.toLowerCase()}/${number}`, conversation.inline.filter((comment) => !comment.in_reply_to_id).map((comment) => comment.id));
          return json({ ...conversation, commentReads: services.storage ? await commentReads(services.storage, `${repo.toLowerCase()}/${number}`) : undefined });
        }
        if (action === "thread" && method === "POST") {
          const body = await readBody(request);
          const id = text(body.id, "thread ID");
          return await serializeThread(threadWrites, `${repo.toLowerCase()}/${number}:${id}`, async () => {
            const complete = body.action === "complete";
            if (!complete && typeof body.resolved !== "boolean") throw new Error("Invalid resolved state");
            const conversation = await services.github.conversation(repo, number);
            const root = conversation.inline.find((comment) => !comment.in_reply_to_id && comment.reviewThread?.id === id);
            if (!root?.reviewThread) throw new Error("Thread not found in this PR");
            const comments = conversation.inline.filter((comment) => comment.id === root.id || comment.in_reply_to_id === root.id);
            const keys = receiptSnapshot(body.keys, comments.map((comment) => `github:${comment.id}`));
            const own = Boolean(conversation.viewer && conversation.viewer.toLowerCase() === root.user.login.toLowerCase());
            const resolved = complete ? root.reviewThread.resolved || (own && root.reviewThread.canResolve) : body.resolved as boolean;
            const resolution = !complete || (own && root.reviewThread.canResolve && !root.reviewThread.resolved)
              ? await services.github.resolveThread(repo, number, id, resolved) : root.reviewThread;

            const scope = `${repo.toLowerCase()}/${number}`;
            if (services.storage) await updateDiscussion(services.storage, scope, (discussion) => {
              for (const thread of discussion.threads) if (thread.messages.some((message) => message.published?.id === root.id)) thread.resolved = resolution.resolved;
              if (complete || resolution.resolved) discussion.commentReads = [...new Set([...(discussion.commentReads ?? []), ...keys])];
            });
            for (const comment of comments) comment.reviewThread = resolution;
            return json({ ...conversation, commentReads: services.storage ? await commentReads(services.storage, scope) : undefined });
          });
        }
        if (action === "review" && method === "POST") {
          let submission = reviewSubmission(await readBody(request));
          let sent: ReviewDraft = submission;
          const requestId = request.headers.get("Idempotency-Key") ?? undefined;
          const receipt = requestId ? await services.github.submittedReview(repo, number, requestId, submission) : undefined;
          if (!receipt && services.github.threadSync && submission.comments.length) {
            await services.github.threadSync.saveDraft(repo, number, submission, true);
            const current = await services.github.review(repo, number, "all");
            if (submission.event === "APPROVE" && current.pr.head.sha !== submission.commitId) throw new Error("The PR changed. Your comments are saved; review the latest changes before approving.");
            submission = { ...submission, commitId: current.pr.head.sha, comments: await services.github.threadSync.submission(repo, number, submission, current) };
            sent = submission;
          }
          const review = receipt ?? await services.github.submitReview(repo, number, submission, requestId);
          if (services.storage) await acknowledgeReview(services.storage, `${repo.toLowerCase()}/${number}`, sent, review.id);
          services.inbox?.recordReview(`${repo.toLowerCase()}/${number}`, review);
          return json({ ...review, ...(services.storage ? { biffDraft: await readReviewDraft(services.storage, `${repo.toLowerCase()}/${number}`) } : {}) });
        }
        if (action === "inline-comment" && method === "POST") {
          const body = await readBody(request);
          const submission = reviewSubmission({ event: "COMMENT", commitId: body.commitId, body: "", comments: [body.comment] });
          let comment = submission.comments[0];
          let head = submission.commitId;
          const requestId = request.headers.get("Idempotency-Key") ?? undefined;
          const receipt = requestId ? await services.github.submittedComment(repo, number, requestId) : undefined;
          if (!receipt && services.github.threadSync && comment.id) {
            // Admission is independent of GitHub publication, including callers without a prior draft save.
            await services.github.threadSync.saveDraft(repo, number, submission, true);
            const current = await services.github.review(repo, number, "all");
            comment = (await services.github.threadSync.submission(repo, number, submission, current))[0];
            head = current.pr.head.sha;
          }
          const posted = receipt ?? await services.github.inlineComment(repo, number, head, comment, requestId);
          await services.github.threadSync?.observe(repo, number, [posted], comment.id);
          return json({ ...posted, ...(services.storage ? { biffDraft: await readReviewDraft(services.storage, `${repo.toLowerCase()}/${number}`) } : {}) });
        }
        if (action === "comment" && method === "POST") {
          const body = await readBody(request);
          const replyTo = body.replyTo === undefined ? undefined : positiveInteger(body.replyTo, "replyTo");
          return json(await services.github.comment(repo, number, text(body.body, "comment"), replyTo, request.headers.get("Idempotency-Key") ?? undefined));
        }
        if (action === "comment-edit" && method === "POST") {
          const body = await readBody(request);
          const id = positiveInteger(body.id, "comment ID");
          if (body.kind !== "inline" && body.kind !== "general") throw new Error("Invalid comment kind");
          if (body.action !== "edit" && body.action !== "delete") throw new Error("Invalid comment action");
          const value = body.action === "edit" ? text(body.body, "comment") : undefined;
          if (services.storage && body.kind === "inline") await updateDiscussion(services.storage, `${repo.toLowerCase()}/${number}`, async (discussion) => {
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

/** Preserve server admission order across tabs, including idempotent retries after remote success. */
function serializeThread(writes: Map<string, Promise<Response>>, key: string, operation: () => Promise<Response>): Promise<Response> {
  const previous = writes.get(key);
  const task = (previous ? previous.catch(() => undefined) : Promise.resolve()).then(operation);
  writes.set(key, task);
  void task.finally(() => { if (writes.get(key) === task) writes.delete(key); }).catch(() => {});
  return task;
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
async function progressResponse(request: Request, storage: Storage, scope: string): Promise<Response> {
  if (request.method === "GET") return json(await hunkApprovals(storage, scope));
  if (request.method !== "POST") return failure("Method not allowed", 405);
  const body = await readBody(request);
  if (body.changes !== undefined) {
    if (!Array.isArray(body.changes) || body.changes.length > 10000) throw new Error("Invalid progress changes");
    const changes = body.changes.map((entry: unknown) => {
      if (!entry || typeof entry !== "object") throw new Error("Invalid progress change");
      const change = entry as Record<string, unknown>;
      if (typeof change.reviewed !== "boolean") throw new Error("Invalid reviewed state");
      const identity = changeIdentity(change.identity);
      if (identity.kind === "file") throw new Error("Expected a hunk or metadata unit");
      return { identity, reviewed: change.reviewed };
    });
    if (changes.some((change) => change.identity.path !== changes[0].identity.path)) throw new Error("Progress batch must belong to one file");
    return json(await updateHunkApprovals(storage, scope, changes, text(body.head, "head")));
  }
  if (typeof body.reviewed !== "boolean") throw new Error("Invalid reviewed state");
  const identity = changeIdentity(body);
  if (body.blocks !== undefined && (identity.kind !== "file" || !Array.isArray(body.blocks) || body.blocks.length > 10000)) throw new Error("Invalid file changes");
  const blocks = (body.blocks as unknown[] | undefined)?.map(changeIdentity) ?? [];
  if (blocks.some((block) => block.path !== identity.path || block.kind === "file")) throw new Error("File changes must belong to this file");
  return json(await updateHunkApproval(storage, scope, identity, body.reviewed, text(body.head, "head"), blocks));
}

/** Accept content identities without trusting browser-only navigation fields. */
function changeIdentity(value: unknown): ChangeIdentity {
  if (!value || typeof value !== "object") throw new Error("Invalid change identity");
  const body = value as Record<string, unknown>;
  if (typeof body.duplicate !== "boolean" || !Number.isSafeInteger(body.oldLine) || !Number.isSafeInteger(body.newLine) || Number(body.oldLine) < 0 || Number(body.newLine) < 0 || typeof body.hash !== "string" || !/^[a-f0-9]{64}$/.test(body.hash) || body.kind !== undefined && body.kind !== "file" && body.kind !== "metadata") throw new Error("Invalid change identity");
  return { path: text(body.path, "path"), hash: body.hash, oldLine: Number(body.oldLine), newLine: Number(body.newLine), duplicate: body.duplicate, ...(body.kind ? { kind: body.kind as "file" | "metadata" } : {}) };
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
    const id = comment.id === undefined ? undefined : text(comment.id, "comment ID");
    if (id && !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)) throw new Error("Invalid comment ID");
    const commitId = comment.commitId === undefined ? undefined : text(comment.commitId, "comment commit");
    const baseCommitId = comment.baseCommitId === undefined ? undefined : text(comment.baseCommitId, "comment base");
    if ([commitId, baseCommitId].some((sha) => sha !== undefined && !/^[a-f0-9]{40}$/.test(sha))) throw new Error("Invalid comment commit");
    return { path: text(comment.path, "path"), line: positiveInteger(comment.line, "line"), side: comment.side, body: text(comment.body, "comment"), ...(id ? { id } : {}), ...(commitId ? { commitId } : {}), ...(baseCommitId ? { baseCommitId } : {}), ...(comment.reanchor === true ? { reanchor: true } : {}) };
  });
  const ids = comments.flatMap((comment) => comment.id ? [comment.id] : []);
  if (new Set(ids).size !== ids.length) throw new Error("Duplicate review comment IDs");
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

/** Store personal follow-ups without letting clients prune snapshots or invent thread identities. */
async function followUpsResponse(request: Request, storage: Storage, scope: string, github?: GitHub, repo?: string, number?: string): Promise<Response> {
  if (request.method === "GET") return json(followUps(storage, scope));
  if (request.method !== "POST") return failure("Method not allowed", 405);
  const body = await readBody(request);
  if (typeof body.enabled !== "boolean") throw new Error("Invalid follow-up state");
  if (body.type === "hunk") {
    const identity = changeIdentity(body);
    if (identity.kind) throw new Error("Follow-ups apply to hunks, not whole files");
    const head = text(body.head, "head");
    if (!/^[a-f0-9]{40,64}$/.test(head)) throw new Error("Invalid head");
    return json(await followUpHunk(storage, scope, identity, head, body.enabled));
  }
  if (body.type !== "thread" || typeof body.id !== "string" || !/^(local:[a-f0-9-]{36}|github:\d+)$/.test(body.id)) throw new Error("Invalid thread follow-up");
  const existing = followUps(storage, scope).find((item) => item.type === "thread" && item.id === body.id);
  if (!body.enabled && existing?.type === "thread") return json(await followUpThread(storage, scope, existing, false));
  if (body.id.startsWith("local:")) {
    const discussion = await readDiscussion(storage, scope);
    const thread = discussion.threads.find((entry) => `local:${entry.id}` === body.id);
    if (!thread) throw new Error("Thread not found");
    return json(await followUpThread(storage, scope, { type: "thread", id: body.id, location: thread.anchor, label: thread.messages[0]?.body.slice(0, 120) || "Local thread" }, body.enabled));
  }
  if (!github || !repo || !number) throw new Error("Open this thread in its PR");
  const conversation = await github.conversation(repo, number);
  const thread = conversation.inline.find((entry) => !entry.in_reply_to_id && `github:${entry.id}` === body.id);
  if (!thread?.path) throw new Error("Thread not found");
  return json(await followUpThread(storage, scope, { type: "thread", id: body.id, label: thread.body.slice(0, 120), location: { path: thread.path, line: thread.line ?? thread.original_line ?? 1, side: thread.side ?? "RIGHT" } }, body.enabled));
}

/** Accept only bounded personal-state commands, never arbitrary database fields. */
function inboxAction(body: Record<string, unknown>): InboxAction {
  const action = body.action;
  if (action === "set") {
    const value = body.personal as Record<string, unknown> | undefined;
    if (!value || typeof value.archived !== "boolean" ||
      ![value.snoozeUntil, value.restoredUntil].every((timestamp) => typeof timestamp === "number" && Number.isSafeInteger(timestamp) && timestamp >= 0 && timestamp <= Date.now() + 8 * 86_400_000)) throw new Error("Invalid personal inbox state");
    return { action, personal: { archived: value.archived, snoozeUntil: value.snoozeUntil as number, restoredUntil: value.restoredUntil as number } };
  }
  if (action === "archive" || action === "restore" || action === "unsnooze") return { action };
  if (action === "snooze") return { action };
  if (action === "undo" && typeof body.token === "string") return { action, token: body.token };
  throw new Error("Invalid inbox action");
}

/** Fail startup rather than silently broadening an invalid public-origin setting. */
function configuredPublicOrigin(value?: string): URL | undefined {
  if (value === undefined) return;
  const url = URL.canParse(value) ? new URL(value) : undefined;
  if (!url || url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash || url.hostname.includes("*")) {
    throw new Error("BIFF_PUBLIC_ORIGIN must be an HTTPS origin without credentials, a path, query, fragment, or wildcard");
  }
  return url;
}
