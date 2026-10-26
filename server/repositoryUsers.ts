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
    const row = this.storage.db.query<{ users_fetched_at: number | null }, [string]>("SELECT users_fetched_at FROM repositories WHERE id=?").get(repo);
    if (row?.users_fetched_at == null) return undefined;
    const users = this.storage.db.query<MentionUser, [string]>("SELECT login, name FROM repository_users WHERE repository_id=? ORDER BY login").all(repo);
    return { updatedAt: row.users_fetched_at, users };
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
    const users = pages.flatMap((page) => page.data.repository!.mentionableUsers.nodes);
    this.storage.db.transaction(() => {
      this.storage.db.query(`INSERT INTO repositories (id, users_fetched_at) VALUES (?, ?)
        ON CONFLICT(id) DO UPDATE SET users_fetched_at=excluded.users_fetched_at`).run(repo, this.now());
      // Upsert retained users so their synthetic IDs survive a refresh.
      const save = this.storage.db.query(`INSERT INTO repository_users (repository_id, login, name) VALUES (?, ?, ?)
        ON CONFLICT(repository_id, login) DO UPDATE SET login=excluded.login, name=excluded.name`);
      for (const user of users) save.run(repo, user.login, user.name);
      const logins = new Set(users.map((user) => user.login.toLowerCase()));
      for (const user of this.read(repo)!.users) {
        if (!logins.has(user.login.toLowerCase())) this.storage.db.query("DELETE FROM repository_users WHERE repository_id=? AND login=?").run(repo, user.login);
      }
    })();
    this.retryAfter.delete(repo);
    return this.read(repo)!;
  }
}
