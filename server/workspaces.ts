import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { LocalReview, Revision, WorkingCopy } from "../shared/types";
import { runCommand, type RunCommand } from "./commands";

/** Persist stable working-copy paths; registration never checks out or rewrites a commit. */
export class Workspaces {
  private writes: Promise<unknown> = Promise.resolve();
  constructor(private file: string, private run: RunCommand = runCommand) {}

  /** Read the registry without hiding corrupt data or filesystem errors. */
  async list(): Promise<WorkingCopy[]> {
    await this.writes;
    return this.read();
  }

  /** Resolve a subdirectory to its JJ workspace root and register it once. */
  async add(path: string, name?: string): Promise<WorkingCopy> {
    const expanded = path.startsWith("~/") ? join(homedir(), path.slice(2)) : resolve(path);
    const root = await realpath((await this.run(["jj", "root", "--no-pager"], { cwd: expanded })).trim());
    const entry = { id: createHash("sha256").update(root).digest("hex").slice(0, 16), name: name?.trim() || basename(root), path: root };
    await this.update((entries) => [...entries.filter((existing) => existing.id !== entry.id), entry]);
    return entry;
  }

  /** Forget a dashboard entry without touching the working copy. */
  async remove(id: string) { await this.update((entries) => entries.filter((entry) => entry.id !== id)); }

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
  async review(id: string, revision: string): Promise<LocalReview> {
    if (!/^(@-?|[a-z0-9]{4,64})$/.test(revision)) throw new Error("Choose @, @-, or a revision from the recent list.");
    const workspace = (await this.list()).find((entry) => entry.id === id);
    if (!workspace) throw new Error("Working copy not found. Add it from the dashboard.");
    const options = { cwd: workspace.path };
    const template = 'json(self) ++ "\\n"';
    const selected = parseRevisions(await this.run(["jj", "log", "--no-graph", "--no-pager", "--color=never", "-r", revision, "-T", template], options));
    if (selected.length !== 1) throw new Error("Revision must identify exactly one commit.");
    const revisions = parseRevisions(await this.run(["jj", "log", "--ignore-working-copy", "--no-graph", "--no-pager", "--color=never", "--limit", "10", "-r", "ancestors(@, 10) ~ root()", "-T", template], options));
    const patch = await this.run(["jj", "diff", "--ignore-working-copy", "--no-pager", "--color=never", "--git", "--context", "5", "-r", selected[0].commit_id], options);
    return { workspace, revisions, selected: selected[0], patch };
  }

  /** Serialize atomic registry writes so concurrent tabs cannot lose registrations. */
  private update(change: (entries: WorkingCopy[]) => WorkingCopy[]) {
    const write = this.writes.then(async () => {
      const entries = change(await this.read()).sort((a, b) => a.name.localeCompare(b.name));
      await mkdir(dirname(this.file), { recursive: true });
      const temporary = `${this.file}.tmp`;
      await writeFile(temporary, JSON.stringify(entries, null, 2) + "\n", { mode: 0o600 });
      await rename(temporary, this.file);
    });
    this.writes = write.catch(() => {});
    return write;
  }

  /** Missing registry means first run; other errors must remain visible. */
  private async read(): Promise<WorkingCopy[]> {
    try { return JSON.parse(await readFile(this.file, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  }
}

/** JJ emits one JSON object per revision; descriptions can contain arbitrary newlines. */
function parseRevisions(text: string): Revision[] {
  return text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}
