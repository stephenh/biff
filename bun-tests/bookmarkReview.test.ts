import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { Workspaces } from "../server/workspaces";
import { runCommand } from "../server/commands";
import { createApi } from "../server/api";
import { GitHub } from "../server/github";
import { Reviews } from "../server/reviews";
import { Storage } from "../server/storage";
import type { ReviewSession } from "../shared/localReview";

describe("bookmarkReview", () => {
  let directory: string;
  let workspaces: Workspaces;
  let storage: Storage;
  let id: string;

  beforeEach(async () => {
    directory = await mkdtemp("/tmp/opencode/biff-bookmark-");
    await jj("git", "init");
    await writeFile(`${directory}/file.ts`, "const first = 0;\nconst second = 0;\n");
    await jj("bookmark", "create", "main");
    await jj("config", "set", "--repo", 'revset-aliases."trunk()"', "main");
    await jj("new");
    await writeFile(`${directory}/file.ts`, "const first = 1;\nconst second = 0;\n");
    await jj("new");
    await writeFile(`${directory}/file.ts`, "const first = 1;\nconst second = 2;\n");
    await jj("bookmark", "create", "feature/test");
    storage = new Storage(`${directory}/.jj/biff.sqlite`);
    workspaces = new Workspaces(storage);
    id = (await workspaces.add(directory)).id;
  });
  afterEach(async () => { await storage.close(); await rm(directory, { recursive: true, force: true }); });

  /** Run JJ against the isolated workspace. */
  function jj(...args: string[]) { return runCommand(["jj", ...args], { cwd: directory }); }

  test("all changes loads full source from the trunk base across multiple commits", async () => {
    // Given a bookmark containing two commits
    const review = await workspaces.bookmarkReview(id);
    // When full source is loaded for its aggregate diff
    const contents = await workspaces.contents(id, review.selected.commit_id, "file.ts", review.base!.commit_id);
    // Then the old source precedes both edits
    expect(contents.oldFile.contents).toBe("const first = 0;\nconst second = 0;\n");
  });

  test("individual commits use their own parent rather than the bookmark base", async () => {
    // Given the two-commit bookmark
    const all = await workspaces.bookmarkReview(id, "feature/test");
    // When only the tip commit is selected
    const review = await workspaces.bookmarkReview(id, "feature/test", all.tip!.change_id);
    const contents = await workspaces.contents(id, review.selected.commit_id, "file.ts");
    // Then its parent already contains the first edit
    expect(contents.oldFile.contents).toBe("const first = 1;\nconst second = 0;\n");
  });

  test("moving a bookmark retains its progress scope", async () => {
    // Given a bookmark review
    const before = await workspaces.bookmarkReview(id, "feature/test");
    // When another commit is added to the bookmark
    await jj("new");
    await writeFile(`${directory}/file.ts`, "const first = 1;\nconst second = 3;\n");
    await jj("bookmark", "set", "feature/test");
    const after = await workspaces.bookmarkReview(id, "feature/test");
    // Then progress remains scoped to the bookmark
    expect(after.progressScope).toBe(before.progressScope);
  });

  test("an explicit base limits a stacked review to commits above its parent", async () => {
    // Given a stacked bookmark with its first commit as the parent base
    const all = await workspaces.bookmarkReview(id, "feature/test");
    // When the parent commit is chosen as the base
    const review = await workspaces.bookmarkReview(id, "feature/test", "all", all.revisions[1].commit_id);
    // Then only the tip commit belongs to the review
    expect(review.revisions.map((entry) => entry.commit_id)).toEqual([all.tip!.commit_id]);
  });

  test("the parent bookmark is inferred when only the working commit is unbookmarked", async () => {
    // Given work above a named bookmark
    await jj("new");
    await writeFile(`${directory}/file.ts`, "const first = 1;\nconst second = 3;\n");
    // When the default workspace view is opened
    const review = await workspaces.bookmarkReview(id);
    // Then the default review selects the bookmark being edited
    expect(review.bookmark).toBe("feature/test");
  });

  test("a named bookmark excludes later working-copy changes", async () => {
    // Given additional work above the bookmark
    const before = await workspaces.bookmarkReview(id, "feature/test");
    await jj("new");
    await writeFile(`${directory}/file.ts`, "const first = 1;\nconst second = 3;\n");
    // When the named bookmark is reviewed
    const after = await workspaces.bookmarkReview(id, "feature/test");
    // Then the diff still ends at the bookmark
    expect(after.patch).toBe(before.patch);
  });

  test("a stacked bookmark automatically uses its nearest bookmarked ancestor", async () => {
    // Given a parent bookmark on the first of two feature commits
    const all = await workspaces.bookmarkReview(id, "feature/test");
    await jj("bookmark", "create", "parent-feature", "-r", all.revisions[1].commit_id);

    // When reviewing the child without a base override
    const review = await workspaces.bookmarkReview(id, "feature/test");

    // Then the parent bookmark is the inferred base
    expect(review.base?.commit_id).toBe(all.revisions[1].commit_id);
  });

  test("an explicit base can include changes below the inferred parent bookmark", async () => {
    // Given a parent bookmark in the stack
    const all = await workspaces.bookmarkReview(id, "feature/test");
    await jj("bookmark", "create", "parent-feature", "-r", all.revisions[1].commit_id);

    // When explicitly choosing main instead
    const review = await workspaces.bookmarkReview(id, "feature/test", "all", "main");

    // Then both feature commits remain in the review
    expect(review.revisions.map((entry) => entry.commit_id)).toEqual(all.revisions.map((entry) => entry.commit_id));
  });

  test("an empty working commit above a bookmark opens its full range against main", async () => {
    // Given two feature commits followed by an empty unbookmarked working commit
    await jj("new");

    // When opening the default review
    const review = await workspaces.bookmarkReview(id);

    // Then its inferred bookmark and base describe the full feature range
    expect(review).toMatchObject({ bookmark: "feature/test", baseLabel: "main", revisions: [{}, {}] });
  });

  test("explicit WIP still compares working changes against the parent bookmark", async () => {
    // Given work above a named bookmark
    await jj("new");
    await writeFile(`${directory}/file.ts`, "const first = 1;\nconst second = 3;\n");

    // When the user explicitly selects @
    const review = await workspaces.bookmarkReview(id, "");

    // Then only WIP above the bookmark is selected
    expect(review).toMatchObject({ bookmark: "", baseLabel: "feature/test", revisions: [{}] });
  });

  test("a bookmark on the working commit takes precedence over the parent's bookmark", async () => {
    // Given a new named review stacked above the feature bookmark
    await jj("new");
    await writeFile(`${directory}/file.ts`, "const first = 1;\nconst second = 3;\n");
    await jj("bookmark", "create", "follow-up");

    // When opening the default review
    const review = await workspaces.bookmarkReview(id);

    // Then the working bookmark remains the selected review
    expect(review).toMatchObject({ bookmark: "follow-up", baseLabel: "feature/test" });
  });

  test("ambiguous parent bookmark names do not pick a review arbitrarily", async () => {
    // Given two bookmarks on the parent of an unbookmarked working commit
    await jj("bookmark", "create", "other-feature");
    await jj("new");

    // When opening the default review
    const review = await workspaces.bookmarkReview(id);

    // Then the user can choose the intended bookmark instead of inheriting an arbitrary name
    expect(review.bookmark).toBe("");
  });

  test("new work directly above main remains WIP", async () => {
    // Given new work branching directly from trunk
    await jj("new", "main");
    await writeFile(`${directory}/file.ts`, "const first = 5;\nconst second = 0;\n");

    // When opening the default review
    const review = await workspaces.bookmarkReview(id);

    // Then main stays the base instead of replacing the working changes
    expect(review).toMatchObject({ bookmark: "", baseLabel: "main", revisions: [{}] });
  });

  test("starting an agent review infers the parent bookmark", async () => {
    // Given the /biff startup API and an empty working commit above the feature
    await jj("new");
    const api = createApi({ workspaces, github: new GitHub(), reviews: new Reviews(storage) });

    // When /biff starts its review without an explicit revision
    const response = await api(new Request("http://127.0.0.1:4567/api/reviews", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: directory, agentSession: "bookmark-inference-test" }) }));
    if (!response.ok) throw new Error(await response.text());

    // Then the agent review opens the feature range against main
    expect(await response.json()).toMatchObject({ snapshot: { bookmark: "feature/test", baseLabel: "main", revisions: [{}, {}] } });
  });

  test("an explicit main base uses the fork point when main has advanced", async () => {
    // Given a feature based on the original main
    const original = await workspaces.bookmarkReview(id, "feature/test", "all", "main");
    // And main now contains unrelated upstream changes
    await jj("new", "main");
    await writeFile(`${directory}/upstream.ts`, "export const upstream = true;\n");
    await jj("bookmark", "set", "main");

    // When resolving a target branch that has advanced independently
    const review = await workspaces.bookmarkReview(id, "feature/test", "all", "main");

    // Then the diff remains the feature's original changes, without undoing upstream work
    expect(review.patch).toBe(original.patch);
  });

  test("automatic trunk inference retains the old main as its immutable base", async () => {
    // Given a feature based on the original main
    const original = await workspaces.bookmarkReview(id, "feature/test");
    // And main advances independently
    await jj("new", "main");
    await writeFile(`${directory}/upstream.ts`, "export const upstream = true;\n");
    await jj("bookmark", "set", "main");

    // When opening the feature without a base override
    const review = await workspaces.bookmarkReview(id, "feature/test");

    // Then full-source loading is anchored to old main, not its moving tip
    expect(review.base?.commit_id).toBe(original.base?.commit_id);
  });

  test("refreshing an inferred bookmark includes agent edits above it against the original base", async () => {
    // Given an agent review inferred from the bookmark below empty @
    await jj("new");
    const api = collaborationApi();
    const session = await requestSession(api, "", { path: directory });

    // When the agent edits @ and refreshes its review
    await writeFile(`${directory}/file.ts`, "const first = 1;\nconst second = 3;\n");
    const refreshed = await requestSession(api, `/${session.id}/refresh`, {});
    const contents = await workspaces.contents(id, refreshed.snapshot.selected.commit_id, "file.ts", refreshed.snapshot.base!.commit_id);

    // Then the reviewed range includes both the original feature and the new agent edit
    expect(contents).toEqual({ oldFile: { name: "file.ts", contents: "const first = 0;\nconst second = 0;\n" }, newFile: { name: "file.ts", contents: "const first = 1;\nconst second = 3;\n" } });
  });

  test("following working edits preserves the inferred bookmark's durable identity", async () => {
    // Given an inferred bookmark review
    await jj("new");
    const api = collaborationApi();
    const session = await requestSession(api, "", { path: directory });

    // When agent edits extend its snapshot
    await writeFile(`${directory}/file.ts`, "const first = 1;\nconst second = 3;\n");
    const refreshed = await requestSession(api, `/${session.id}/refresh`, {});

    // Then progress and comments still belong to the same review lifetime
    expect(refreshed.snapshot.identity).toEqual(session.snapshot.identity);
  });

  test("inferred collaboration follows multiple unbookmarked descendant commits", async () => {
    // Given an inferred bookmark review
    await jj("new");
    const api = collaborationApi();
    const session = await requestSession(api, "", { path: directory });

    // When the agent creates another working commit above its first edit
    await writeFile(`${directory}/file.ts`, "const first = 1;\nconst second = 3;\n");
    await jj("new");
    await writeFile(`${directory}/file.ts`, "const first = 4;\nconst second = 3;\n");
    const refreshed = await requestSession(api, `/${session.id}/refresh`, {});
    const working = await workspaces.review(id, "@");

    // Then refresh follows the latest working snapshot
    expect(refreshed.snapshot.selected.commit_id).toBe(working.selected.commit_id);
  });

  test("refresh does not follow an unrelated working-copy branch", async () => {
    // Given an inferred feature review
    await jj("new");
    const api = collaborationApi();
    const session = await requestSession(api, "", { path: directory });

    // When the working copy switches to new work off main
    await jj("new", "main");
    await writeFile(`${directory}/file.ts`, "unrelated();\n");
    const refreshed = await requestSession(api, `/${session.id}/refresh`, {});

    // Then the session remains on its original bookmark
    expect(refreshed.snapshot.selected.commit_id).toBe(session.snapshot.selected.commit_id);
  });

  test("refresh stops at a separately bookmarked descendant review", async () => {
    // Given an inferred feature review
    await jj("new");
    const api = collaborationApi();
    const session = await requestSession(api, "", { path: directory });

    // When the descendant work is given its own bookmark
    await writeFile(`${directory}/file.ts`, "anotherReview();\n");
    await jj("bookmark", "create", "follow-up");
    await jj("new");
    const refreshed = await requestSession(api, `/${session.id}/refresh`, {});

    // Then the original review does not absorb the new named review
    expect(refreshed.snapshot.selected.commit_id).toBe(session.snapshot.selected.commit_id);
  });

  test("legacy inferred sessions also follow working edits on refresh", async () => {
    // Given a session saved before the inference flag existed
    await jj("new");
    const api = collaborationApi();
    const session = await requestSession(api, "", { path: directory });
    await new Reviews(storage).update(session.id, false, (review) => { delete review.snapshot.followWorkingCopy; });

    // When the agent edits @ and refreshes that existing session
    await writeFile(`${directory}/file.ts`, "updatedLegacyReview();\n");
    const refreshed = await requestSession(api, `/${session.id}/refresh`, {});
    const working = await workspaces.review(id, "@");

    // Then the old session receives the current working snapshot
    expect(refreshed.snapshot.selected.commit_id).toBe(working.selected.commit_id);
  });

  test("a working commit in an inferred range remains individually selectable", async () => {
    // Given an inferred review that includes agent edits above its bookmark
    await jj("new");
    await writeFile(`${directory}/file.ts`, "updatedWorkingCommit();\n");
    const api = collaborationApi();
    const session = await requestSession(api, "", { path: directory });

    // When the toolbar opens the working commit from that range
    const query = new URLSearchParams({ bookmark: "feature/test", changes: session.snapshot.selected.change_id, follow: "1" });
    const response = await api(new Request(`http://127.0.0.1:4567/api/workspaces/${id}/review?${query}`));
    if (!response.ok) throw new Error(await response.text());

    // Then the selected commit is still part of the range
    expect(await response.json()).toMatchObject({ selected: { commit_id: session.snapshot.selected.commit_id } });
  });

  test("a stale ancestor bookmark below the trunk fork is not the review base", async () => {
    // Given an old bookmark below the feature's actual fork point
    await jj("new", "main");
    await jj("bookmark", "create", "old", "-r", "main");
    await writeFile(`${directory}/upstream.ts`, "upstream();\n");
    await jj("bookmark", "set", "main");
    const fork = (await jj("log", "--no-graph", "-r", "main", "-T", "commit_id")).trim();
    await jj("new");
    await writeFile(`${directory}/fresh.ts`, "feature();\n");
    await jj("bookmark", "create", "fresh");
    // And main has moved again, leaving old as the sole bookmarked ancestor
    await jj("new", "main");
    await writeFile(`${directory}/later.ts`, "later();\n");
    await jj("bookmark", "set", "main");

    // When the feature's base is inferred
    const snapshot = await workspaces.bookmarkReview(id, "fresh");

    // Then it starts at the trunk fork, excluding upstream work
    expect(snapshot.base?.commit_id).toBe(fork);
  });

  /** Exercise startup, durable identity preparation, and refresh through the actual session API. */
  function collaborationApi() {
    return createApi({ workspaces, github: new GitHub(), reviews: new Reviews(storage), storage });
  }

  /** Fail on API errors before checking the resulting review snapshot. */
  async function requestSession(api: ReturnType<typeof createApi>, path: string, body: unknown): Promise<ReviewSession> {
    const response = await api(new Request(`http://127.0.0.1:4567/api/reviews${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  }
});
