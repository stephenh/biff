import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { runCommand } from "../server/commands";
import { LocalPrLinks } from "../server/localPrLinks";
import { hunkApprovals, updateHunkApproval } from "../server/logicalHunks";
import { localReview, recordPullRequest, reviewIdentity } from "../server/reviewStore";
import { Storage } from "../server/storage";
import { Workspaces } from "../server/workspaces";
import { createApi } from "../server/api";
import { GitHub } from "../server/github";
import { identifyChanges } from "../shared/changeProgress";
import { parseInput } from "../src/patches";
import { matchesChange, type ChangeIdentity } from "../shared/progress";
import type { LocalReview } from "../shared/types";

describe("localPrLinks", () => {
  let directory: string;
  let storage: Storage;
  let workspaces: Workspaces;
  let links: LocalPrLinks;
  let snapshot: LocalReview;
  let block: ChangeIdentity;
  const scope = "example/project/12";

  beforeEach(async () => {
    directory = await mkdtemp("/tmp/opencode/biff-local-pr-links-");
    await jj("git", "init");
    await jj("git", "remote", "add", "origin", "git@github.com:Example/Project.git");
    await writeFile(`${directory}/file.ts`, "before();\n");
    await jj("bookmark", "create", "main");
    await jj("config", "set", "--repo", 'revset-aliases."trunk()"', "main");
    await jj("new");
    await writeFile(`${directory}/file.ts`, "after();\n");
    storage = new Storage();
    workspaces = new Workspaces(storage);
    const workspace = await workspaces.add(directory);
    const loaded = await workspaces.bookmarkReview(workspace.id);
    const identity = await localReview(storage, loaded);
    snapshot = { ...loaded, identity };
    [block] = await identifyChanges(parseInput(snapshot.patch));
    await updateHunkApproval(storage, identity.id, block, true, snapshot.selected.commit_id);
    links = new LocalPrLinks(storage, workspaces);
  });
  afterEach(async () => { await links.stop(); await storage.close(); await rm(directory, { recursive: true, force: true }); });

  test("recovers WIP progress after publishing changes the commit message and SHA", async () => {
    // Given a reviewed WIP followed by a described, bookmarked commit that Biff has not captured
    const head = await describeHead("Publish the reviewed change");
    await jj("bookmark", "create", "feature");
    await recordPullRequest(storage, scope, [head], false, head);

    // When background linking reads the pushed object already in the local repository
    links.wake();
    await links.stop();

    // Then the PR uses the original durable approvals without a local review refresh
    expect(await hunkApprovals(storage, scope)).toEqual(await hunkApprovals(storage, snapshot.identity!.id));
  });

  test("keeps exact-SHA linking when no GitHub remote is configured", async () => {
    // Given a local review without any matching remote metadata
    await jj("git", "remote", "remove", "origin");

    // When the identical commit is opened as a PR
    const identity = await recordPullRequest(storage, scope, [snapshot.selected.commit_id], false, snapshot.selected.commit_id);

    // Then existing SHA-based identity sharing remains independent of change-ID support
    expect(identity.id).toBe(snapshot.identity!.id);
  });

  test("does not link a PR from a repository absent from the local remotes", async () => {
    // Given the same change ID in an unrelated repository
    const head = await describeHead("Unrelated repository");
    const unrelated = "someone/else/12";
    await recordPullRequest(storage, unrelated, [head], false, head);

    // When background linking searches the registered local repositories
    links.wake();
    await links.stop();

    // Then matching change IDs alone do not leak approvals across repositories
    expect(await hunkApprovals(storage, unrelated)).toEqual([]);
  });

  test("missing local objects leave the PR usable and unlinked", async () => {
    // Given a PR head that does not exist in the local object database
    const head = "d".repeat(40);
    await recordPullRequest(storage, scope, [head], false, head);

    // When the optional background lookup fails without fetching anything
    links.wake();
    await links.stop();

    // Then local approvals are not copied speculatively
    expect(await hunkApprovals(storage, scope)).toEqual([]);
  });

  test("does not invent change IDs for Git commits without a header", async () => {
    // Given a Git commit containing the same changes but no explicit JJ header
    const root = (await jj("git", "root", "--ignore-working-copy")).trim();
    const object = await runCommand(["git", `--git-dir=${root}`, "cat-file", "commit", snapshot.selected.commit_id]);
    const input = object.replace(/^change-id .*\n/m, "") + `\nA message trailer is not a header.\nchange-id ${snapshot.selected.change_id}\n`;
    const head = (await runCommand(["git", `--git-dir=${root}`, "hash-object", "-t", "commit", "-w", "--stdin"], { input })).trim();
    await recordPullRequest(storage, scope, [head], false, head);

    // When the headerless object is inspected
    links.wake();
    await links.stop();

    // Then patch equality and synthetic IDs cannot establish a new link
    expect(await hunkApprovals(storage, scope)).toEqual([]);
  });

  test("refuses to choose between two local review lifetimes with the same tip change", async () => {
    // Given two independently recorded local reviews of the same change
    await localReview(storage, { ...snapshot, bookmark: "another-review" });
    // And a rewritten PR head that has no exact SHA match to either snapshot
    const head = await describeHead("Ambiguous local reviews");
    await recordPullRequest(storage, scope, [head], false, head);

    // When both candidates are considered together
    links.wake();
    await links.stop();

    // Then no local lifetime is chosen arbitrarily
    expect(await hunkApprovals(storage, scope)).toEqual([]);
  });

  test("refuses to choose between known PRs with the same change ID", async () => {
    // Given two PRs containing different commit versions of the same local change
    const first = await describeHead("First publication");
    await recordPullRequest(storage, scope, [first], false, first);
    const second = await describeHead("Second publication");
    await recordPullRequest(storage, "example/project/13", [second], false, second);

    // When startup resolves both heads in one background batch
    links.wake();
    await links.stop();

    // Then the local lifetime remains unlinked rather than adopting the first response
    expect((await reviewIdentity(storage, snapshot.identity!.id)).pr).toBeUndefined();
  });

  test("a parent's change ID in a child's range cannot link the child's review", async () => {
    // Given only the child review is eligible, although its range includes the parent change
    await storage.serialize("review", async () => { storage.db.query("UPDATE reviews SET closed=1 WHERE id=?").run(snapshot.identity!.id); });
    const parent = await describeHead("Parent publication");
    await jj("new");
    await writeFile(`${directory}/child.ts`, "child();\n");
    const child = await localReview(storage, await workspaces.bookmarkReview(snapshot.workspace.id));
    await recordPullRequest(storage, scope, [parent], false, parent);

    // When the parent's PR head is resolved locally
    links.wake();
    await links.stop();

    // Then the child's ancestor history is not mistaken for its tip
    expect((await reviewIdentity(storage, child.id)).pr).toBeUndefined();
  });

  test("linking an amended change does not approve edited hunk content", async () => {
    // Given the same logical change now contains different source text
    await writeFile(`${directory}/file.ts`, "different();\n");
    const head = await describeHead("Changed content");
    const updated = await workspaces.bookmarkReview(snapshot.workspace.id);
    const [changed] = await identifyChanges(parseInput(updated.patch));
    await recordPullRequest(storage, scope, [head], false, head);

    // When review identity is linked through the stable change ID
    links.wake();
    await links.stop();

    // Then content matching still requires the edited hunk to be reviewed again
    expect((await hunkApprovals(storage, scope)).some((record) => matchesChange(record, changed))).toBe(false);
  });

  test("a held local lookup does not delay the PR review response", async () => {
    // Given optional local metadata that remains unavailable while the PR loads
    const head = await describeHead("Background publication");
    const held = Promise.withResolvers<string | undefined>();
    links = new LocalPrLinks(storage, { localRepositories: (ids) => workspaces.localRepositories(ids), localChangeId: async () => held.promise });
    const github = new GitHub(async (args) => {
      if (args[2].endsWith("/pulls/12")) return JSON.stringify({ state: "open", head: { sha: head }, base: { sha: snapshot.base!.commit_id } });
      if (args[2].includes("/commits?")) return JSON.stringify([[{ sha: head }]]);
      if (args[2].includes("/compare/")) return snapshot.patch;
      throw new Error(`Unexpected GitHub fixture request: ${args.join(" ")}`);
    });
    const api = createApi({ storage, workspaces, github, localPrLinks: links });

    try {
      // When the PR is opened before the local lookup finishes
      const response = await api(new Request(`http://127.0.0.1:4567/api/github/pr/${scope}/review`));

      // Then the diff response is independent of background linking
      expect(response.status).toBe(200);
    } finally { held.resolve(undefined); }
  });

  /** Change only commit metadata so the head SHA moves while the JJ change ID remains stable. */
  async function describeHead(message: string): Promise<string> {
    await jj("describe", "-m", message);
    return (await jj("log", "--ignore-working-copy", "--no-graph", "-r", "@", "-T", "commit_id")).trim();
  }

  /** Keep every source operation confined to the disposable local repository. */
  function jj(...args: string[]): Promise<string> { return runCommand(["jj", ...args], { cwd: directory }); }
});
