import { readDiscussion, updateDiscussion } from "../server/discussionThreads";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createApi } from "../server/api";
import { runCommand, type RunCommand } from "../server/commands";
import { GitHub } from "../server/github";
import { Reviews } from "../server/reviews";
import { Workspaces } from "../server/workspaces";
import { Storage } from "../server/storage";
import type { Discussion } from "../shared/discussion";
import type { ReviewSession } from "../shared/localReview";
import type { DiscussionComment, LocalReview } from "../shared/types";
import { createTwoFilesPatch } from "diff";

describe("discussion", () => {
  let directory: string;
  let storage: Storage;
  let api: ReturnType<typeof createApi>;
  let snapshot: LocalReview;
  let local: string;
  let published: DiscussionComment[];
  let remoteHead: string;
  let remoteOld: string;
  let remoteBase: string;
  let loseResponse: boolean;
  let rejectChanges: boolean;
  let threadResolved: boolean;
  let rejectResolution: boolean;
  let publicationGate: Promise<void> | undefined;
  let publicationStarted: (() => void) | undefined;
  const oldText = "const first = 1;\nconst second = 2;\n";
  const newText = "const first = 10;\nconst second = 20;\n";
  const pr = "/api/github/pr/example/project/12";

  beforeEach(async () => {
    directory = await mkdtemp("/tmp/opencode/biff-discussion-");
    await runCommand(["jj", "git", "init"], { cwd: directory });
    await writeFile(`${directory}/file.ts`, oldText);
    await runCommand(["jj", "bookmark", "create", "main"], { cwd: directory });
    await runCommand(["jj", "config", "set", "--repo", 'revset-aliases."trunk()"', "main"], { cwd: directory });
    await runCommand(["jj", "new"], { cwd: directory });
    await writeFile(`${directory}/file.ts`, newText);
    await runCommand(["jj", "bookmark", "create", "feature"], { cwd: directory });
    storage = new Storage(`${directory}/.jj/biff.sqlite`);
    const workspaces = new Workspaces(storage);
    const workspace = await workspaces.add(directory);
    api = createApi({ workspaces, github: new GitHub(githubFixture, storage), storage, reviews: new Reviews(storage) });
    snapshot = await request(`/api/workspaces/${workspace.id}/review?bookmark=feature`);
    local = `/api/workspaces/${workspace.id}/changes/${snapshot.progressScope}`;
    published = [];
    remoteHead = snapshot.selected.commit_id;
    remoteOld = oldText;
    remoteBase = snapshot.base!.commit_id;
    loseResponse = false;
    rejectChanges = false;
    threadResolved = false;
    rejectResolution = false;
    publicationGate = undefined;
    publicationStarted = undefined;
  });

  afterEach(async () => { await storage.close(); await rm(directory, { recursive: true, force: true }); });

  /** Serve a GitHub-shaped stateful fixture; no test can publish to a real repository. */
  async function githubFixture(args: string[], options?: Parameters<RunCommand>[1]): Promise<string> {
    const path = args[2];
    if (path === "user") return JSON.stringify({ login: "reviewer" });
    if (path === "graphql") {
      const query = args.find((arg) => arg.startsWith("query="))!;
      if (query.includes("reviewThreads(")) return JSON.stringify([{ data: { repository: { pullRequest: { reviewThreads: { nodes: published.filter((entry) => !entry.in_reply_to_id).map((entry) => ({ id: `THREAD_${entry.id}`, isResolved: threadResolved, viewerCanResolve: true, viewerCanUnresolve: true, comments: { nodes: [{ databaseId: entry.id }] } })) } } } } }]);
      if (query.includes("p0: repository")) return JSON.stringify({ data: { p0: { pullRequest: {
        number: 12, title: "Test PR", url: "https://github.com/example/project/pull/12", repository: { nameWithOwner: "example/project" },
        author: { login: "author" }, isDraft: false, updatedAt: "2026-10-26T00:00:00Z", state: "OPEN", closedAt: null, mergedAt: null,
        headRefOid: remoteHead, baseRefOid: remoteBase, reviewDecision: "REVIEW_REQUIRED", reviewRequests: { nodes: [] }, latestOpinionatedReviews: { nodes: [] }, commits: { nodes: [] },
      } } } });
      if (!args.includes("threadId=THREAD_1")) throw new Error("Wrong thread ID");
      if (rejectResolution) throw new Error("GitHub rejected thread resolution");
      threadResolved = !query.includes("unresolveReviewThread(");
      return JSON.stringify({ data: { [threadResolved ? "resolveReviewThread" : "unresolveReviewThread"]: { thread: { id: "THREAD_1", isResolved: threadResolved, viewerCanResolve: !threadResolved, viewerCanUnresolve: threadResolved } } } });
    }
    if (args.includes("PATCH") || args.includes("DELETE")) {
      if (rejectChanges) throw new Error("GitHub rejected this comment change");
      const match = /^repos\/example\/project\/pulls\/comments\/(\d+)$/.exec(path);
      if (!match) throw new Error(`Unexpected comment change: ${path}`);
      const id = Number(match[1]);
      if (args.includes("DELETE")) published = published.filter((entry) => entry.id !== id);
      else published.find((entry) => entry.id === id)!.body = JSON.parse(options!.input!).body;
      return "";
    }
    if (options?.input) {
      const body = JSON.parse(options.input);
      const comment: DiscussionComment = { ...body, id: published.length + 1, user: { login: "reviewer" }, html_url: `https://github.com/example/project/pull/12#discussion_r${published.length + 1}` };
      const reply = /\/comments\/(\d+)\/replies$/.exec(path);
      if (reply) comment.in_reply_to_id = Number(reply[1]);
      else if (path !== "repos/example/project/pulls/12/comments") throw new Error(`Unexpected write: ${path}`);
      published.push(comment);
      publicationStarted?.();
      await publicationGate;
      if (loseResponse) { loseResponse = false; throw new Error("Connection lost after GitHub accepted the comment"); }
      return JSON.stringify(comment);
    }
    if (path === "repos/example/project/pulls/12") return JSON.stringify({ state: "open", number: 12, head: { sha: remoteHead }, base: { sha: remoteBase } });
    if (path.startsWith("repos/example/project/pulls/12/commits")) return JSON.stringify([[{ sha: remoteHead }]]);
    if (path.startsWith("repos/example/project/pulls/12/comments")) return JSON.stringify([published]);
    if (path.startsWith("repos/example/project/issues/12/comments") || path.startsWith("repos/example/project/pulls/12/reviews")) return JSON.stringify([[]]);
    if (path.startsWith("repos/example/project/compare/")) return args.includes("Accept: application/vnd.github.diff") ? createTwoFilesPatch("file.ts", "file.ts", path.includes(`${remoteBase}...`) ? remoteOld : oldText, newText) : JSON.stringify({ merge_base_commit: { sha: remoteBase } });
    if (path.startsWith("repos/example/project/contents/file.ts?ref=")) return path.endsWith(snapshot.base!.commit_id) ? remoteOld : newText;
    throw new Error(`Unexpected GitHub request: ${args.join(" ")}`);
  }

  /** Exercise API validation, storage aliases, and publication boundaries together. */
  async function request<T>(path: string, body?: unknown): Promise<T> {
    const response = await api(new Request(`http://127.0.0.1:4567${path}`, body === undefined ? undefined : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    return result;
  }

  /** Create a local ranged note on an immutable bookmark snapshot. */
  async function comment(): Promise<Discussion> {
    return request(`${local}/discussion`, { action: "create", path: "file.ts", line: 1, endLine: 2, side: "RIGHT", commitId: snapshot.selected.commit_id, baseCommitId: snapshot.base!.commit_id, body: "Please explain these values." });
  }

  test("local comments survive a daemon restart", async () => {
    // Given a locally saved comment
    await comment();

    // When the durable store is reopened
    const restored = await readDiscussion(storage, `jj/${snapshot.workspace.id}/${snapshot.progressScope}`);

    // Then its original snapshot and body are retained
    expect(restored.threads).toMatchObject([{ anchor: { commitId: snapshot.selected.commit_id, baseCommitId: snapshot.base!.commit_id, line: 1, endLine: 2 }, messages: [{ body: "Please explain these values." }] }]);
  });

  test("opening the matching PR shares comments without publishing them", async () => {
    // Given an unpublished local comment
    await comment();

    // When the matching PR establishes its automatic association
    await request(`${pr}/review`);

    // Then GitHub receives no writes
    expect(published).toEqual([]);
  });

  test("the PR view reads the same durable local thread", async () => {
    // Given a local comment before the PR is opened
    const localDiscussion = await comment();

    // When opening its PR and reading its local discussion
    await request(`${pr}/review`);
    const discussion = await request<Discussion>(`${pr}/discussion`);

    // Then both views address exactly the same thread
    expect(discussion.threads).toMatchObject(localDiscussion.threads);
  });

  test("explicit publication records a GitHub receipt for the exact message", async () => {
    // Given a local thread on a linked PR
    const discussion = await comment();
    await request(`${pr}/review`);

    // When the user explicitly publishes it
    const result = await request<Discussion>(`${local}/discussion`, { action: "publish", threadId: discussion.threads[0].id });

    // Then its message is visibly published, with a durable link
    expect(result.threads[0].messages[0].published).toMatchObject({ pr: "example/project/12", id: 1, url: "https://github.com/example/project/pull/12#discussion_r1" });
  });

  test("publication preserves the selected line range", async () => {
    // Given a two-line local comment
    const discussion = await comment();
    await request(`${pr}/review`);

    // When publishing the thread
    await request(`${local}/discussion`, { action: "publish", threadId: discussion.threads[0].id });

    // Then GitHub receives the complete range on the correct side
    expect(published[0]).toMatchObject({ path: "file.ts", start_line: 1, start_side: "RIGHT", line: 2, side: "RIGHT" });
  });

  test("new replies to a published thread remain local", async () => {
    // Given a published root comment
    const discussion = await comment();
    await request(`${pr}/review`);
    await request(`${local}/discussion`, { action: "publish", threadId: discussion.threads[0].id });

    // When saving another reply locally
    const result = await request<Discussion>(`${local}/discussion`, { action: "reply", threadId: discussion.threads[0].id, body: "Also consider zero." });

    // Then the new reply has no publication receipt
    expect(result.threads[0].messages[1].published).toBeUndefined();
  });

  test("lost publication responses remain explicitly unconfirmed", async () => {
    // Given a publication whose GitHub response will be lost
    const discussion = await comment();
    await request(`${pr}/review`);
    loseResponse = true;

    // When publishing the comment
    const result = await request<Discussion>(`${local}/discussion`, { action: "publish", threadId: discussion.threads[0].id });

    // Then it is not mislabeled as definitely unpublished
    expect(result.threads[0].messages[0].publicationPending).toBe(true);
  });

  test("retrying an interrupted publication does not duplicate the GitHub comment", async () => {
    // Given a comment accepted by GitHub whose response was lost
    const discussion = await comment();
    await request(`${pr}/review`);
    loseResponse = true;
    await request(`${local}/discussion`, { action: "publish", threadId: discussion.threads[0].id });

    // When the user retries publication
    await request(`${pr}/discussion`, { action: "publish", threadId: discussion.threads[0].id });

    // Then the existing remote comment is recovered rather than reposted
    expect(published).toHaveLength(1);
  });

  test("an unchanged hunk remains publishable after the head changes", async () => {
    // Given a local thread and a PR that has moved to another commit
    const discussion = await comment();
    await request(`${pr}/review`);
    remoteHead = "a".repeat(40);

    // When publishing the old thread
    await request(`${local}/discussion`, { action: "publish", threadId: discussion.threads[0].id });

    // Then the comment is published against the new head rather than the original commit
    expect(published).toMatchObject([{ commit_id: remoteHead, line: 2 }]);
  });

  test("a different PR base file cannot receive the local comment", async () => {
    // Given identical head content but different old-side source on the PR
    const discussion = await comment();
    await request(`${pr}/review`);
    remoteOld = "Different base contents\n";
    remoteBase = "d".repeat(40);

    // When publishing the local snapshot's comment
    await request(`${local}/discussion`, { action: "publish", threadId: discussion.threads[0].id });

    // Then the source mismatch prevents publication
    expect(published).toEqual([]);
  });

  test("an attached agent receives comments saved through the ordinary bookmark endpoint", async () => {
    // Given an agent attached to the same bookmark review
    const session = await request<ReviewSession>("/api/reviews", { path: directory, bookmark: "feature", agentSession: "agent-session" });

    // When a user saves a comment without an agent-session URL
    await comment();
    const feedback = await request<ReviewSession>(`/api/reviews/${session.id}/wait`);

    // Then the agent receives that durable user message
    expect(feedback.threads[0].messages.map((message) => message.body)).toEqual(["Please explain these values."]);
  });

  test("agent replies are shared with the bookmark", async () => {
    // Given a shared comment and an attached agent
    const discussion = await comment();
    const session = await request<ReviewSession>("/api/reviews", { path: directory, bookmark: "feature", agentSession: "agent-session" });

    // When the agent replies through its existing protocol
    await request(`/api/reviews/${session.id}/reply`, { threadId: discussion.threads[0].id, body: "These values cover the boundary.", author: "agent" });
    const result = await request<Discussion>(`${local}/discussion`);

    // Then the ordinary bookmark view receives the local agent reply
    expect(result.threads[0].messages[1]).toMatchObject({ author: "agent", body: "These values cover the boundary." });
  });

  test("starting another bookmark lifetime does not inherit old threads", async () => {
    // Given a comment in the current review lifetime
    await comment();

    // When the bookmark starts a new review
    await request(`/api/workspaces/${snapshot.workspace.id}/review`, { bookmark: "feature" });
    const next = await request<LocalReview>(`/api/workspaces/${snapshot.workspace.id}/review?bookmark=feature`);
    const discussion = await request<Discussion>(`/api/workspaces/${snapshot.workspace.id}/changes/${next.progressScope}/discussion`);

    // Then the new work has its own empty discussion
    expect(discussion.threads).toEqual([]);
  });

  test("an agent reply does not inherit the root comment's publication status", async () => {
    // Given a published local thread with an attached agent
    const discussion = await comment();
    await request(`${pr}/review`);
    await request(`${local}/discussion`, { action: "publish", threadId: discussion.threads[0].id });
    const session = await request<ReviewSession>("/api/reviews", { path: directory, bookmark: "feature", agentSession: "agent-session" });

    // When the agent replies to the published root
    await request(`/api/reviews/${session.id}/reply`, { threadId: discussion.threads[0].id, body: "Fixed locally.", author: "agent" });
    const result = await request<Discussion>(`${local}/discussion`);

    // Then its new reply is still local
    expect(result.threads[0].messages[1].published).toBeUndefined();
  });

  test("publishing a new reply reuses the already-published root", async () => {
    // Given a published root and a saved local reply
    const discussion = await comment();
    await request(`${pr}/review`);
    await request(`${local}/discussion`, { action: "publish", threadId: discussion.threads[0].id });
    await request(`${local}/discussion`, { action: "reply", threadId: discussion.threads[0].id, body: "A second note." });

    // When publishing the remaining local message
    await request(`${local}/discussion`, { action: "publish", threadId: discussion.threads[0].id });

    // Then the new remote comment is a reply to the original root
    expect(published[1].in_reply_to_id).toBe(1);
  });

  test("two tabs publishing the same thread create only one GitHub comment", async () => {
    // Given one local thread visible in both linked views
    const discussion = await comment();
    await request(`${pr}/review`);
    const action = { action: "publish", threadId: discussion.threads[0].id };

    // When both tabs publish concurrently
    await Promise.all([request(`${local}/discussion`, action), request(`${pr}/discussion`, action)]);

    // Then serialized receipt checks prevent duplicate publication
    expect(published).toHaveLength(1);
  });

  test("a reply saved during publication is not added to the outgoing batch", async () => {
    // Given a linked thread whose GitHub write is in flight
    const discussion = await comment();
    await request(`${pr}/review`);
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    publicationStarted = started.resolve;
    publicationGate = release.promise;
    const publishing = request(`${local}/discussion`, { action: "publish", threadId: discussion.threads[0].id });
    await started.promise;

    // When another local reply arrives before the remote request finishes
    try { await request(`${local}/discussion`, { action: "reply", threadId: discussion.threads[0].id, body: "Keep this new reply local." }); }
    finally { release.resolve(); }
    await publishing;
    const result = await request<Discussion>(`${local}/discussion`);

    // Then only the original message was published
    expect(result.threads[0].messages[1].published).toBeUndefined();
  });

  test("comments saved locally from the PR view appear in its bookmark review", async () => {
    // Given an automatically associated PR and bookmark
    await request(`${pr}/review`);

    // When saving a PR-side comment locally
    await request(`${pr}/discussion`, { action: "create", path: "file.ts", line: 1, side: "RIGHT", commitId: remoteHead, baseCommitId: snapshot.base!.commit_id, body: "A local PR-side note." });
    const discussion = await request<Discussion>(`${local}/discussion`);

    // Then the bookmark sees the same note
    expect(discussion.threads[0].messages[0].body).toBe("A local PR-side note.");
  });

  test("editing a local comment updates the shared PR discussion", async () => {
    // Given a linked local comment
    const discussion = await comment();
    await request(`${pr}/review`);
    const thread = discussion.threads[0];

    // When the user edits the local message
    await request(`${local}/discussion`, { action: "edit", threadId: thread.id, messageId: thread.messages[0].id, body: "Updated explanation." });
    const saved = await request<Discussion>(`${pr}/discussion`);

    // Then the linked PR view sees the edited body
    expect(saved.threads[0].messages[0].body).toBe("Updated explanation.");
  });

  test("editing a comment wakes the attached agent with the revised message", async () => {
    // Given an agent that has already seen a user comment
    const discussion = await comment();
    const thread = discussion.threads[0];
    const session = await request<ReviewSession>("/api/reviews", { path: directory, bookmark: "feature", agentSession: "agent-session" });

    // When that comment is edited
    await request(`${local}/discussion`, { action: "edit", threadId: thread.id, messageId: thread.messages[0].id, body: "Changed request." });
    const updated = await request<ReviewSession>(`/api/reviews/${session.id}`);

    // Then the revised message advances the agent's feedback cursor
    expect(updated.humanSequence).toBeGreaterThan(session.humanSequence);
  });

  test("deleting the last local comment removes its thread from an attached session", async () => {
    // Given a local comment also visible to an agent
    const discussion = await comment();
    const thread = discussion.threads[0];
    const session = await request<ReviewSession>("/api/reviews", { path: directory, bookmark: "feature", agentSession: "agent-session" });

    // When the user deletes it and the agent updates its acknowledgment
    await request(`${local}/discussion`, { action: "delete", threadId: thread.id, messageId: thread.messages[0].id });
    await request(`/api/reviews/${session.id}/ack`, { sequence: session.sequence });
    const saved = await request<Discussion>(`${local}/discussion`);

    // Then the deleted thread is not resurrected by the session
    expect(saved.threads).toEqual([]);
  });

  test("editing a published local message updates GitHub and preserves its receipt marker", async () => {
    // Given a published Biff comment
    const discussion = await comment();
    const thread = discussion.threads[0];
    await request(`${pr}/review`);
    await request(`${local}/discussion`, { action: "publish", threadId: thread.id });

    // When the user edits it
    await request(`${local}/discussion`, { action: "edit", threadId: thread.id, messageId: thread.messages[0].id, body: "Updated on GitHub." });

    // Then the remote comment has the revised text and original recovery marker
    expect(published[0].body).toBe(`Updated on GitHub.\n\n<!-- biff:${thread.id}:${thread.messages[0].id} -->`);
  });

  test("deleting a published comment through the PR also removes its local copy", async () => {
    // Given a published local comment
    const discussion = await comment();
    await request(`${pr}/review`);
    await request(`${local}/discussion`, { action: "publish", threadId: discussion.threads[0].id });

    // When deleting it through the GitHub discussion endpoint
    await request(`${pr}/comment-edit`, { id: published[0].id, kind: "inline", action: "delete" });
    const saved = await request<Discussion>(`${local}/discussion`);

    // Then the durable discussion no longer contains the deleted message
    expect(saved.threads).toEqual([]);
  });

  test("a rejected GitHub edit leaves the saved local body intact", async () => {
    // Given a published comment whose author permissions no longer allow editing
    const discussion = await comment();
    const thread = discussion.threads[0];
    await request(`${pr}/review`);
    await request(`${local}/discussion`, { action: "publish", threadId: thread.id });
    rejectChanges = true;

    // When the edit fails
    try { await request(`${local}/discussion`, { action: "edit", threadId: thread.id, messageId: thread.messages[0].id, body: "Rejected edit." }); } catch { /* Inspect the persisted state after failure. */ }
    const saved = await request<Discussion>(`${local}/discussion`);

    // Then the local copy retains the last successfully saved body
    expect(saved.threads[0].messages[0].body).toBe("Please explain these values.");
  });

  test("resolving a published local thread also resolves it on GitHub", async () => {
    // Given a published local thread
    const discussion = await comment();
    const thread = discussion.threads[0];
    await request(`${pr}/review`);
    await request(`${local}/discussion`, { action: "publish", threadId: thread.id });

    // When resolving it from the local discussion
    await request(`${local}/discussion`, { action: "resolve", threadId: thread.id, resolved: true });

    // Then GitHub's actual thread is resolved
    expect(threadResolved).toBe(true);
  });

  test("resolving a GitHub thread updates its durable Biff copy", async () => {
    // Given a published local thread
    const discussion = await comment();
    await request(`${pr}/review`);
    await request(`${local}/discussion`, { action: "publish", threadId: discussion.threads[0].id });

    // When resolving it through the GitHub thread endpoint
    await request(`${pr}/thread`, { id: "THREAD_1", resolved: true });
    const saved = await request<Discussion>(`${local}/discussion`);

    // Then the linked local discussion agrees with GitHub
    expect(saved.threads[0].resolved).toBe(true);
  });
  test("local discussion rejects editing an agent message", async () => {
    // Given a shared thread with an agent reply
    const discussion = await comment();
    const session = await request<ReviewSession>("/api/reviews", { path: directory, bookmark: "feature", agentSession: "agent-session" });
    await request(`/api/reviews/${session.id}/reply`, { threadId: discussion.threads[0].id, body: "Agent answer", author: "agent" });
    const current = await request<Discussion>(`${local}/discussion`);

    // When the user attempts to edit that reply
    const result = request(`${local}/discussion`, { action: "edit", threadId: current.threads[0].id, messageId: current.threads[0].messages[1].id, body: "Replacement" });

    // Then ownership is enforced at the API boundary
    await expect(result).rejects.toThrow("You can only change your own comments.");
  });

  test("collaboration rejects deleting an agent message", async () => {
    // Given a shared thread with an agent reply
    const discussion = await comment();
    const session = await request<ReviewSession>("/api/reviews", { path: directory, bookmark: "feature", agentSession: "agent-session" });
    await request(`/api/reviews/${session.id}/reply`, { threadId: discussion.threads[0].id, body: "Agent answer", author: "agent" });
    const current = await request<Discussion>(`${local}/discussion`);

    // When the user attempts deletion through the collaboration API
    const result = request(`/api/reviews/${session.id}/delete`, { threadId: current.threads[0].id, messageId: current.threads[0].messages[1].id });

    // Then the linked discussion enforces ownership too
    await expect(result).rejects.toThrow("You can only change your own comments.");
  });
  test("resolving a local thread persists only its displayed message receipts", async () => {
    // Given a displayed local thread followed by a newly arrived agent reply
    const initial = await comment();
    const thread = initial.threads[0];
    const keys = thread.messages.map((message) => `local:${message.id}`);
    await updateDiscussion(storage, `jj/${snapshot.workspace.id}/${snapshot.progressScope}`, (discussion) => {
      discussion.threads[0].messages.push({ id: "late-reply", author: "agent", body: "New reply", createdAt: new Date().toISOString(), sequence: 2 });
    });

    // When the reader resolves the displayed snapshot without a separate read mutation
    await request(`${local}/discussion`, { action: "resolve", threadId: thread.id, resolved: true, keys });

    // Then the late reply has no receipt
    expect(await request(`${local}/comment-reads`)).toEqual(keys);
  });
  test("agent-session resolution updates the published GitHub thread", async () => {
    // Given a published thread shared with an agent session
    const session = await publishedSession();

    // When the agent resolves it through the session API
    await request(`/api/reviews/${session.id}/resolve`, { threadId: session.threads[0].id, resolved: true, author: "agent" });

    // Then GitHub agrees with the requested resolution
    expect(threadResolved).toBe(true);
  });

  test.each(["standalone", "session"])("%s reopening updates the published GitHub thread", async (entry) => {
    // Given a published thread resolved through the standalone discussion
    const session = await publishedSession();
    const threadId = session.threads[0].id;
    await request(`${local}/discussion`, { action: "resolve", threadId, resolved: true });

    // When either entry point reopens that thread
    if (entry === "standalone") await request(`${local}/discussion`, { action: "resolve", threadId, resolved: false });
    else await request(`/api/reviews/${session.id}/resolve`, { threadId, resolved: false, author: "user" });

    // Then GitHub is reopened in either case
    expect(threadResolved).toBe(false);
  });

  test("agent resolution does not acknowledge human messages", async () => {
    // Given a published thread with unread messages
    const session = await publishedSession();
    const thread = session.threads[0];

    // When an agent resolves it, even with supplied read keys
    await request(`/api/reviews/${session.id}/resolve`, { threadId: thread.id, resolved: true, author: "agent", keys: thread.messages.map((message) => `local:${message.id}`) });

    // Then no human read receipts are created
    expect(await request(`${local}/comment-reads`)).toEqual([]);
  });

  test("human session resolution acknowledges only displayed messages", async () => {
    // Given a published thread displayed before another reply arrives
    const session = await publishedSession();
    const thread = session.threads[0];
    const keys = thread.messages.map((message) => `local:${message.id}`);
    // And a newer reply in the shared discussion
    await request(`${local}/discussion`, { action: "reply", threadId: thread.id, body: "New reply" });

    // When the human resolves the earlier snapshot through the session API
    await request(`/api/reviews/${session.id}/resolve`, { threadId: thread.id, resolved: true, author: "user", keys });

    // Then the newer reply stays unread in the canonical discussion
    expect(await request(`${local}/comment-reads`)).toEqual(keys);
  });

  test("failed session resolution leaves the shared thread unresolved", async () => {
    // Given a published thread whose remote resolution will fail
    const session = await publishedSession();
    rejectResolution = true;

    // When the session attempts resolution
    await request(`/api/reviews/${session.id}/resolve`, { threadId: session.threads[0].id, resolved: true, author: "user" }).catch(() => {});

    // Then the durable discussion retains the last acknowledged resolution
    expect((await request<Discussion>(`${local}/discussion`)).threads[0].resolved).toBe(false);
  });

  test("failed session resolution leaves messages unread", async () => {
    // Given a published thread whose remote resolution will fail
    const session = await publishedSession();
    rejectResolution = true;

    // When a human attempts to resolve and acknowledge its messages
    await request(`/api/reviews/${session.id}/resolve`, { threadId: session.threads[0].id, resolved: true, author: "user" }).catch(() => {});

    // Then no read receipts are committed
    expect(await request(`${local}/comment-reads`)).toEqual([]);
  });

  test("editing a published message through the session updates GitHub", async () => {
    // Given a published message shared with an agent session
    const session = await publishedSession();
    const thread = session.threads[0];
    const message = thread.messages[0];

    // When the human edits it through the session endpoint
    await request(`/api/reviews/${session.id}/edit`, { threadId: thread.id, messageId: message.id, body: "Updated through the session." });

    // Then GitHub receives the edit with its publication marker intact
    expect(published[0].body).toBe(`Updated through the session.\n\n<!-- biff:${thread.id}:${message.id} -->`);
  });

  test("deleting a published message through the session removes it from GitHub", async () => {
    // Given a published thread with one message
    const session = await publishedSession();
    const thread = session.threads[0];

    // When the human deletes that message through the session endpoint
    await request(`/api/reviews/${session.id}/delete`, { threadId: thread.id, messageId: thread.messages[0].id });

    // Then GitHub no longer contains the published message
    expect(published).toEqual([]);
  });

  test("a rejected session edit preserves the acknowledged local message", async () => {
    // Given a published message whose GitHub edit will fail
    const session = await publishedSession();
    const thread = session.threads[0];
    rejectChanges = true;

    // When the human attempts an edit through the session endpoint
    await request(`/api/reviews/${session.id}/edit`, { threadId: thread.id, messageId: thread.messages[0].id, body: "Rejected edit" }).catch(() => {});

    // Then the canonical message retains its original body
    expect((await request<Discussion>(`${local}/discussion`)).threads[0].messages[0].body).toBe(thread.messages[0].body);
  });

  test("default agent reviews receive working-copy comments above a feature bookmark after refresh", async () => {
    // Given working-copy edits above a feature bookmark and the browser's explicit WIP view
    await runCommand(["jj", "new"], { cwd: directory });
    await writeFile(`${directory}/file.ts`, "const first = 30;\nconst second = 40;\n");
    snapshot = await request(`/api/workspaces/${snapshot.workspace.id}/review?bookmark=`);
    local = `/api/workspaces/${snapshot.workspace.id}/changes/${snapshot.progressScope}`;
    // And a comment posted before the agent starts its default review
    const discussion = await comment();

    // When the agent opens and refreshes that review
    const session = await request<ReviewSession>("/api/reviews", { path: directory, agentSession: "wip-agent" });
    const refreshed = await request<ReviewSession>(`/api/reviews/${session.id}/refresh`, {});

    // Then the browser's comment is available for delivery in the same discussion
    expect(refreshed).toMatchObject({
      discussionScope: `jj/${snapshot.workspace.id}/${snapshot.progressScope}`,
      acknowledged: 0,
      humanSequence: 1,
      threads: [{ id: discussion.threads[0].id, messages: [{ body: "Please explain these values." }] }],
    });
  });

  /** Set up a real shared discussion and publication before exercising either route. */
  async function publishedSession(): Promise<ReviewSession> {
    const discussion = await comment();
    await request(`${pr}/review`);
    await request(`${local}/discussion`, { action: "publish", threadId: discussion.threads[0].id });
    return request("/api/reviews", { path: directory, bookmark: "feature", agentSession: "agent-session" });
  }
});
