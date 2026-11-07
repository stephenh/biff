import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { PullRequestReads } from "../server/pullRequestReads";
import { PrActivity } from "../server/prActivity";
import { Storage } from "../server/storage";
import { createApi } from "../server/api";
import { GitHub } from "../server/github";
import { Workspaces } from "../server/workspaces";
import { startReviewReconciliation } from "../server/reviewReconciliation";
import type { Conversation, PullRequest, PullRequestStatus } from "../shared/types";
import { reviewWaitingStatus } from "../server/reviewChanges";

describe("pullRequestReads", () => {
  let storage: Storage;
  let reads: PullRequestReads;
  let now: number;
  let source: ReturnType<typeof fixture>;
  const scope = "example/repo/1";

  beforeEach(() => {
    storage = new Storage();
    now = Date.now();
    source = fixture();
    reads = new PullRequestReads(storage, source, () => now);
  });
  afterEach(async () => { await reads.drain(); await storage.close(); });

  it("warm API reads return while GitHub and review reconciliation are held", async () => {
    // Given saved PR resources and an unrelated held reconciliation prerequisite
    await reads.refresh("example/repo", "1");
    const held = Promise.withResolvers<void>();
    startReviewReconciliation(storage, scope, { head: "head", base: "base" }, [], async () => { await held.promise; });
    // And all future remote reads are held
    source.fetchConversation = async () => { await held.promise; return conversation(); };
    now += 120_001;
    const api = createApi({ storage, github: new GitHub(undefined, storage), workspaces: new Workspaces(storage), prReads: reads });
    try {
      // When the browser requests its saved conversation
      const response = await api(new Request(`http://127.0.0.1:4567/api/github/pr/${scope}/conversation`));
      // Then it receives real content without waiting for either remote work or reconciliation
      expect(await response.json()).toMatchObject({ comments: [{ body: "Saved feedback" }], sync: { refreshing: true } });
    } finally { held.resolve(); }
  });

  it("cold reads report pending rather than inventing an empty conversation", async () => {
    // Given a PR with no saved snapshot and a held first fetch
    const held = Promise.withResolvers<Conversation>();
    source.fetchConversation = () => held.promise;
    try {
      // When the conversation is requested
      const response = await reads.read("example/repo", "1", "conversation");
      // Then the response explicitly describes the missing snapshot
      expect(await response.json()).toEqual({ sync: { updatedAt: null, refreshing: true } });
    } finally { held.resolve(conversation()); }
  });

  it("cold reads use HTTP 202", async () => {
    // Given an unknown PR
    // When its overview is requested
    const response = await reads.read("example/repo", "1", "metadata");
    // Then clients can distinguish initial preparation from a complete snapshot
    expect(response.status).toEqual(202);
  });

  it("reconstructs coordinates, permissions, bot identity, and review summaries", async () => {
    // Given a complete remote discussion
    await reads.refresh("example/repo", "1");
    // When the saved discussion is read without GitHub
    const response = await reads.read("example/repo", "1", "conversation");
    // Then the existing conversation contract retains the information needed by the viewer
    expect(await response.json()).toMatchObject({
      comments: [{ body: "Saved feedback", user: { login: "bot", type: "Bot" } }],
      inline: [{ id: 2, path: "src/file.ts", line: 3, original_line: 2, side: "RIGHT", commit_id: "head",
        reviewThread: { id: "thread", resolved: false, canResolve: true, canReopen: true } }],
      reviews: [{ id: 3, body: "Looks good", state: "APPROVED", commit_id: "head" }], viewer: "me",
    });
  });

  it("all resource reads share one in-flight refresh", async () => {
    // Given a held first refresh
    const held = Promise.withResolvers<Conversation>();
    let calls = 0;
    source.fetchConversation = () => { calls++; return held.promise; };
    try {
      // When multiple tabs request different projections of the same PR
      await Promise.all([reads.read("Example/Repo", "1", "metadata"), reads.read("example/repo", "1", "status"), reads.read("example/repo", "1", "conversation", true)]);
      // Then only one discussion download is admitted
      expect(calls).toEqual(1);
    } finally { held.resolve(conversation()); }
  });

  it("fresh local polling makes no additional GitHub calls", async () => {
    // Given a complete fresh snapshot
    await reads.refresh("example/repo", "1");
    let calls = 0;
    source.fetchConversation = async () => { calls++; return conversation(); };
    // When the browser polls all resources
    await Promise.all([reads.read("example/repo", "1", "metadata"), reads.read("example/repo", "1", "status"), reads.read("example/repo", "1", "conversation")]);
    // Then polling stays entirely local
    expect(calls).toEqual(0);
  });

  it("a failed discussion fetch retains the complete saved conversation", async () => {
    // Given saved feedback and a later GitHub failure
    await reads.refresh("example/repo", "1");
    source.fetchConversation = async () => { throw new Error("GitHub offline"); };
    now += 120_001;
    // When the refresh fails
    await reads.refresh("example/repo", "1");
    const response = await reads.read("example/repo", "1", "conversation");
    // Then failure is visible beside the last good content
    expect(await response.json()).toMatchObject({ comments: [{ body: "Saved feedback" }], sync: { refreshing: false, error: "GitHub offline" } });
  });

  it("failed cold loads do not retry on every browser poll", async () => {
    // Given a failed initial request
    let calls = 0;
    source.fetchConversation = async () => { calls++; throw new Error("Unavailable"); };
    await reads.refresh("example/repo", "1");
    // When several tabs poll the missing conversation
    await Promise.all([reads.read("example/repo", "1", "conversation"), reads.read("example/repo", "1", "conversation")]);
    await reads.drain();
    // Then the cooldown prevents another remote attempt
    expect(calls).toEqual(1);
  });

  it("explicit Retry bypasses a failed refresh cooldown", async () => {
    // Given a failed cold load
    source.fetchConversation = async () => { throw new Error("Unavailable"); };
    await reads.refresh("example/repo", "1");
    // And GitHub has recovered
    source.fetchConversation = async () => conversation();
    // When the reader retries
    await reads.read("example/repo", "1", "conversation", true);
    await reads.drain();
    const response = await reads.read("example/repo", "1", "conversation");
    // Then the saved snapshot replaces the failure
    expect(await response.json()).toMatchObject({ sync: { refreshing: false, updatedAt: now }, comments: [{ body: "Saved feedback" }] });
  });

  it("a failed status read does not withhold a successfully fetched overview", async () => {
    // Given GitHub status is unavailable but overview metadata is accessible
    source.status = async () => { throw new Error("Status unavailable"); };
    // When the background refresh finishes
    await reads.refresh("example/repo", "1");
    const response = await reads.read("example/repo", "1", "metadata");
    // Then overview content is available with the independent refresh failure
    expect(await response.json()).toMatchObject({ title: "A saved PR", body: "PR description", sync: { error: "Status unavailable" } });
  });

  it("a held fetch cannot overwrite an acknowledged edit", async () => {
    // Given a saved comment and an older full fetch held in flight
    await reads.refresh("example/repo", "1");
    const held = Promise.withResolvers<Conversation>();
    const started = Promise.withResolvers<void>();
    source.fetchConversation = () => { started.resolve(); return held.promise; };
    const task = reads.refresh("example/repo", "1");
    await started.promise;
    // And the user has successfully edited its canonical text
    new PrActivity(storage.db).changeComment(scope, 1, "general", "Acknowledged edit");
    // When the older response arrives
    held.resolve(conversation());
    await task;
    const response = await reads.read("example/repo", "1", "conversation");
    // Then the acknowledged edit remains visible
    expect(await response.json()).toMatchObject({ comments: [{ body: "Acknowledged edit" }] });
  });

  it("a held fetch cannot delete a newly acknowledged publication", async () => {
    // Given a saved conversation and an older complete fetch
    await reads.refresh("example/repo", "1");
    const held = Promise.withResolvers<Conversation>();
    const started = Promise.withResolvers<void>();
    source.fetchConversation = () => { started.resolve(); return held.promise; };
    const task = reads.refresh("example/repo", "1");
    await started.promise;
    // And a newer comment has been acknowledged
    new PrActivity(storage.db).comment(scope, { id: 4, body: "Just published", user: { login: "me" }, html_url: "https://github.com/comment/4" }, "issue_comment");
    // When the response without that comment arrives
    held.resolve(conversation());
    await task;
    // Then the publication remains present in the local read model
    expect(new PrActivity(storage.db).readConversation(storage, scope, "me").comments.map((comment) => comment.body)).toEqual(["Saved feedback", "Just published"]);
  });

  it("acknowledged thread resolution wins over a held refresh", async () => {
    // Given a complete conversation and a held older refresh
    await reads.refresh("example/repo", "1");
    const held = Promise.withResolvers<Conversation>();
    const started = Promise.withResolvers<void>();
    source.fetchConversation = () => { started.resolve(); return held.promise; };
    const task = reads.refresh("example/repo", "1");
    await started.promise;
    // And GitHub has acknowledged resolution
    new PrActivity(storage.db).resolution(scope, { id: "thread", resolved: true, canResolve: false, canReopen: true });
    // When the older unresolved snapshot arrives
    held.resolve(conversation());
    await task;
    // Then cached readers retain the resolution receipt
    expect(new PrActivity(storage.db).readConversation(storage, scope, "me").inline[0]?.reviewThread).toEqual({ id: "thread", resolved: true, canResolve: false, canReopen: true });
  });

  it("complete snapshots and refresh errors survive reopening SQLite", async () => {
    // Given an on-disk snapshot followed by an unsuccessful refresh
    const directory = await mkdtemp("/tmp/opencode/biff-pr-reads-");
    await storage.close();
    storage = new Storage(`${directory}/state.sqlite`);
    reads = new PullRequestReads(storage, source, () => now);
    try {
      await reads.refresh("example/repo", "1");
      source.fetchConversation = async () => { throw new Error("Offline"); };
      await reads.refresh("example/repo", "1");
      // When the server restarts
      await storage.close();
      storage = new Storage(`${directory}/state.sqlite`);
      reads = new PullRequestReads(storage, source, () => now);
      const response = await reads.read("example/repo", "1", "conversation");
      // Then cached content and its failed-refresh status need no new remote request
      expect(await response.json()).toMatchObject({ comments: [{ body: "Saved feedback" }], sync: { error: "Offline", refreshing: false } });
    } finally { await reads.drain(); await storage.close(); storage = new Storage(); await rm(directory, { recursive: true, force: true }); }
  });

  it("another account cannot inherit cached thread permissions", async () => {
    // Given cached permissions for the original account
    await reads.refresh("example/repo", "1");
    // And the daemon now uses another account
    source.viewerLogin = async () => "other";
    const held = Promise.withResolvers<Conversation>();
    source.fetchConversation = () => held.promise;
    try {
      // When the other account reads saved text during revalidation
      const response = await reads.read("example/repo", "1", "conversation");
      const body = await response.json() as Conversation;
      // Then the prior account's capabilities are not exposed
      expect(body.inline[0]?.reviewThread).toEqual(undefined);
    } finally { held.resolve(conversation()); }
  });

  it("a PR-page refresh observes an author handoff submitted directly on GitHub", async () => {
    // Given a complete Comment review on the current head
    const discussion = conversation();
    discussion.reviews[0].state = "COMMENTED";
    source.fetchConversation = async () => discussion;
    // When the PR page refreshes without the inbox being open
    await reads.refresh("example/repo", "1");
    // Then that refresh establishes the same durable author handoff
    expect(reviewWaitingStatus(storage.db, scope, "me").waitingOnAuthor).toEqual(true);
  });

  it("closure observed by the PR page permanently ends Waiting", async () => {
    // Given a handoff already observed by the PR page
    const discussion = conversation();
    discussion.reviews[0].state = "COMMENTED";
    source.fetchConversation = async () => discussion;
    await reads.refresh("example/repo", "1");
    const pr = await source.pullRequest();
    // And GitHub closes the PR
    source.pullRequest = async () => ({ ...pr, state: "closed" });
    await reads.refresh("example/repo", "1");
    // When the PR is reopened without another review
    source.pullRequest = async () => pr;
    await reads.refresh("example/repo", "1");
    // Then the old review cannot resurrect its completed handoff
    expect(reviewWaitingStatus(storage.db, scope, "me").waitingOnAuthor ?? false).toEqual(false);
  });
});

/** Keep the external boundary controllable while all persistence and API reads are real. */
function fixture() {
  return {
    viewerLogin: async () => "me",
    pullRequest: async (): Promise<PullRequest> => ({ number: 1, title: "A saved PR", body: "PR description", html_url: "https://github.com/example/repo/pull/1",
      state: "open", draft: false, user: { login: "author" }, head: { sha: "head", ref: "feature" }, base: { sha: "base", ref: "main" } }),
    status: async (): Promise<PullRequestStatus> => ({ reviewDecision: "APPROVED", checks: "Passing", approvers: ["me"], reviewRequested: false }),
    fetchConversation: async (): Promise<Conversation> => conversation(),
    threadSync: undefined,
  };
}

/** Include remote-only coordinates and capabilities that the old event-only cache could not render. */
function conversation(): Conversation {
  return { comments: [{ id: 1, body: "Saved feedback", user: { login: "bot", type: "Bot" }, html_url: "https://github.com/comment/1" }],
    inline: [{ id: 2, body: "Inline feedback", user: { login: "me" }, html_url: "https://github.com/comment/2", path: "src/file.ts", line: 3, original_line: 2, side: "RIGHT", commit_id: "head",
      reviewThread: { id: "thread", resolved: false, canResolve: true, canReopen: true } }],
    reviews: [{ id: 3, body: "Looks good", user: { login: "me" }, html_url: "https://github.com/review/3", state: "APPROVED", commit_id: "head", submitted_at: "2026-11-06T12:00:00Z" }], viewer: "me" };
}
