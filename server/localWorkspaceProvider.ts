import { createHash } from "node:crypto";
import { readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { LocalReview, Revision, WorkingCopy } from "../shared/types";
import { runCommand, type RunCommand } from "./commands";
import { parsePatchFiles } from "@pierre/diffs";
import type { WorkspaceProvider } from "./workspaceProvider";

export interface LocalGitRepository { gitDirectory: string; repositories: string[]; workspaces: string[] }

/** Execute local JJ operations without owning review state or the central workspace registry. */
export class LocalWorkspaceProvider implements WorkspaceProvider {
  constructor(private run: RunCommand = runCommand) {}

  /** Resolve a subdirectory to its JJ workspace root and register it once. */
  async add(path: string, name?: string): Promise<WorkingCopy> {
    const expanded = path.startsWith("~/") ? join(homedir(), path.slice(2)) : resolve(path);
    const root = await realpath((await this.run(["jj", "root", "--no-pager"], { cwd: expanded })).trim());
    const entry = { id: createHash("sha256").update(root).digest("hex").slice(0, 16), name: name?.trim() || basename(root), path: root };
    return entry;
  }

  /** Find immediate child directories containing .jj, rather than crawling source trees. */
  async discover(path: string): Promise<WorkingCopy[]> {
    const directory = path.startsWith("~/") ? join(homedir(), path.slice(2)) : resolve(path);
    const found: WorkingCopy[] = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (!(await stat(join(directory, entry.name, ".jj")).catch(() => undefined))?.isDirectory()) continue;
      found.push(await this.add(join(directory, entry.name)));
    }
    return found;
  }

  /** Snapshot once, then render an immutable commit ID so metadata and patch agree. */
  async review(workspace: WorkingCopy, revision: string): Promise<LocalReview> {
    if (!/^(@-?|[a-z0-9]{4,64})$/.test(revision)) throw new Error("Choose @, @-, or a revision from the recent list.");
    const options = { cwd: workspace.path };
    const template = 'json(self) ++ "\\n"';
    const selected = parseRevisions(await this.run(["jj", "log", "--no-graph", "--no-pager", "--color=never", "-r", revision, "-T", template], options));
    if (selected.length !== 1) throw new Error("Revision must identify exactly one commit.");
    const revisions = parseRevisions(await this.run(["jj", "log", "--ignore-working-copy", "--no-graph", "--no-pager", "--color=never", "--limit", "10", "-r", "ancestors(@, 10) ~ root()", "-T", template], options));
    const patch = await this.run(["jj", "diff", "--ignore-working-copy", "--no-pager", "--color=never", "--git", "--ignore-all-space", "--context", "5", "-r", selected[0].commit_id], options);
    const bookmark = (await this.run(["jj", "log", "--ignore-working-copy", "--no-graph", "--no-pager", "--color=never", "-r", selected[0].commit_id, "-T", 'bookmarks.map(|b| b.name()).join(", ")'], options)).trim();
    return { workspace, revisions, selected: selected[0], patch: omitHeaderOnlyFiles(patch), bookmark };
  }

  /** Recover omitted context from the same immutable JJ revision. */
  async contents(workspace: WorkingCopy, commit: string, path: string, base?: string) {
    if (!/^[a-f0-9]{40,64}$/.test(commit)) throw new Error("Invalid commit");
    if (base && !/^[a-f0-9]{40,64}$/.test(base)) throw new Error("Invalid base commit");
    // A full-context diff uses JJ's merged parent tree, including merge commits.
    const patch = await this.run(["jj", "diff", "--ignore-working-copy", "--no-pager", "--color=never", "--git", "--context", "2147483647", ...(base ? ["--from", base, "--to", commit] : ["-r", commit]), "--", `root-file:${path}`], { cwd: workspace.path });
    const file = parsePatchFiles(patch).flatMap((entry) => entry.files).find((entry) => entry.name === path);
    if (!file) throw new Error("File not found in this revision");
    return { oldFile: { name: file.prevName ?? path, contents: file.deletionLines.join("") }, newFile: { name: path, contents: file.additionLines.join("") } };
  }

  /** Identify local object storage and GitHub remotes without fetching or snapshotting the working copy. */
  async repository(workspace: WorkingCopy): Promise<LocalGitRepository> {
    const options = { cwd: workspace.path, env: { GIT_NO_LAZY_FETCH: "1" } };
    const remotes = await this.run(["jj", "git", "remote", "list", "--ignore-working-copy"], options);
    const repositories = remotes.split("\n").flatMap((line) => {
      const url = line.trim().split(/\s+/)[1] ?? "";
      const repository = /^(?:(?:https?|ssh):\/\/(?:git@)?github\.com\/|git@github\.com:)([\w.-]+\/[\w.-]+?)\/?$/.exec(url.replace(/\.git\/?$/, ""))?.[1]?.toLowerCase();
      return repository ? [repository] : [];
    });
    const gitDirectory = (await this.run(["jj", "git", "root", "--ignore-working-copy"], options)).trim();
    return { gitDirectory, repositories, workspaces: [workspace.id] };
  }

  /** An explicit header is optional; Git must not lazily fetch missing objects in partial clones. */
  async changeId(repository: LocalGitRepository, head: string): Promise<string | undefined> {
    if (!/^[a-f0-9]{40,64}$/.test(head)) throw new Error("Invalid PR head");
    const object = await this.run(["git", `--git-dir=${repository.gitDirectory}`, "cat-file", "commit", head], { env: { GIT_NO_LAZY_FETCH: "1" } });
    const headers = object.split("\n\n", 1)[0];
    return /^change-id ([k-z]{32})$/m.exec(headers)?.[1];
  }

  /**
   * Resolve a bookmark range once so the patch and later source requests use identical trees.
   *
   * Inferred reviews follow unbookmarked work above their bookmark. Explicit selections
   * stop at the bookmark; refreshing an inferred review preserves its original base policy.
   */
  async bookmarkReview(workspace: WorkingCopy, bookmark?: string, changes = "all", baseOverride?: string, followWorkingCopy = bookmark === undefined): Promise<LocalReview> {
    const run = this.run;
    const options = { cwd: workspace.path };

    /** Resolve revsets generated here, never arbitrary user-supplied expressions. */
    async function revisions(expression: string, snapshot = false): Promise<Revision[]> {
      return parseRevisions(await run(["jj", "log", ...(snapshot ? [] : ["--ignore-working-copy"]), "--no-graph", "--no-pager", "--color=never", "-r", expression, "-T", 'json(self) ++ "\\n"'], options));
    }

    const [working] = await revisions("@", true);
    const bookmarks = (await run(["jj", "bookmark", "list", "--ignore-working-copy", "-T", 'if(!remote, name ++ "\\n")'], options)).trim().split("\n").filter(Boolean);
    if (bookmark === undefined) {
      const attached = (await run(["jj", "log", "--ignore-working-copy", "--no-graph", "-r", working.commit_id, "-T", 'bookmarks.map(|b| b.name()).join("\\n")'], options)).trim().split("\n");
      bookmark = bookmarks.find((name) => attached.includes(name)) || "";
      if (!bookmark) {
        // `jj new` commonly leaves an unbookmarked @ above the work being reviewed.
        // Infer only a unique parent bookmark; merge parents and aliases can be ambiguous.
        const parents = await revisions(`parents(${working.commit_id})`);
        // Trunk is the base of new work, not a feature bookmark to review instead of @.
        if (parents.length === 1 && !(await revisions(`${parents[0].commit_id} & ancestors(trunk())`)).length) {
          const names = (await run(["jj", "log", "--ignore-working-copy", "--no-graph", "-r", parents[0].commit_id, "-T", 'bookmarks.map(|b| b.name()).join("\\n")'], options)).trim().split("\n");
          const candidates = bookmarks.filter((name) => names.includes(name));
          if (candidates.length === 1) bookmark = candidates[0];
        }
      }
    }
    if (bookmark && !bookmarks.includes(bookmark)) throw new Error("Bookmark not found");
    const tips = bookmark ? await revisions(`bookmarks(exact:${JSON.stringify(bookmark)})`) : [working];
    if (tips.length !== 1) throw new Error("Bookmark must identify one commit; resolve its conflict first");
    const bookmarkTip = tips[0];
    let tip = bookmarkTip;
    if (followWorkingCopy && bookmark && working.commit_id !== bookmarkTip.commit_id) {
      const ancestor = await revisions(`${bookmarkTip.commit_id} & ancestors(${working.commit_id})`);
      if (ancestor.length === 1) {
        const range = `${bookmarkTip.commit_id}..${working.commit_id}`;
        const named = await revisions(`(${range}) & bookmarks()`);
        // A new bookmark denotes another review. Empty jj-new commits alone do not
        // move the snapshot, but an agent's edits on @ must become visible on refresh.
        if (!named.length && (await revisions(`(${range}) ~ empty()`)).length) tip = working;
      }
    }
    // In a linear stack, the maximal bookmarked ancestor is the parent review.
    // Multiple incomparable ancestors (a merge) have no unambiguous parent bookmark.
    const forks = await revisions(`heads(ancestors(${bookmarkTip.commit_id}) & ancestors(trunk()))`);
    if (forks.length !== 1) throw new Error("Cannot infer an unambiguous trunk fork point");
    const parents = baseOverride ? [] : await revisions(`heads((ancestors(${bookmarkTip.commit_id}) ~ ${bookmarkTip.commit_id}) & bookmarks() & descendants(${forks[0].commit_id}))`);
    const baseExpression = baseOverride ? (baseOverride === "@" || baseOverride === "@-" ? baseOverride : JSON.stringify(baseOverride)) : `heads(ancestors(${bookmarkTip.commit_id}) & ancestors(trunk()))`;
    const targets = !baseOverride && parents.length === 1 ? parents : await revisions(baseExpression);
    if (targets.length !== 1) throw new Error("Choose a base that identifies exactly one commit");
    // A base branch may have advanced since this work forked. Compare from the common
    // ancestor so unrelated upstream changes do not appear as reversions in this review.
    const bases = baseOverride ? await revisions(`heads(ancestors(${tip.commit_id}) & ancestors(${targets[0].commit_id}))`) : targets;
    if (bases.length !== 1) throw new Error("Choose a base that identifies exactly one commit");
    const base = bases[0];
    const parentNames = !baseOverride && parents.length === 1 ? (await run(["jj", "log", "--ignore-working-copy", "--no-graph", "-r", base.commit_id, "-T", 'bookmarks.map(|b| b.name()).join(", ")'], options)).trim() : "";
    const baseLabel = baseOverride || parentNames || "trunk";
    const commits = await revisions(`${base.commit_id}..${tip.commit_id}`);
    const selected = changes === "all" ? tip : commits.find((entry) => entry.change_id === changes || entry.commit_id === changes);
    if (!selected) throw new Error("Selected commit is not in this bookmark range");
    const patch = await run(["jj", "diff", "--ignore-working-copy", "--no-pager", "--color=never", "--git", "--ignore-all-space", "--context", "5", ...(changes === "all" ? ["--from", base.commit_id, "--to", tip.commit_id] : ["-r", selected.commit_id])], options);
    // Include the chosen base policy, not its moving commit ID, in durable range progress.
    const progressScope = changes === "all" ? createHash("sha256").update(JSON.stringify([bookmark ? `bookmark:${bookmark}` : "wip", baseOverride || `auto:${baseLabel}`])).digest("hex") : selected.change_id;
    return { workspace, revisions: commits, selected, patch: omitHeaderOnlyFiles(patch), bookmark, bookmarks, base, baseLabel, tip, bookmarkTip, changes, baseOverride, progressScope, followWorkingCopy };
  }

}

/** Remove empty file entries left behind by JJ's native whitespace filtering. */
function omitHeaderOnlyFiles(patch: string): string {
  // JJ -w still emits ordinary file headers when every edit was whitespace.
  // Keep hunks, binary changes, renames, and modes; do not re-diff native output.
  return patch.split(/(?=^diff --git )/m).filter((file) => file.split("\n").some((line) => !/^(?:diff --git |index |--- |\+\+\+ |$)/.test(line))).join("");
}

/** JJ emits one JSON object per revision; descriptions can contain arbitrary newlines. */
function parseRevisions(text: string): Revision[] {
  return text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}
