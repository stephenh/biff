import { commentReads, commentReadSnapshot } from "../server/reviewStore";
import { describe, expect, it } from "bun:test";
import { conversationActivity, relevantComments, commentReadKey } from "../shared/commentActivity";
import { autoReadComments } from "../server/commentReadsApi";
import { Storage } from "../server/storage";
import type { Conversation } from "../shared/types";
import { createApi } from "../server/api";
import { GitHub } from "../server/github";
import { Workspaces } from "../server/workspaces";

describe("commentActivity", () => {
  it("persists bot receipts alongside existing human receipts", async () => {
    // Given a saved human receipt and newly loaded bot comments
    const storage = new Storage();
    await commentReads(storage, "example/repo/1", ["general:9"]);

    try {
      // When the backend acknowledges automatic comments twice
      await autoReadComments(storage, "example/repo/1", conversationActivity(discussion()));
      await autoReadComments(storage, "example/repo/1", conversationActivity(discussion()));

      // Then a fresh store reader sees deduplicated durable receipts
      expect(commentReadSnapshot(storage, "example/repo/1")).toEqual(["general:9", "general:1", "general:3"]);
    } finally { await storage.close(); }
  });

  it("uses persisted receipts to exclude bots while keeping human feedback unread", async () => {
    // Given bot bookkeeping alongside human feedback on the reader's PR
    const storage = new Storage();
    const events = conversationActivity(discussion());

    try {
      // When the backend loads the discussion and its receipts
      await autoReadComments(storage, "example/repo/1", events);
      const reads = new Set(await commentReads(storage, "example/repo/1"));

      // Then ordinary receipt membership leaves only the human comment unread
      expect(relevantComments(events, "author", "author").filter((event) => !reads.has(commentReadKey(event))).map((event) => event.key)).toEqual(["general:2"]);
    } finally { await storage.close(); }
  });
  it("loading a conversation makes bot receipts available through the read API", async () => {
    // Given a real API backed by SQLite and a stubbed GitHub discussion
    const storage = new Storage();
    const github = new GitHub(async (args) => {
      if (args[2] === "user") return JSON.stringify({ login: "author" });
      if (args[2] === "graphql") return JSON.stringify([{ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } }]);
      return JSON.stringify([args[2].includes("/issues/") ? discussion().comments : []]);
    });
    const api = createApi({ github, workspaces: new Workspaces(storage), storage });

    try {
      // When the conversation endpoint loads the bot messages
      await api(new Request("http://127.0.0.1:4567/api/github/pr/example/repo/1/conversation"));
      const response = await api(new Request("http://127.0.0.1:4567/api/github/pr/example/repo/1/comment-reads"));

      // Then consumers receive ordinary persisted read receipts
      expect(await response.json()).toEqual(["general:1", "general:3"]);
    } finally { await storage.close(); }
  });
});

/** Keep human feedback beside both auto-read bots to verify per-message receipts. */
function discussion(): Conversation {
  return { inline: [], reviews: [], comments: [
    { id: 1, body: "Linked Linear issue", user: { login: "linear-code[bot]" }, html_url: "" },
    { id: 2, body: "Please check this", user: { login: "teammate" }, html_url: "" },
    { id: 3, body: "Audit report", user: { login: "homebound-team-bot" }, html_url: "" },
  ] };
}
