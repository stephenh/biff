import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createApi } from "../server/api";
import { GitHub } from "../server/github";
import { Storage } from "../server/storage";
import { Workspaces } from "../server/workspaces";
import { PrActivity } from "../server/prActivity";
import { isCommentResolved } from "../shared/commentActivity";
import type { Conversation, DiscussionComment } from "../shared/types";

describe("prCommentResolutions", () => {
  let storage: Storage;
  let api: ReturnType<typeof createApi>;
  const url = "http://127.0.0.1:4567/api/github/pr/example/repo/1";
  const comments: DiscussionComment[] = [
    { id: 1, body: "Linear issue", user: { login: "linear-code[bot]" }, html_url: "" },
    { id: 2, body: "Audit passed", user: { login: "homebound-team-bot" }, html_url: "" },
    { id: 3, body: "Preview", user: { login: "homebound-team-bot" }, html_url: "" },
    { id: 4, body: "Question", user: { login: "alice" }, html_url: "" },
  ];

  beforeEach(() => {
    storage = new Storage();
    const github = new GitHub(async (args) => {
      if (args[2] === "user") return JSON.stringify({ login: "me" });
      if (args[2] === "graphql") return JSON.stringify([{ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } }]);
      return JSON.stringify([args[2].includes("/issues/1/comments") ? comments : []]);
    });
    api = createApi({ github, storage, workspaces: new Workspaces(storage) });
  });
  afterEach(async () => { await storage.close(); });

  it("defaults automated PR comments to resolved without collapsing human comments", () => {
    // Given the three automated comments and one human comment
    // When deriving their initial Biff resolution
    const resolved = comments.map(isCommentResolved);

    // Then only automated comments start collapsed
    expect(resolved).toEqual([true, true, true, false]);
  });

  it("retains an explicit bot reopen when the conversation is fetched again", async () => {
    // Given an automatically resolved bot comment
    // When reopening it through Biff's API
    await api(new Request(`${url}/comment-resolution`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: 1, resolved: false }) }));
    new PrActivity(storage.db).conversation("example/repo/1", { comments, inline: [], reviews: [] });
    const response = await api(new Request(`${url}/conversation`));
    const conversation = await response.json() as Conversation;

    // Then the saved reopen overrides its automatic default
    expect(conversation.comments.map(isCommentResolved)).toEqual([false, true, true, false]);
  });

  it("persists a human comment's resolution", async () => {
    // Given an unresolved human comment
    // When resolving it through Biff's API
    await api(new Request(`${url}/comment-resolution`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: 4, resolved: true }) }));
    const response = await api(new Request(`${url}/conversation`));
    const conversation = await response.json() as Conversation;

    // Then fetching the conversation returns the durable choice
    expect(conversation.comments.find((comment) => comment.id === 4)?.biffResolved).toBe(true);
  });

  it("rejects comments outside the requested PR", async () => {
    // Given no comment with this ID in the PR
    // When a caller tries to resolve it
    const response = await api(new Request(`${url}/comment-resolution`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: 999, resolved: true }) }));

    // Then the API rejects the unrelated comment
    expect(response.status).toBe(400);
  });
});
