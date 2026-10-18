import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createApi } from "../server/api";
import { runCommand } from "../server/commands";
import { GitHub } from "../server/github";
import { Progress } from "../server/progress";
import { Workspaces } from "../server/workspaces";
import type { ReviewedChange, ReviewIdentity } from "../shared/progress";
import type { LocalReview } from "../shared/types";
import { identifyChanges, identifyFiles } from "../src/changeProgress";
import { parseInput } from "../src/patches";

describe("reviewIdentity", () => {
  let directory: string;
  let workspaces: Workspaces;
  let progress: Progress;
  let api: ReturnType<typeof createApi>;
  let id: string;
  let remote: LocalReview;
  let state: string;
  const pr = "/api/github/pr/example/project/12";

  beforeEach(async () => {
    directory = await mkdtemp("/tmp/opencode/biff-identity-");
    await jj("git", "init");
    await writeFile(`${directory}/file.ts`, "before();\n");
    await jj("bookmark", "create", "main");
    await jj("config", "set", "--repo", 'revset-aliases."trunk()"', "main");
    await jj("new");
    await writeFile(`${directory}/file.ts`, "after();\n");
    await jj("bookmark", "create", "feature");
    workspaces = new Workspaces(`${directory}/.jj/workspaces.json`);
    id = (await workspaces.add(directory)).id;
    remote = await workspaces.bookmarkReview(id, "feature");
    progress = new Progress(`${directory}/.jj/progress`);
    state = "open";
    api = createApi({ workspaces, progress, github: new GitHub(githubFixture) });
  });

  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  /** Exercise real JJ snapshots while GitHub returns the pushed immutable snapshot. */
  async function githubFixture(args: string[]): Promise<string> {
    if (args[2] === "repos/example/project/pulls/12") return JSON.stringify({ state, head: { sha: remote.selected.commit_id }, base: { sha: remote.base!.commit_id } });
    if (args[2].startsWith("repos/example/project/pulls/12/commits")) return JSON.stringify([remote.revisions.map((revision) => ({ sha: revision.commit_id }))]);
    if (args[2].startsWith("repos/example/project/compare/")) return remote.patch;
    throw new Error(`Unexpected GitHub fixture request: ${args.join(" ")}`);
  }

  /** Run JJ in the disposable repository. */
  function jj(...args: string[]) { return runCommand(["jj", ...args], { cwd: directory }); }

  /** Use the public API so scope validation and commit verification are covered. */
  async function request<T>(path: string, body?: unknown): Promise<T> {
    const response = await api(new Request(`http://127.0.0.1:4567${path}`, body === undefined ? undefined : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
    const value = await response.json();
    if (!response.ok) throw new Error(value.error);
    return value;
  }

  /** Open the bookmark's combined review through normal routing. */
  function local(): Promise<LocalReview> { return request(`/api/workspaces/${id}/review?bookmark=feature`); }

  /** Keep old snapshot URLs pinned to their original review lifetime. */
  function endpoint(snapshot: LocalReview) { return `/api/workspaces/${id}/changes/${snapshot.progressScope}`; }

  test("opening a PR discovers local marks by exact commit ID", async () => {
    // Given a locally reviewed edit before the PR is linked
    const snapshot = await local();
    const [block] = await identifyChanges(parseInput(snapshot.patch));
    await request(`${endpoint(snapshot)}/progress`, { ...block, head: snapshot.selected.commit_id, reviewed: true });

    // When its exact pushed commit is opened as a PR
    await request(`${pr}/review`);
    const records = await request<ReviewedChange[]>(`${pr}/progress`);

    // Then the PR sees the local approval
    expect(records.map((record) => record.hash)).toEqual([block.hash]);
  });

  test("an unmark through the PR stays removed locally after restart and rediscovery", async () => {
    // Given shared progress
    const snapshot = await local();
    const [block] = await identifyChanges(parseInput(snapshot.patch));
    await request(`${endpoint(snapshot)}/progress`, { ...block, head: snapshot.selected.commit_id, reviewed: true });
    await request(`${pr}/review`);

    // When the PR removes the approval and the daemon restarts
    await request(`${pr}/progress`, { ...block, head: snapshot.selected.commit_id, reviewed: false });
    const restarted = new Progress(`${directory}/.jj/progress`);
    await restarted.pullRequest("example/project/12", [snapshot.selected.commit_id]);

    // Then no legacy copy restores the mark
    expect(await restarted.get(`jj/${id}/${snapshot.progressScope}`)).toEqual([]);
  });

  test("patch equality cannot establish a link without an exact commit ID", async () => {
    // Given a recorded local snapshot with identical content but a different commit version
    const snapshot = await local();
    const [block] = await identifyChanges(parseInput(snapshot.patch));
    await request(`${endpoint(snapshot)}/progress`, { ...block, head: snapshot.selected.commit_id, reviewed: true });
    remote = { ...remote, revisions: remote.revisions.map((revision) => ({ ...revision, commit_id: "a".repeat(40) })) };

    // When opening a PR with the same patch and no shared commit identity
    await request(`${pr}/review`);

    // Then exact identity is required even though the patch is identical
    expect(await request(`${pr}/progress`)).toEqual([]);
  });

  test("historical recorded commit IDs can establish a link after a local amendment", async () => {
    // Given a pushed snapshot recorded before local changes
    const snapshot = await local();
    await writeFile(`${directory}/file.ts`, "newer();\n");
    await local();

    // When opening the PR that still contains the older snapshot
    await request(`${pr}/review`);
    const identity = await request<ReviewIdentity>(`${pr}/identity`);

    // Then the stable JJ change keeps the same logical review
    expect(identity.id).toBe(snapshot.identity!.id);
  });

  test("closed PRs end the lifetime even when the bookmark still points to the same commit", async () => {
    // Given a linked and reviewed bookmark
    const snapshot = await local();
    const [block] = await identifyChanges(parseInput(snapshot.patch));
    await request(`${endpoint(snapshot)}/progress`, { ...block, head: snapshot.selected.commit_id, reviewed: true });
    await request(`${pr}/review`);
    // And its PR has closed
    state = "closed";

    // When the bookmark is opened again
    const next = await local();

    // Then it starts with fresh progress rather than inheriting the completed lifetime
    expect(await request(`${endpoint(next)}/progress`)).toEqual([]);
  });

  test("starting a new review keeps the previous PR's records intact", async () => {
    // Given a linked review with an approved edit
    const snapshot = await local();
    const [block] = await identifyChanges(parseInput(snapshot.patch));
    await request(`${endpoint(snapshot)}/progress`, { ...block, head: snapshot.selected.commit_id, reviewed: true });
    await request(`${pr}/review`);

    // When the bookmark starts another lifetime and its file is unmarked
    await request(`/api/workspaces/${id}/review`, { bookmark: "feature" });
    await request(`${pr}/review`);
    const next = await local();
    await request(`${endpoint(next)}/progress`, { ...block, head: snapshot.selected.commit_id, reviewed: false });

    // Then the old PR still has its own approval
    expect((await request<ReviewedChange[]>(`${pr}/progress`)).map((record) => record.hash)).toEqual([block.hash]);
  });

  test("reusing a bookmark for unrelated JJ changes starts fresh without a PR", async () => {
    // Given a reviewed bookmark
    const snapshot = await local();
    const [block] = await identifyChanges(parseInput(snapshot.patch));
    await request(`${endpoint(snapshot)}/progress`, { ...block, head: snapshot.selected.commit_id, reviewed: true });

    // When the same bookmark name moves to unrelated work with identical content
    await jj("new", "main");
    await writeFile(`${directory}/file.ts`, "after();\n");
    await jj("bookmark", "set", "feature", "--allow-backwards");
    const next = await local();

    // Then content similarity does not reuse the old review
    expect(await request(`${endpoint(next)}/progress`)).toEqual([]);
  });

  test("file review through the PR approves its local blocks in the same transaction", async () => {
    // Given a linked local and PR review
    const snapshot = await local();
    await request(`${pr}/review`);
    const files = parseInput(snapshot.patch);
    const blocks = await identifyChanges(files);
    const [file] = await identifyFiles(files, blocks);

    // When marking the entire file reviewed in the PR
    await request(`${pr}/progress`, { ...file, blocks, head: snapshot.selected.commit_id, reviewed: true });

    // Then the local view sees both file and block approvals
    expect((await request<ReviewedChange[]>(`${endpoint(snapshot)}/progress`)).map((record) => record.hash)).toEqual([file.hash, ...blocks.map((block) => block.hash)]);
  });

  test("legacy bookmark progress migrates into its first lifetime", async () => {
    // Given progress saved by the old per-bookmark store
    const [block] = await identifyChanges(parseInput(remote.patch));
    const scope = `jj/${id}/${remote.progressScope}`;
    const hash = createHash("sha256").update(scope).digest("hex");
    await progress.get("initialize-directory");
    await writeFile(`${directory}/.jj/progress/${hash}.json`, JSON.stringify([{ ...block, head: remote.selected.commit_id, reviewedAt: "2026-01-01" }]));

    // When opening the bookmark's first durable lifetime
    const snapshot = await local();

    // Then its existing approval is retained
    expect((await request<ReviewedChange[]>(`${endpoint(snapshot)}/progress`)).map((record) => record.hash)).toEqual([block.hash]);
  });

  test("multiple matching local reviews are left independent", async () => {
    // Given a local approval whose exact commit is already in the PR
    const snapshot = await local();
    const [block] = await identifyChanges(parseInput(snapshot.patch));
    await request(`${endpoint(snapshot)}/progress`, { ...block, head: snapshot.selected.commit_id, reviewed: true });

    // And another bookmark review contains the same exact commit
    await jj("bookmark", "create", "other-feature");
    await request(`/api/workspaces/${id}/review?bookmark=other-feature`);

    // When opening the PR with ambiguous identity evidence
    await request(`${pr}/review`);

    // Then it does not guess which review to adopt
    expect(await request(`${pr}/progress`)).toEqual([]);
  });

  test("linking retains approvals already saved in the PR", async () => {
    // Given PR progress saved before its local view is linked
    const snapshot = await local();
    const [block] = await identifyChanges(parseInput(snapshot.patch));
    await request(`${pr}/progress`, { ...block, head: snapshot.selected.commit_id, reviewed: true });

    // When opening the PR with an existing local review
    await request(`${pr}/review`);

    // Then the local view inherits the PR approval
    expect((await request<ReviewedChange[]>(`${endpoint(snapshot)}/progress`)).map((record) => record.hash)).toEqual([block.hash]);
  });

  test("opening the local review after the PR also discovers shared progress", async () => {
    // Given a reviewed PR before Biff has recorded its local snapshot
    await request(`${pr}/review`);
    const [block] = await identifyChanges(parseInput(remote.patch));
    await request(`${pr}/progress`, { ...block, head: remote.selected.commit_id, reviewed: true });

    // When its local bookmark is opened
    const snapshot = await local();

    // Then the existing PR approval is shared automatically
    expect((await request<ReviewedChange[]>(`${endpoint(snapshot)}/progress`)).map((record) => record.hash)).toEqual([block.hash]);
  });

  test("multiple recorded PRs matching one new local review stay independent", async () => {
    // Given two PRs with the same commit before the local review is opened
    await progress.pullRequest("example/project/12", [remote.selected.commit_id]);
    await progress.pullRequest("example/project/13", [remote.selected.commit_id]);

    // When their matching local bookmark is opened
    const snapshot = await local();

    // Then neither PR is chosen arbitrarily
    expect(snapshot.identity?.pr).toBeUndefined();
  });

  test("opening a closed PR cannot attach it to a fresh local review", async () => {
    // Given a reviewed local snapshot and a closed PR with the same commit
    const snapshot = await local();
    const [block] = await identifyChanges(parseInput(snapshot.patch));
    await request(`${endpoint(snapshot)}/progress`, { ...block, head: snapshot.selected.commit_id, reviewed: true });
    state = "closed";

    // When the closed PR is opened
    await request(`${pr}/review`);

    // Then the local lifetime is not adopted by that ended review
    expect(await request(`${pr}/progress`)).toEqual([]);
  });

  test("comment reads survive a daemon restart", async () => {
    // Given a local review with an opened comment
    const snapshot = await local();
    await request(`${endpoint(snapshot)}/comment-reads`, { keys: ["local:message-one"] });

    // When the durable store is reopened
    const restarted = new Progress(`${directory}/.jj/progress`);

    // Then the message retains its read receipt
    expect(await restarted.commentReads(`jj/${id}/${snapshot.progressScope}`)).toEqual(["local:message-one"]);
  });

  test("linking reviews merges comment read receipts from both views", async () => {
    // Given separately recorded local and PR receipts before association
    const snapshot = await local();
    await request(`${endpoint(snapshot)}/comment-reads`, { keys: ["local:message-one"] });
    // And a comment read through the PR URL
    await request(`${pr}/comment-reads`, { keys: ["github:42"] });

    // When the shared commit links the reviews
    await request(`${pr}/review`);

    // Then both receipts are available through the local review
    expect(await request(`${endpoint(snapshot)}/comment-reads`)).toEqual(["local:message-one", "github:42"]);
  });

  test("concurrent read acknowledgements retain every message", async () => {
    // Given a local review open in two tabs
    const snapshot = await local();
    const path = `${endpoint(snapshot)}/comment-reads`;

    // When both tabs acknowledge different messages
    await Promise.all([request(path, { keys: ["local:first"] }), request(path, { keys: ["local:second"] })]);

    // Then neither acknowledgement replaces the other
    expect((await request<string[]>(path)).sort()).toEqual(["local:first", "local:second"]);
  });
});
