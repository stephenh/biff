import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createApi } from "../server/api";
import { runCommand, type RunCommand } from "../server/commands";
import { GitHub } from "../server/github";
import { Progress } from "../server/progress";
import { Reviews } from "../server/reviews";
import { Workspaces } from "../server/workspaces";
import type { Discussion } from "../shared/discussion";
import type { ReviewSession } from "../shared/localReview";
import type { DiscussionComment, LocalReview } from "../shared/types";

describe("discussion", () => {
  let directory: string;
  let api: ReturnType<typeof createApi>;
  let snapshot: LocalReview;
  let local: string;
  let published: DiscussionComment[];
  let remoteHead: string;
  let remoteOld: string;
  let loseResponse: boolean;
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
    const workspaces = new Workspaces(`${directory}/.jj/workspaces.json`);
    const workspace = await workspaces.add(directory);
    api = createApi({ workspaces, github: new GitHub(githubFixture), progress: new Progress(`${directory}/.jj/progress`), reviews: new Reviews(`${directory}/.jj/sessions`) });
    snapshot = await request(`/api/workspaces/${workspace.id}/review?bookmark=feature`);
    local = `/api/workspaces/${workspace.id}/changes/${snapshot.progressScope}`;
    published = [];
    remoteHead = snapshot.selected.commit_id;
    remoteOld = oldText;
    loseResponse = false;
    publicationGate = undefined;
    publicationStarted = undefined;
  });

  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  /** Serve a GitHub-shaped stateful fixture; no test can publish to a real repository. */
  async function githubFixture(args: string[], options?: Parameters<RunCommand>[1]): Promise<string> {
    const path = args[2];
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
    if (path === "repos/example/project/pulls/12") return JSON.stringify({ state: "open", number: 12, head: { sha: remoteHead }, base: { sha: snapshot.base!.commit_id } });
    if (path.startsWith("repos/example/project/pulls/12/commits")) return JSON.stringify([[{ sha: remoteHead }]]);
    if (path.startsWith("repos/example/project/pulls/12/comments")) return JSON.stringify([published]);
    if (path.startsWith("repos/example/project/compare/")) return args.includes("Accept: application/vnd.github.diff") ? snapshot.patch : JSON.stringify({ merge_base_commit: { sha: snapshot.base!.commit_id } });
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
    const restored = await new Progress(`${directory}/.jj/progress`).discussion(`jj/${snapshot.workspace.id}/${snapshot.progressScope}`);

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
    expect(discussion.threads).toEqual(localDiscussion.threads);
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

  test("an outdated head cannot publish old line coordinates", async () => {
    // Given a local thread and a PR that has moved to another commit
    const discussion = await comment();
    await request(`${pr}/review`);
    remoteHead = "a".repeat(40);

    // When publishing the old thread
    await request(`${local}/discussion`, { action: "publish", threadId: discussion.threads[0].id });

    // Then no remote comment is created
    expect(published).toEqual([]);
  });

  test("a different PR base file cannot receive the local comment", async () => {
    // Given identical head content but different old-side source on the PR
    const discussion = await comment();
    await request(`${pr}/review`);
    remoteOld = "Different base contents\n";

    // When publishing the local snapshot's comment
    await request(`${local}/discussion`, { action: "publish", threadId: discussion.threads[0].id });

    // Then the source mismatch prevents publication
    expect(published).toEqual([]);
  });

  test("an attached agent receives comments saved through the ordinary bookmark endpoint", async () => {
    // Given an agent attached to the same bookmark review
    const session = await request<ReviewSession>("/api/reviews", { path: directory, agentSession: "agent-session" });

    // When a user saves a comment without an agent-session URL
    await comment();
    const feedback = await request<ReviewSession>(`/api/reviews/${session.id}/wait`);

    // Then the agent receives that durable user message
    expect(feedback.threads[0].messages.map((message) => message.body)).toEqual(["Please explain these values."]);
  });

  test("agent replies are shared with the bookmark", async () => {
    // Given a shared comment and an attached agent
    const discussion = await comment();
    const session = await request<ReviewSession>("/api/reviews", { path: directory, agentSession: "agent-session" });

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
    const session = await request<ReviewSession>("/api/reviews", { path: directory, agentSession: "agent-session" });

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
});
