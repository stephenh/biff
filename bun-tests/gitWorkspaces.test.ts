import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Workspaces } from "../server/workspaces";
import { Storage } from "../server/storage";
import { runCommand } from "../server/commands";
import { parseInput } from "../src/patches";
import { localReview } from "../server/reviewStore";
import { createApi } from "../server/api";
import { GitHub } from "../server/github";
import { Reviews } from "../server/reviews";
import type { ReviewSession } from "../shared/localReview";
import type { LocalReview } from "../shared/types";

describe("gitWorkspaces", () => {
  let directory: string;
  let repo: string;
  let storage: Storage;
  let workspaces: Workspaces;
  beforeAll(async () => { directory = await mkdtemp("/tmp/opencode/biff-git-workspaces-"); });
  beforeEach(async () => {
    repo = await mkdtemp(join(directory, "repository with spaces-"));
    await git("init", "--initial-branch=main");
    await git("config", "user.name", "Biff Test");
    await git("config", "user.email", "biff@example.com");
    await git("config", "commit.gpgSign", "false");
    await writeFile(join(repo, "example.ts"), "export const value = 1;\n");
    await git("add", ".");
    await git("commit", "-m", "Initial commit");
    await git("switch", "-c", "feature/test");
    storage = new Storage();
    workspaces = new Workspaces(storage);
  });
  afterEach(async () => { await storage.close(); });
  afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

  test("registers one canonical Git root from a subdirectory without invoking JJ", async () => {
    // Given a nested directory in a Git-only working copy
    await mkdir(join(repo, "nested"));
    const gitOnly = new Workspaces(storage, async (args, options) => {
      if (args[0] === "jj") throw new Error("JJ is not installed");
      return runCommand(args, options);
    });
    await gitOnly.add(repo);
    // When its subdirectory is registered
    await gitOnly.add(join(repo, "nested"));
    // Then the registry retains only the canonical root
    expect((await gitOnly.list()).map((entry) => entry.path)).toEqual([repo]);
  });

  test("@ combines staged, unstaged, deleted, and untracked files", async () => {
    // Given staged edits and a staged addition
    await writeFile(join(repo, "example.ts"), "export const value = 2;\n");
    await writeFile(join(repo, "staged.ts"), "staged\n");
    await git("add", ".");
    // And further unstaged edits, a deletion, and an untracked file
    await writeFile(join(repo, "staged.ts"), "unstaged\n");
    await rm(join(repo, "example.ts"));
    await writeFile(join(repo, "untracked.ts"), "new\n");
    const workspace = await workspaces.add(repo);
    // When the working tree is reviewed
    const review = await workspaces.review(workspace.id, "@");
    // Then all final working-tree changes appear together
    expect(parseInput(review.patch).map((file) => ({ name: file.name, additions: file.additionLines }))).toEqual([
      { name: "example.ts", additions: [] },
      { name: "staged.ts", additions: ["unstaged\n"] },
      { name: "untracked.ts", additions: ["new\n"] },
    ]);
  });

  test("captures leave the real staging index byte-for-byte unchanged", async () => {
    // Given staged edits followed by unstaged edits
    await writeFile(join(repo, "example.ts"), "staged\n");
    await git("add", ".");
    await writeFile(join(repo, "example.ts"), "unstaged\n");
    const before = await readFile(join(repo, ".git/index"));
    const workspace = await workspaces.add(repo);
    // When a working-tree snapshot is captured
    await workspaces.review(workspace.id, "@");
    // Then the user's index is unchanged
    expect(await readFile(join(repo, ".git/index"))).toEqual(before);
  });

  test("captures do not move HEAD", async () => {
    // Given a dirty working tree
    await writeFile(join(repo, "example.ts"), "edited\n");
    const before = await git("rev-parse", "HEAD");
    const workspace = await workspaces.add(repo);
    // When its snapshot is captured
    await workspaces.review(workspace.id, "@");
    // Then HEAD still identifies the user's commit
    expect(await git("rev-parse", "HEAD")).toBe(before);
  });

  test("@- reviews HEAD rather than working-tree edits", async () => {
    // Given a feature commit followed by local edits
    await featureCommit();
    await writeFile(join(repo, "example.ts"), "not committed\n");
    const workspace = await workspaces.add(repo);
    // When the previous commit is selected
    const review = await workspaces.review(workspace.id, "@-");
    // Then only the committed change is shown
    expect(parseInput(review.patch)[0].additionLines).toEqual(["export const value = 2;\n"]);
  });

  test("accepts native Git revision selectors", async () => {
    // Given a feature commit
    await featureCommit();
    const workspace = await workspaces.add(repo);
    // When the parent of HEAD is selected
    const review = await workspaces.review(workspace.id, "HEAD~1");
    // Then the root commit can be reviewed
    expect(review.selected.description.trim()).toBe("Initial commit");
  });

  test("full context rejects a file edited since the diff was generated", async () => {
    // Given a capture of local edits
    await writeFile(join(repo, "example.ts"), "reviewed\n");
    const workspace = await workspaces.add(repo);
    const review = await workspaces.review(workspace.id, "@");
    // And later edits to the same file
    await writeFile(join(repo, "example.ts"), "later edits\n");
    // When full context is loaded
    const contents = workspaces.contents(workspace.id, review.selected.commit_id, "example.ts");
    // Then it asks for a refresh instead of mixing old diff lines with new source
    await expect(contents).rejects.toThrow("The Git working copy changed. Refresh the review");
  });

  test("working-tree reviews do not write any Git objects", async () => {
    // Given local edits not stored in Git's object database
    await writeFile(join(repo, "example.ts"), "reviewed\n");
    const workspace = await workspaces.add(repo);
    const before = await git("count-objects", "-v");
    // When both working-tree and branch reviews are generated
    await workspaces.review(workspace.id, "@");
    await workspaces.bookmarkReview(workspace.id);
    // Then no blobs, trees, or commits have been created
    expect(await git("count-objects", "-v")).toBe(before);
  });

  test("unchanged working-tree reviews have the same freshness token", async () => {
    // Given local edits
    await writeFile(join(repo, "example.ts"), "reviewed\n");
    const workspace = await workspaces.add(repo);
    const first = await workspaces.review(workspace.id, "@");
    // When the same tree is captured again
    const second = await workspaces.review(workspace.id, "@");
    // Then its freshness token is unchanged
    expect(second.selected.commit_id).toBe(first.selected.commit_id);
  });

  test("a clean working tree has an empty @ diff", async () => {
    // Given a clean Git working copy
    const workspace = await workspaces.add(repo);
    // When @ is reviewed
    const review = await workspaces.review(workspace.id, "@");
    // Then committed changes are not mistaken for local edits
    expect(review.patch).toBe("");
  });

  test("ignored untracked files stay out of snapshots", async () => {
    // Given an ignored local file
    await writeFile(join(repo, ".gitignore"), "secret.txt\n");
    await writeFile(join(repo, "secret.txt"), "private\n");
    const workspace = await workspaces.add(repo);
    // When the working tree is captured
    const review = await workspaces.review(workspace.id, "@");
    // Then only the ignore rule is reviewed
    expect(parseInput(review.patch).map((file) => file.name)).toEqual([".gitignore"]);
  });

  test("staged ignored files remain in snapshots", async () => {
    // Given a file staged despite its ignore rule
    await writeFile(join(repo, ".gitignore"), "forced.txt\n");
    await writeFile(join(repo, "forced.txt"), "tracked\n");
    await git("add", "--force", "forced.txt");
    const workspace = await workspaces.add(repo);
    // When the working tree is captured
    const review = await workspaces.review(workspace.id, "@");
    // Then the staged ignored file remains included
    expect(parseInput(review.patch).map((file) => file.name).sort()).toEqual([".gitignore", "forced.txt"]);
  });

  test("automatic branch reviews include committed and working-tree edits", async () => {
    // Given a feature commit and subsequent local edits
    await featureCommit();
    await writeFile(join(repo, "example.ts"), "export const value = 3;\n");
    const workspace = await workspaces.add(repo);
    // When the current branch is reviewed
    const review = await workspaces.bookmarkReview(workspace.id);
    // Then the complete branch range is shown
    expect(parseInput(review.patch)[0].additionLines).toEqual(["export const value = 3;\n"]);
  });

  test("explicit branch reviews exclude local edits", async () => {
    // Given a feature commit and subsequent local edits
    await featureCommit();
    await writeFile(join(repo, "example.ts"), "not committed\n");
    const workspace = await workspaces.add(repo);
    // When that branch is explicitly selected
    const review = await workspaces.bookmarkReview(workspace.id, "feature/test");
    // Then the branch tip, not the working tree, is reviewed
    expect(parseInput(review.patch)[0].additionLines).toEqual(["export const value = 2;\n"]);
  });

  test("branch bases use the fork point when main has advanced", async () => {
    // Given a feature commit
    await featureCommit();
    // And unrelated upstream work after the fork
    await git("switch", "main");
    await writeFile(join(repo, "upstream.ts"), "upstream\n");
    await git("add", ".");
    await git("commit", "-m", "Advance main");
    await git("switch", "feature/test");
    const workspace = await workspaces.add(repo);
    // When the branch is reviewed
    const review = await workspaces.bookmarkReview(workspace.id);
    // Then upstream changes do not appear as reversions
    expect(parseInput(review.patch).map((file) => file.name)).toEqual(["example.ts"]);
  });

  test("a branch commit can be selected from its range", async () => {
    // Given committed and uncommitted branch changes
    await featureCommit();
    const head = (await git("rev-parse", "HEAD")).trim();
    await writeFile(join(repo, "example.ts"), "not committed\n");
    const workspace = await workspaces.add(repo);
    // When just the committed change is selected
    const review = await workspaces.bookmarkReview(workspace.id, undefined, head);
    // Then the selected commit excludes later edits
    expect(parseInput(review.patch)[0].additionLines).toEqual(["export const value = 2;\n"]);
  });

  test("detached HEAD still supports branch-range reviews", async () => {
    // Given a detached feature commit
    await featureCommit();
    await git("switch", "--detach");
    const workspace = await workspaces.add(repo);
    // When the unnamed range is reviewed
    const review = await workspaces.bookmarkReview(workspace.id);
    // Then its committed changes are shown
    expect(parseInput(review.patch)[0].additionLines).toEqual(["export const value = 2;\n"]);
  });

  test("unborn branches support working-tree range reviews", async () => {
    // Given a Git repository with files but no commits
    const unborn = join(directory, "unborn");
    await mkdir(unborn);
    await runCommand(["git", "init", "--initial-branch=main"], { cwd: unborn });
    await writeFile(join(unborn, "new.ts"), "new\n");
    const workspace = await workspaces.add(unborn);
    // When its initial work is reviewed
    const review = await workspaces.bookmarkReview(workspace.id);
    // Then the initial file is visible without requiring Git identity configuration
    expect(parseInput(review.patch)[0].additionLines).toEqual(["new\n"]);
  });

  test("full context follows renamed files", async () => {
    // Given a renamed file with retained content
    await git("mv", "example.ts", "renamed.ts");
    const workspace = await workspaces.add(repo);
    const review = await workspaces.review(workspace.id, "@");
    // When its full context is loaded
    const contents = await workspaces.contents(workspace.id, review.selected.commit_id, "renamed.ts");
    // Then both paths and contents are preserved
    expect(contents).toEqual({ oldFile: { name: "example.ts", contents: "export const value = 1;\n" }, newFile: { name: "renamed.ts", contents: "export const value = 1;\n" } });
  });

  test("whitespace-only edits produce an empty patch", async () => {
    // Given only spacing changes
    await writeFile(join(repo, "example.ts"), "  export const value=1;  \n");
    const workspace = await workspaces.add(repo);
    // When @ is reviewed
    const review = await workspaces.review(workspace.id, "@");
    // Then formatting-only files are omitted
    expect(review.patch).toBe("");
  });

  test("discovery includes Git repositories and linked worktrees", async () => {
    // Given a folder holding a Git repository and a linked worktree
    const folder = await mkdtemp(join(directory, "discovery-"));
    const linked = join(folder, "linked");
    await git("worktree", "add", "-b", "linked", linked);
    // When that folder is scanned
    const found = await workspaces.discover(folder);
    // Then the .git file is recognized as a working copy
    expect(found.map((entry) => entry.path)).toEqual([linked]);
  });

  test("linked worktree snapshots use that worktree's files", async () => {
    // Given a dirty linked worktree
    const linked = await mkdtemp(join(directory, "linked-"));
    await git("worktree", "add", "-b", "linked", linked);
    await writeFile(join(linked, "example.ts"), "linked edit\n");
    const workspace = await workspaces.add(linked);
    // When its working tree is reviewed
    const review = await workspaces.review(workspace.id, "@");
    // Then the primary working tree is not used
    expect(parseInput(review.patch)[0].additionLines).toEqual(["linked edit\n"]);
  });

  test("local repository lookup returns normalized GitHub remotes", async () => {
    // Given a GitHub remote
    await git("remote", "add", "origin", "git@github.com:Example/Project.git");
    const workspace = await workspaces.add(repo);
    // When optional PR-link evidence is collected
    const repositories = await workspaces.localRepositories([workspace.id]);
    // Then duplicate fetch/push URLs yield one repository identity
    expect(repositories[0].repositories).toEqual(["example/project"]);
  });

  test("review lifetime survives subsequent uncommitted edits", async () => {
    // Given a branch review containing only local edits
    await writeFile(join(repo, "example.ts"), "first edit\n");
    const workspace = await workspaces.add(repo);
    const first = await localReview(storage, await workspaces.bookmarkReview(workspace.id));
    // And a later edit on the same branch
    await writeFile(join(repo, "example.ts"), "second edit\n");
    // When the range is refreshed
    const second = await localReview(storage, await workspaces.bookmarkReview(workspace.id));
    // Then comments and progress retain the same review lifetime
    expect(second.id).toBe(first.id);
  });

  test("rejects revision options rather than executing them", async () => {
    // Given a registered Git working copy
    const workspace = await workspaces.add(repo);
    // When a command-line switch is supplied as a revision
    const result = workspaces.review(workspace.id, "--output=injected");
    // Then validation rejects it
    await expect(result).rejects.toThrow("Choose @, @-, a Git ref, or a commit ID.");
  });

  test("agent reviews include uncommitted edits by default", async () => {
    // Given uncommitted work in a Git-only repository
    await writeFile(join(repo, "example.ts"), "agent edit\n");
    const api = createApi({ storage, workspaces, reviews: new Reviews(storage), github: new GitHub() });
    // When an agent starts its default review
    const response = await api(new Request("http://localhost/api/reviews", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: repo, agentSession: "test" }) }));
    const review = await response.json() as ReviewSession;
    // Then the agent's working-tree edit is present
    expect(parseInput(review.snapshot.patch)[0].additionLines).toEqual(["agent edit\n"]);
  });

  test("commit review progress uses a scope accepted by the API", async () => {
    // Given a Git commit review with a SHA-1 commit ID
    await featureCommit();
    const workspace = await workspaces.add(repo);
    const review = await workspaces.review(workspace.id, "HEAD");
    const api = createApi({ storage, workspaces, github: new GitHub() });
    // When its progress is read
    const response = await api(new Request(`http://localhost/api/workspaces/${workspace.id}/changes/${review.progressScope}/progress`));
    // Then the API accepts the Git review scope
    expect(response.status).toBe(200);
  });

  test("split-index working copies can be captured", async () => {
    // Given Git's split-index optimization and local edits
    await git("update-index", "--split-index");
    await writeFile(join(repo, "example.ts"), "split index edit\n");
    const workspace = await workspaces.add(repo);
    // When the working tree is reviewed
    const review = await workspaces.review(workspace.id, "@");
    // Then the shared index is resolved without changing the user's staging state
    expect(parseInput(review.patch)[0].additionLines).toEqual(["split index edit\n"]);
  });

  test("committing a working capture retains its review lifetime", async () => {
    // Given a branch review containing uncommitted edits
    await writeFile(join(repo, "example.ts"), "reviewed edit\n");
    const workspace = await workspaces.add(repo);
    const first = await localReview(storage, await workspaces.bookmarkReview(workspace.id));
    // And those exact edits become a normal Git commit
    await git("add", ".");
    await git("commit", "-m", "Commit reviewed edits");
    // When the branch review is refreshed
    const second = await localReview(storage, await workspaces.bookmarkReview(workspace.id));
    // Then the capture's comments remain in the same review
    expect(second.id).toBe(first.id);
  });

  test("colocated repositories still use JJ working commits", async () => {
    // Given a Git repository that is also a JJ workspace
    await git("switch", "main");
    await runCommand(["jj", "git", "init", "--colocate"], { cwd: repo });
    await writeFile(join(repo, "example.ts"), "JJ edit\n");
    const workspace = await workspaces.add(repo);
    // When its current work is reviewed
    const review = await workspaces.review(workspace.id, "@");
    // Then the selected identity is a real JJ change ID
    expect(/^[k-z]{32}$/.test(review.selected.change_id)).toBe(true);
  });

  test("nested Git repositories do not register their enclosing JJ workspace", async () => {
    // Given a JJ workspace containing a separate Git repository
    await runCommand(["jj", "git", "init", "--colocate"], { cwd: repo });
    const nested = join(repo, "nested");
    await mkdir(nested);
    await runCommand(["git", "init", "--initial-branch=main"], { cwd: nested });
    // When the nested repository is registered
    const workspace = await workspaces.add(nested);
    // Then its own Git root wins over the enclosing JJ root
    expect(workspace.path).toBe(nested);
  });

  test("agent comments remain attached when a Git capture is refreshed", async () => {
    // Given an agent review with a comment on uncommitted work
    await writeFile(join(repo, "example.ts"), "reviewed edit\n");
    const api = createApi({ storage, workspaces, reviews: new Reviews(storage), github: new GitHub() });
    const started = await api(new Request("http://localhost/api/reviews", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: repo, agentSession: "test" }) }));
    const review = await started.json() as ReviewSession;
    const posted = await api(new Request(`http://localhost/api/reviews/${review.id}/threads`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: "example.ts", side: "RIGHT", line: 1, commitId: review.snapshot.selected.commit_id, baseCommitId: review.snapshot.base?.commit_id, body: "Explain this edit" }) }));
    if (!posted.ok) throw new Error(await posted.text());
    // And the working tree changes after that capture
    await writeFile(join(repo, "extra.ts"), "later edit\n");
    // When the agent refreshes its review
    const refreshed = await api(new Request(`http://localhost/api/reviews/${review.id}/refresh`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }));
    const current = await refreshed.json() as ReviewSession;
    // Then the comment survives with its immutable source excerpt
    expect(current.threads[0]).toMatchObject({ anchor: { excerpt: "reviewed edit\n" }, messages: [{ body: "Explain this edit" }] });
  });

  test("unchanged live files supply full context", async () => {
    // Given a live review of local edits
    await writeFile(join(repo, "example.ts"), "reviewed\n");
    const workspace = await workspaces.add(repo);
    const review = await workspaces.review(workspace.id, "@");
    // When full context is loaded without an intervening edit
    const contents = await workspaces.contents(workspace.id, review.selected.commit_id, "example.ts");
    // Then it combines HEAD's blob with the current working-tree file
    expect(contents).toEqual({ oldFile: { name: "example.ts", contents: "export const value = 1;\n" }, newFile: { name: "example.ts", contents: "reviewed\n" } });
  });

  test("mtime changes reject same-size edits", async () => {
    // Given a live review of an eight-byte file
    await writeFile(join(repo, "example.ts"), "before!\n");
    const workspace = await workspaces.add(repo);
    const review = await workspaces.review(workspace.id, "@");
    const before = await stat(join(repo, "example.ts"));
    // And a same-size replacement with a later modification time
    await writeFile(join(repo, "example.ts"), "after!!\n");
    await utimes(join(repo, "example.ts"), before.atime, new Date(before.mtimeMs + 1000));
    // When old diff context is requested
    const contents = workspaces.contents(workspace.id, review.selected.commit_id, "example.ts");
    // Then mtime detects the stale read even though the size is unchanged
    await expect(contents).rejects.toThrow("The Git working copy changed. Refresh the review");
  });

  test("HEAD changes invalidate live context even when files are unchanged", async () => {
    // Given a working-tree review
    await writeFile(join(repo, "example.ts"), "reviewed\n");
    const workspace = await workspaces.add(repo);
    const review = await workspaces.review(workspace.id, "@");
    // And an empty commit that moves HEAD without touching the file
    await git("commit", "--allow-empty", "-m", "Move HEAD");
    // When old diff context is requested
    const contents = workspaces.contents(workspace.id, review.selected.commit_id, "example.ts");
    // Then it requires a refreshed baseline
    await expect(contents).rejects.toThrow("The Git working copy changed. Refresh the review");
  });

  test("staging changes invalidate live context", async () => {
    // Given an unstaged working-tree review
    await writeFile(join(repo, "example.ts"), "reviewed\n");
    const workspace = await workspaces.add(repo);
    const review = await workspaces.review(workspace.id, "@");
    // And the edit is staged without changing its working file
    await git("add", "example.ts");
    // When old diff context is requested
    const contents = workspaces.contents(workspace.id, review.selected.commit_id, "example.ts");
    // Then the changed index requires a refresh
    await expect(contents).rejects.toThrow("The Git working copy changed. Refresh the review");
  });

  test("unrelated file edits do not block fresh context", async () => {
    // Given a live diff with two edited files
    await writeFile(join(repo, "example.ts"), "reviewed\n");
    await writeFile(join(repo, "other.ts"), "first edit\n");
    const workspace = await workspaces.add(repo);
    const review = await workspaces.review(workspace.id, "@");
    // And only the unrelated file changes
    await writeFile(join(repo, "other.ts"), "later edit\n");
    // When context for the unchanged reviewed file is requested
    const contents = await workspaces.contents(workspace.id, review.selected.commit_id, "example.ts");
    // Then its context remains available
    expect(contents.newFile.contents).toBe("reviewed\n");
  });

  test("working-tree reviews do not create Git refs", async () => {
    // Given an edited working copy
    await writeFile(join(repo, "example.ts"), "reviewed\n");
    const workspace = await workspaces.add(repo);
    const before = await git("for-each-ref", "--format=%(refname) %(objectname)");
    // When local edits are reviewed
    await workspaces.review(workspace.id, "@");
    // Then no snapshot refs or branch changes are introduced
    expect(await git("for-each-ref", "--format=%(refname) %(objectname)")).toBe(before);
  });

  test("stale working-tree comments are rejected through the agent API", async () => {
    // Given an agent's live review
    await writeFile(join(repo, "example.ts"), "reviewed\n");
    const api = createApi({ storage, workspaces, reviews: new Reviews(storage), github: new GitHub() });
    const started = await api(new Request("http://localhost/api/reviews", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: repo, agentSession: "test" }) }));
    const review = await started.json() as ReviewSession;
    // And that file changes before a comment is submitted
    await writeFile(join(repo, "example.ts"), "different content\n");
    // When a comment is submitted against the old diff
    const response = await api(new Request(`http://localhost/api/reviews/${review.id}/threads`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: "example.ts", side: "RIGHT", line: 1, commitId: review.snapshot.selected.commit_id, baseCommitId: review.snapshot.base?.commit_id, body: "Old line" }) }));
    // Then the API requests a refresh rather than anchoring to different code
    expect(await response.json()).toEqual({ error: "The Git working copy changed. Refresh the review before loading context or commenting." });
  });

  test("edits while the diff command is held are rejected before accepting the review", async () => {
    // Given local edits and a native diff command whose completed output is held
    await writeFile(join(repo, "example.ts"), "first edit\n");
    let release!: () => void;
    let generated!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const ready = new Promise<void>((resolve) => { generated = resolve; });
    const heldWorkspaces = new Workspaces(storage, async (args, options) => {
      const output = await runCommand(args, options);
      if (args[0] === "git" && args[1] === "diff" && args.includes("--unified=5")) { generated(); await held; }
      return output;
    });
    const workspace = await heldWorkspaces.add(repo);
    const review = heldWorkspaces.review(workspace.id, "@");
    await ready;
    // When the reviewed file changes before that output is accepted
    await writeFile(join(repo, "example.ts"), "different edit\n");
    release();
    // Then stale diff output is rejected instead of recording the new stamp against old lines
    await expect(review).rejects.toThrow("The Git working copy changed. Refresh the review");
  });

  test("committed context still comes from Git after later working-tree edits", async () => {
    // Given an ordinary committed revision
    await featureCommit();
    const workspace = await workspaces.add(repo);
    const review = await workspaces.review(workspace.id, "HEAD");
    // And a later edit to its working file
    await writeFile(join(repo, "example.ts"), "not committed\n");
    // When committed context is requested
    const contents = await workspaces.contents(workspace.id, review.selected.commit_id, "example.ts");
    // Then Git's committed blob, not the live file, supplies the source
    expect(contents.newFile.contents).toBe("export const value = 2;\n");
  });

  test("an unborn working-tree review can save a local comment without a fabricated base", async () => {
    // Given a working copy with no commits
    const unborn = join(directory, "unborn-comment");
    await mkdir(unborn);
    await runCommand(["git", "init", "--initial-branch=main"], { cwd: unborn });
    await writeFile(join(unborn, "new.ts"), "new\n");
    const workspace = await workspaces.add(unborn);
    const api = createApi({ storage, workspaces, github: new GitHub() });
    const response = await api(new Request(`http://localhost/api/workspaces/${workspace.id}/review`));
    const review = await response.json() as LocalReview;
    // When a local comment is saved on its initial work
    const saved = await api(new Request(`http://localhost/api/workspaces/${workspace.id}/changes/${review.progressScope}/discussion`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "create", path: "new.ts", side: "RIGHT", line: 1, commitId: review.selected.commit_id, body: "Explain this" }) }));
    // Then it succeeds without manufacturing an empty Git commit
    expect(saved.status).toBe(200);
  });

  test("committed diffs do not lazily fetch missing objects into partial clones", async () => {
    // Given a real partial clone whose blobs have not been downloaded
    await git("config", "uploadpack.allowFilter", "true");
    const partial = join(directory, "partial-clone");
    await runCommand(["git", "clone", "--filter=blob:none", "--no-checkout", `file://${repo}`, partial]);
    const workspace = await workspaces.add(partial);
    const before = await runCommand(["git", "count-objects", "-v"], { cwd: partial });
    // When a committed diff requires a missing blob
    await workspaces.review(workspace.id, "HEAD").catch(() => undefined);
    // Then the review has not fetched and persisted the blob
    expect(await runCommand(["git", "count-objects", "-v"], { cwd: partial })).toBe(before);
  });

  /** Run Git against the current test's real repository. */
  function git(...args: string[]): Promise<string> { return runCommand(["git", ...args], { cwd: repo }); }

  /** Add one committed feature change above main. */
  async function featureCommit(): Promise<void> {
    await writeFile(join(repo, "example.ts"), "export const value = 2;\n");
    await git("add", ".");
    await git("commit", "-m", "Feature change");
  }
});
