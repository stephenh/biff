import { createHash } from "node:crypto";
import { lstat, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";
import { parsePatchFiles } from "@pierre/diffs";
import type { GitFileStamp, GitWorkingTree, LocalReview, Revision, WorkingCopy } from "../shared/types";
import { runCommand, type RunCommand } from "./commands";
import type { LocalGitRepository } from "./localWorkspaceProvider";
import type { WorkspaceProvider } from "./workspaceProvider";

const diffOptions = ["--no-ext-diff", "--no-textconv", "--no-color", "--src-prefix=a/", "--dst-prefix=b/", "--find-renames", "--ignore-all-space", "--unified=5"];
const staleWorkingTree = "The Git working copy changed. Refresh the review before loading context or commenting.";
// Even read commands can refresh the index or fetch missing objects in a partial clone.
const gitReadEnvironment = { GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1" };

/** Read native Git diffs without creating commits, objects, refs, or a private index. */
export class GitWorkspaceProvider implements WorkspaceProvider {
  constructor(private run: RunCommand = runCommand) {}

  /** @ reviews all local changes against HEAD; @- reviews HEAD's commit diff. */
  async review(workspace: WorkingCopy, revision: string): Promise<LocalReview> {
    const head = await this.head(workspace);
    const revisions = head ? await this.log(workspace, ["--max-count=10", head.commit_id]) : [];
    const bookmark = await this.branch(workspace);
    if (revision === "@" || revision === workingProgressScope(workspace)) {
      const working = await this.workingReview(workspace, head?.commit_id);
      if (working.workingTree.head !== head?.commit_id || working.workingTree.branch !== bookmark) throw new Error(staleWorkingTree);
      return { ...working, revisions, bookmark };
    }
    const selected = await this.revision(workspace, await this.resolve(workspace, revision === "@-" ? "HEAD" : revision));
    return { workspace: gitWorkspace(workspace), selected, revisions, patch: await this.patch(workspace, selected.commit_id, await this.parent(workspace, selected.commit_id)), bookmark, progressScope: createHash("sha256").update(selected.change_id).digest("hex") };
  }

  /**
   * Compare a branch with its fork point, keeping explicit selections separate from local edits.
   *
   * The empty bookmark is the agent's working-copy scope. Inferred branches follow local
   * edits too, while explicit branch names use only their committed tip.
   */
  async bookmarkReview(workspace: WorkingCopy, bookmark?: string, changes = "all", baseOverride?: string, followWorkingCopy = bookmark === undefined): Promise<LocalReview> {
    const options = { cwd: workspace.path, env: gitReadEnvironment };
    const bookmarks = (await this.run(["git", "for-each-ref", "--format=%(refname:short)", "refs/heads/"], options)).trim().split("\n").filter(Boolean);
    const current = await this.branch(workspace);
    bookmark ??= current;
    const head = await this.head(workspace);
    if (bookmark && !bookmarks.includes(bookmark) && (head || bookmark !== current)) throw new Error("Branch not found");
    const bookmarkTip = bookmark && head ? await this.revision(workspace, await this.resolve(workspace, `refs/heads/${bookmark}`)) : head;
    const target = baseOverride ? { id: await this.resolve(workspace, baseOverride === "@-" ? "HEAD" : baseOverride), label: baseOverride } : await this.defaultBase(workspace, bookmarkTip);
    const baseId = target.id && bookmarkTip ? (await this.run(["git", "merge-base", bookmarkTip.commit_id, target.id], options)).trim() : target.id;
    const base = baseId ? await this.revision(workspace, baseId) : undefined;
    const commits = bookmarkTip ? await this.log(workspace, [baseId ? `${baseId}..${bookmarkTip.commit_id}` : bookmarkTip.commit_id]) : [];
    const live = !bookmarkTip || !bookmark || (followWorkingCopy && bookmark === current);
    const working = live ? await this.workingReview(workspace, changes === "all" ? baseId : head?.commit_id) : undefined;
    if (working && (working.workingTree.head !== head?.commit_id || working.workingTree.branch !== current)) throw new Error(staleWorkingTree);
    const revisions = working ? [working.selected, ...commits] : commits;
    const tip = working?.selected ?? bookmarkTip!;
    const selected = changes === "all" ? tip : revisions.find((entry) => entry.change_id === changes || entry.commit_id === changes);
    if (!selected) throw new Error("Selected commit is not in this branch range");
    const workingTree = working && selected === working.selected ? working.workingTree : undefined;
    const patch = working && selected === working.selected ? working.patch : await this.patch(workspace, selected.commit_id, changes === "all" ? baseId : await this.parent(workspace, selected.commit_id));
    const progressScope = createHash("sha256").update(changes === "all" ? JSON.stringify([bookmark ? `branch:${bookmark}` : "wip", baseOverride || `auto:${target.label}`]) : selected.change_id).digest("hex");
    return { workspace: gitWorkspace(workspace), revisions, selected, patch, bookmark, bookmarks, base, baseLabel: target.label, tip, bookmarkTip: bookmarkTip ?? tip, changes, baseOverride, progressScope, followWorkingCopy, workingTree };
  }

  /**
   * Read committed blobs or live files whose metadata still matches the displayed diff.
   *
   * A live version is only a stale-read token, not a Git commit or retained file contents.
   */
  async contents(workspace: WorkingCopy, commit: string, path: string, base?: string, workingTree?: GitWorkingTree) {
    if (commit.startsWith("worktree:")) {
      if (!workingTree || workingVersion(workingTree) !== commit || (base && base !== workingTree.base)) throw new Error(staleWorkingTree);
      return this.workingContents(workspace, workingTree, path);
    }
    if (!/^[a-f0-9]{40,64}$/.test(commit)) throw new Error("Invalid commit");
    if (base && !/^[a-f0-9]{40,64}$/.test(base)) throw new Error("Invalid base commit");
    const from = base ?? await this.parent(workspace, commit);
    const options = { cwd: workspace.path, env: gitReadEnvironment };
    const names = (await this.run(["git", ...(from ? ["diff", from, commit] : ["diff-tree", "--root", "--no-commit-id", "-r", commit]), "--name-status", "-z", "--find-renames", "--"], options)).split("\0");
    let change: { status: string; previous: string } | undefined;
    for (let index = 0; index < names.length - 1;) {
      const status = names[index++];
      const old = names[index++];
      const next = /^[RC]/.test(status) ? names[index++] : old;
      if (next === path) change = { status, previous: old };
    }
    if (!change) throw new Error("File not found in this revision");
    // Pure renames have no hunks even with unlimited diff context, so read the blobs directly.
    const oldContents = change.status === "A" ? "" : await this.run(["git", "show", "--no-textconv", `${from}:${change.previous}`], options);
    const newContents = change.status === "D" ? "" : await this.run(["git", "show", "--no-textconv", `${commit}:${path}`], options);
    return { oldFile: { name: change.previous, contents: oldContents }, newFile: { name: path, contents: newContents } };
  }

  /** Shared Git worktrees use the common object store and the same optional PR-link evidence. */
  async repository(workspace: WorkingCopy): Promise<LocalGitRepository> {
    const options = { cwd: workspace.path, env: gitReadEnvironment };
    const gitDirectory = (await this.run(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], options)).trim();
    const remotes = await this.run(["git", "remote", "-v"], options);
    const repositories = [...new Set(remotes.split("\n").flatMap((line) => {
      const url = line.trim().split(/\s+/)[1] ?? "";
      const repository = /^(?:(?:https?|ssh):\/\/(?:git@)?github\.com\/|git@github\.com:)([\w.-]+\/[\w.-]+?)\/?$/.exec(url.replace(/\.git\/?$/, ""))?.[1]?.toLowerCase();
      return repository ? [repository] : [];
    }))];
    return { gitDirectory, repositories, workspaces: [workspace.id] };
  }

  /** Resolve refs as data, never as command-line switches or arbitrary Git expressions. */
  private async resolve(workspace: WorkingCopy, revision: string): Promise<string> {
    if (!revision || revision.startsWith("-") || /[\s\0]/.test(revision)) throw new Error("Choose @, @-, a Git ref, or a commit ID.");
    return (await this.run(["git", "rev-parse", "--verify", "--end-of-options", `${revision}^{commit}`], { cwd: workspace.path, env: gitReadEnvironment })).trim();
  }

  /** An unborn branch has no HEAD to include in its working-tree review. */
  private async head(workspace: WorkingCopy): Promise<Revision | undefined> {
    const id = await this.headId(workspace);
    return id ? this.revision(workspace, id) : undefined;
  }

  /** HEAD changes can invalidate a live diff without changing a file's timestamps. */
  private async headId(workspace: WorkingCopy): Promise<string | undefined> {
    return (await this.run(["git", "rev-parse", "--verify", "--quiet", "HEAD"], { cwd: workspace.path, env: gitReadEnvironment }).catch(() => "")).trim() || undefined;
  }

  /** Detached HEAD has no branch name. */
  private async branch(workspace: WorkingCopy): Promise<string> {
    return (await this.run(["git", "symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: workspace.path, env: gitReadEnvironment }).catch(() => "")).trim();
  }

  /** Read descriptions as NUL-delimited records so multiline messages remain intact. */
  private async log(workspace: WorkingCopy, revisions: string[]): Promise<Revision[]> {
    const output = await this.run(["git", "log", "--no-show-signature", "--format=%H%x00%an%x00%ae%x00%aI%x00%B%x00", ...revisions, "--"], { cwd: workspace.path, env: gitReadEnvironment });
    const fields = output.split("\0");
    const result: Revision[] = [];
    for (let index = 0; index + 4 < fields.length; index += 5) {
      const id = fields[index].trim();
      result.push({ commit_id: id, change_id: id, author: { name: fields[index + 1], email: fields[index + 2], timestamp: fields[index + 3] }, description: fields[index + 4] });
    }
    return result;
  }

  /** Read exactly one immutable commit. */
  private async revision(workspace: WorkingCopy, commit: string): Promise<Revision> {
    return (await this.log(workspace, ["--max-count=1", commit]))[0];
  }

  /** Git commit diffs compare with the first parent; root commits have no base. */
  private async parent(workspace: WorkingCopy, commit: string): Promise<string | undefined> {
    return (await this.run(["git", "rev-list", "--parents", "--max-count=1", commit], { cwd: workspace.path, env: gitReadEnvironment })).trim().split(" ")[1];
  }

  /** Prefer the local default branch, without fetching or requiring a configured remote. */
  private async defaultBase(workspace: WorkingCopy, head?: Revision): Promise<{ id?: string; label: string }> {
    for (const name of ["refs/remotes/origin/HEAD", "refs/heads/main", "refs/heads/master"]) {
      const id = await this.resolve(workspace, name).catch(() => undefined);
      if (id) return { id, label: name.replace(/^refs\/(heads|remotes)\//, "") };
    }
    const parent = head ? await this.parent(workspace, head.commit_id) : undefined;
    return { id: parent, label: parent ? "HEAD^" : "empty tree" };
  }

  /** Native Git whitespace filtering keeps formatting-only files out of the review. */
  private async patch(workspace: WorkingCopy, commit: string, base?: string): Promise<string> {
    return this.run(["git", ...(base ? ["diff", base, commit] : ["diff-tree", "--root", "--no-commit-id", "--patch", commit]), ...diffOptions, "--"], { cwd: workspace.path, env: gitReadEnvironment });
  }

  /** Read the actual per-worktree index's stamp, without updating or copying it. */
  private async indexStamp(workspace: WorkingCopy): Promise<GitFileStamp | null> {
    const index = (await this.run(["git", "rev-parse", "--path-format=absolute", "--git-path", "index"], { cwd: workspace.path, env: gitReadEnvironment })).trim();
    return fileStamp(index);
  }

  /**
   * Generate a native working-tree diff and remember only file timestamps and sizes.
   *
   * Check before and after reading so edits during diff generation cannot be accepted as
   * fresh context. Untracked files use Git's no-index diff, which returns 1 for differences.
   */
  private async workingReview(workspace: WorkingCopy, base?: string): Promise<LocalReview & { workingTree: GitWorkingTree }> {
    const options = { cwd: workspace.path, env: gitReadEnvironment };
    const head = await this.headId(workspace);
    const branch = await this.branch(workspace);
    const index = await this.indexStamp(workspace);
    const untracked = splitPaths(await this.run(["git", "ls-files", "--others", "--exclude-standard", "-z"], options));
    const tracked = splitPaths(await this.run(["git", ...(base ? ["diff", "--name-only", "-z", base, "--"] : ["ls-files", "--cached", "-z"])], options));
    const paths = [...new Set([...tracked, ...untracked])].sort();
    const stamps = new Map(await Promise.all(paths.map(async (path) => [path, await fileStamp(join(workspace.path, path))] as const)));
    let patch = base ? await this.run(["git", "diff", base, ...diffOptions, "--"], options) : "";
    for (const path of base ? untracked : paths) {
      if (!stamps.get(path)) continue;
      patch += await this.run(["git", "diff", "--no-index", ...diffOptions, "--", "/dev/null", path], { ...options, allowedExitCodes: [1] });
    }
    const files = Object.fromEntries(parsePatchFiles(patch, undefined, true).flatMap((entry) => entry.files).map((file) => [file.name, {
      stamp: stamps.get(file.name) ?? null, oldPath: file.prevName ?? file.name, added: file.type === "new", deleted: file.type === "deleted",
    }]));
    const workingTree: GitWorkingTree = { head, branch, index, base, files };
    await this.checkWorkingTree(workspace, workingTree, Object.keys(files));
    const selected: Revision = { commit_id: workingVersion(workingTree), change_id: workingProgressScope(workspace), description: "Working tree changes", author: { name: "", email: "", timestamp: "" } };
    return { workspace: gitWorkspace(workspace), selected, revisions: [], patch, workingTree, progressScope: selected.change_id };
  }

  /** Reject stale live context without invalidating unrelated file reads. */
  private async checkWorkingTree(workspace: WorkingCopy, workingTree: GitWorkingTree, paths: string[]): Promise<void> {
    if (await this.headId(workspace) !== workingTree.head || await this.branch(workspace) !== workingTree.branch || !sameStamp(await this.indexStamp(workspace), workingTree.index)) throw new Error(staleWorkingTree);
    for (const path of paths) {
      if (!sameStamp(await fileStamp(join(workspace.path, path)), workingTree.files[path].stamp)) throw new Error(staleWorkingTree);
    }
  }

  /** Live source reads are guarded on both sides so an edit during readFile also fails safely. */
  private async workingContents(workspace: WorkingCopy, workingTree: GitWorkingTree, path: string) {
    if (!Object.hasOwn(workingTree.files, path)) throw new Error("File not found in this review");
    await this.checkWorkingTree(workspace, workingTree, [path]);
    const file = workingTree.files[path];
    try {
      const oldContents = file.added || !workingTree.base ? "" : await this.run(["git", "show", "--no-textconv", `${workingTree.base}:${file.oldPath}`], { cwd: workspace.path, env: gitReadEnvironment });
      const newContents = file.deleted ? "" : await workingFileContents(join(workspace.path, path));
      return { oldFile: { name: file.oldPath, contents: oldContents }, newFile: { name: path, contents: newContents } };
    } finally {
      await this.checkWorkingTree(workspace, workingTree, [path]);
    }
  }
}

/** Old registry rows need no migration; reviews carry the backend used for their labels. */
function gitWorkspace(workspace: WorkingCopy): WorkingCopy {
  return { ...workspace, vcs: "git" };
}

/** Git working-tree progress follows the workspace until the user starts a new review. */
function workingProgressScope(workspace: WorkingCopy): string {
  return createHash("sha256").update(`git-working-copy:${workspace.id}`).digest("hex");
}

/** This token detects stale reads; it does not name a Git object or preserve old contents. */
function workingVersion(workingTree: GitWorkingTree): string {
  return `worktree:${createHash("sha256").update(JSON.stringify(workingTree)).digest("hex")}`;
}

/** NUL-delimited Git paths can include whitespace and newlines. */
function splitPaths(output: string): string[] {
  return output.split("\0").filter(Boolean);
}

/** Missing files are part of a deletion; permission and other filesystem errors stay visible. */
async function fileStamp(path: string): Promise<GitFileStamp | null> {
  try {
    const stat = await lstat(path);
    return { mtimeMs: stat.mtimeMs, size: stat.size };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Detect normal editor writes without hashing or archiving file contents. */
function sameStamp(left: GitFileStamp | null, right: GitFileStamp | null): boolean {
  return left?.mtimeMs === right?.mtimeMs && left?.size === right?.size;
}

/** Git diffs a symlink's target text, not the contents of the file it points to. */
async function workingFileContents(path: string): Promise<string> {
  return (await lstat(path)).isSymbolicLink() ? readlink(path) : readFile(path, "utf8");
}
