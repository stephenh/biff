import { realpath, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { runCommand, type RunCommand } from "./commands";

/** Prefer JJ in colocated repositories, but respect nested Git repositories and linked worktrees. */
export async function workspaceRoot(path: string, run: RunCommand = runCommand): Promise<string> {
  let directory = await realpath(path);
  while (true) {
    if (await isJjWorkspace(directory)) return realpath((await run(["jj", "root", "--no-pager"], { cwd: directory })).trim());
    if (await stat(join(directory, ".git")).catch(() => undefined)) break;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return realpath((await run(["git", "rev-parse", "--show-toplevel"], { cwd: path })).trim());
}

/** A JJ workspace can have either a colocated or an external Git object store. */
export async function isJjWorkspace(path: string): Promise<boolean> {
  return Boolean((await stat(join(path, ".jj")).catch(() => undefined))?.isDirectory());
}
