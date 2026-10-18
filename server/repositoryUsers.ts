import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { MentionUser } from "../shared/types";
import type { RunCommand } from "./commands";

interface Snapshot { updatedAt: number; users: MentionUser[] }
const week = 7 * 24 * 60 * 60 * 1000;

/** Persist complete repository mention lists and serve stale users during weekly refreshes. */
export class RepositoryUsers {
  private snapshots = new Map<string, Promise<Snapshot | undefined>>();
  private pending = new Map<string, Promise<Snapshot>>();
  private retryAfter = new Map<string, number>();

  constructor(private run: RunCommand, private directory?: string, private now: () => number = Date.now) {}

  /** Share one cold load across PRs and searches; warm reads never wait for GitHub. */
  async search(repo: string, query: string): Promise<MentionUser[]> {
    repo = repo.toLowerCase();
    let loaded = this.snapshots.get(repo);
    if (!loaded) {
      loaded = this.read(repo);
      this.snapshots.set(repo, loaded);
    }
    let snapshot = await loaded;
    if (!snapshot) snapshot = await this.refresh(repo);
    else if (this.now() - snapshot.updatedAt >= week && this.now() >= (this.retryAfter.get(repo) ?? 0)) {
      void this.refresh(repo).catch((error) => console.warn(`Could not refresh mention users for ${repo}:`, error));
    }
    const needle = query.trim().toLowerCase();
    return snapshot.users.filter((user) => `${user.login} ${user.name ?? ""}`.toLowerCase().includes(needle)).slice(0, 20);
  }

  /** A missing or damaged disposable cache can always be rebuilt from GitHub. */
  private async read(repo: string): Promise<Snapshot | undefined> {
    if (!this.directory) return;
    try {
      const value = JSON.parse(await readFile(this.file(repo), "utf8")) as Snapshot;
      if (Number.isFinite(value.updatedAt) && Array.isArray(value.users) && value.users.every((user) => typeof user.login === "string" && (user.name == null || typeof user.name === "string"))) return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn(`Could not read mention cache for ${repo}:`, error);
    }
  }

  /** Deduplicate refreshes and back off failures while keeping the last complete snapshot. */
  private refresh(repo: string): Promise<Snapshot> {
    const existing = this.pending.get(repo);
    if (existing) return existing;
    const promise = this.fetch(repo).catch((error) => {
      this.retryAfter.set(repo, this.now() + 60 * 60 * 1000);
      throw error;
    }).finally(() => this.pending.delete(repo));
    this.pending.set(repo, promise);
    return promise;
  }

  /** Publish only a complete paginated list so searches never see a partial refresh. */
  private async fetch(repo: string): Promise<Snapshot> {
    const [owner, name] = repo.split("/");
    const query = `query($owner: String!, $name: String!, $endCursor: String) {
      repository(owner: $owner, name: $name) {
        mentionableUsers(first: 100, after: $endCursor) {
          nodes { login name }
          pageInfo { hasNextPage endCursor }
        }
      }
    }`;
    const pages: { data: { repository: { mentionableUsers: { nodes: MentionUser[] } } | null } }[] = JSON.parse(await this.run([
      "gh", "api", "graphql", "--paginate", "--slurp", "-f", `query=${query}`, "-f", `owner=${owner}`, "-f", `name=${name}`,
    ]));
    if (!pages.length || pages.some((page) => !page.data.repository)) throw new Error("Repository is unavailable");
    const snapshot = { updatedAt: this.now(), users: pages.flatMap((page) => page.data.repository!.mentionableUsers.nodes) };
    if (this.directory) {
      await mkdir(this.directory, { recursive: true });
      const file = this.file(repo);
      await writeFile(`${file}.tmp`, JSON.stringify(snapshot), { mode: 0o600 });
      await rename(`${file}.tmp`, file);
    }
    this.snapshots.set(repo, Promise.resolve(snapshot));
    this.retryAfter.delete(repo);
    return snapshot;
  }

  /** Encode the repository as one filename, independent of its owner/name separator. */
  private file(repo: string) { return join(this.directory!, `${encodeURIComponent(repo)}.json`); }
}
