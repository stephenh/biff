import { Storage } from "./storage";
import type { MentionUser } from "../shared/types";
import type { RunCommand } from "./commands";

interface Snapshot { updatedAt: number; users: MentionUser[] }
const week = 7 * 24 * 60 * 60 * 1000;

/** Persist complete repository mention lists and serve stale users during weekly refreshes. */
export class RepositoryUsers {
  private pending = new Map<string, Promise<Snapshot>>();
  private retryAfter = new Map<string, number>();

  constructor(private run: RunCommand, private storage: Storage = new Storage(), private now: () => number = Date.now) {}

  /** Share one cold load across PRs and searches; warm reads never wait for GitHub. */
  async search(repo: string, query: string): Promise<MentionUser[]> {
    repo = repo.toLowerCase();
    let snapshot = this.read(repo);
    if (!snapshot) snapshot = await this.refresh(repo);
    else if (this.now() - snapshot.updatedAt >= week && this.now() >= (this.retryAfter.get(repo) ?? 0)) {
      void this.refresh(repo).catch((error) => console.warn(`Could not refresh mention users for ${repo}:`, error));
    }
    const needle = query.trim().toLowerCase();
    return snapshot.users.filter((user) => `${user.login} ${user.name ?? ""}`.toLowerCase().includes(needle)).slice(0, 20);
  }

  /** SQLite snapshots are shared by every repository lookup, even across service instances. */
  private read(repo: string): Snapshot | undefined {
    const row = this.storage.db.query<{ updated_at: number; users: string }, [string]>("SELECT updated_at, users FROM repository_users WHERE repo=?").get(repo);
    return row ? { updatedAt: row.updated_at, users: JSON.parse(row.users) } : undefined;
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
    this.storage.db.query("INSERT INTO repository_users VALUES (?, ?, ?) ON CONFLICT(repo) DO UPDATE SET updated_at=excluded.updated_at, users=excluded.users").run(repo, snapshot.updatedAt, JSON.stringify(snapshot.users));
    this.retryAfter.delete(repo);
    return snapshot;
  }
}
