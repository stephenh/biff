import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createApi } from "../server/api";
import { GitHub } from "../server/github";
import { Progress } from "../server/progress";
import { Storage } from "../server/storage";
import { Workspaces } from "../server/workspaces";
import type { DiscussionComment } from "../shared/types";

describe("threadActions", () => {
  let storage: Storage;
  let progress: Progress;
  let api: ReturnType<typeof createApi>;
  let resolved: boolean;
  let fail: boolean;
  let owner: string;
  let canResolve: boolean;
  let deleted: number[];

  beforeEach(() => {
    storage = new Storage();
    progress = new Progress(storage);
    resolved = false;
    fail = false;
    owner = "reader";
    canResolve = true;
    deleted = [];
    const github = new GitHub(async (args) => {
      if (args[2] === "user") return JSON.stringify({ login: "reader" });
      if (args[2] === "graphql") {
        const query = args.find((arg) => arg.startsWith("query="))!;
        if (query.includes("mutation")) {
          if (fail) throw new Error("GitHub unavailable");
          resolved = !query.includes("unresolveReviewThread");
          return JSON.stringify({ data: { [resolved ? "resolveReviewThread" : "unresolveReviewThread"]: { thread: { id: "THREAD", isResolved: resolved, viewerCanResolve: !resolved, viewerCanUnresolve: resolved } } } });
        }
        return JSON.stringify([{ data: { repository: { pullRequest: { reviewThreads: { nodes: [{ id: "THREAD", isResolved: resolved, viewerCanResolve: canResolve, viewerCanUnresolve: true, comments: { nodes: [{ databaseId: 1 }] } }] } } } } }]);
      }
      const comments: DiscussionComment[] = [
        { id: 1, body: "Root", user: { login: owner }, html_url: "", path: "file.ts", line: 1 },
        { id: 2, body: "Reply", user: { login: "reader" }, html_url: "", in_reply_to_id: 1 },
        { id: 3, body: "New reply", user: { login: "teammate" }, html_url: "", in_reply_to_id: 1 },
      ];
      return JSON.stringify([args[2].includes("/pulls/1/comments?") ? comments.filter((comment) => !deleted.includes(comment.id)) : []]);
    });
    api = createApi({ github, progress, workspaces: new Workspaces(storage) });
  });
  afterEach(async () => { await storage.close(); });

  it("resolving directly through the API records the displayed message receipts", async () => {
    // Given a thread with a reply newer than the reader's snapshot
    // When a caller resolves without a separate read request
    await act({ resolved: true, keys: ["github:1", "github:2"] });

    // Then only the displayed messages have persisted receipts
    expect(progress.commentReadSnapshot("example/repo/1")).toEqual(["github:1", "github:2"]);
  });

  it("completing an owned thread resolves it on GitHub", async () => {
    // Given the reader authored the root message
    // When the backend receives a completion intent without an ownership claim
    await act({ action: "complete", keys: ["github:1", "github:2"] });

    // Then GitHub reflects the resolution
    expect(resolved).toBe(true);
  });

  it("completing another person's thread does not resolve it", async () => {
    // Given the reader only replied to somebody else's root
    owner = "teammate";

    // When the reader completes the thread
    await act({ action: "complete", keys: ["github:1", "github:2"] });

    // Then the backend leaves GitHub resolution unchanged
    expect(resolved).toBe(false);
  });

  it("completion acknowledges comments even without resolution permission", async () => {
    // Given the reader cannot resolve the thread
    canResolve = false;

    // When the reader completes it
    await act({ action: "complete", keys: ["github:1", "github:2"] });

    // Then displayed comments are acknowledged without needing a second request
    expect(progress.commentReadSnapshot("example/repo/1")).toEqual(["github:1", "github:2"]);
  });

  it("a failed resolution does not acknowledge the thread", async () => {
    // Given GitHub rejects the resolution
    fail = true;

    // When resolution is attempted
    await act({ resolved: true, keys: ["github:1"] });

    // Then the failed action has no read receipts
    expect(progress.commentReadSnapshot("example/repo/1")).toEqual([]);
  });

  it("retrying an already-resolved action retains its original read snapshot", async () => {
    // Given GitHub acknowledged an earlier attempt before its client received the response
    resolved = true;

    // When the same displayed-message snapshot is retried
    await act({ resolved: true, keys: ["github:1", "github:2"] });

    // Then the later reply remains unread
    expect(progress.commentReadSnapshot("example/repo/1")).toEqual(["github:1", "github:2"]);
  });

  it("returns acknowledged resolution permissions with the updated read snapshot", async () => {
    // Given an unresolved thread whose resolution enables reopening
    // When it is resolved
    const response = await act({ resolved: true, keys: ["github:1"] });

    // Then the client receives authoritative post-mutation permissions
    expect((await response.json()).inline[0].reviewThread).toEqual({ id: "THREAD", resolved: true, canResolve: false, canReopen: true });
  });

  it("a deleted displayed reply does not reject the remaining read receipts", async () => {
    // Given the reader saw messages 1 and 2
    const keys = ["github:1", "github:2"];
    // And message 2 was deleted while the newer message 3 remains
    deleted = [2];

    // When the original displayed-message snapshot is acknowledged
    await act({ action: "complete", keys });

    // Then the displayed IDs are recorded and the unseen reply stays unread
    expect(progress.commentReadSnapshot("example/repo/1")).toEqual(keys);
  });

  /** Exercise the real API contract, validation, GitHub adapter, and SQLite receipt store. */
  async function act(body: Record<string, unknown>) {
    return api(new Request("http://127.0.0.1:4567/api/github/pr/example/repo/1/thread", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: "THREAD", ...body }) }));
  }
});
