import type { Storage } from "./storage";
import type { Workspaces } from "./workspaces";
import { recordPrChangeIds, type PrHeadChange } from "./reviewStore";

const retryInterval = 120_000;

/** Enrich recorded PR heads from local Git objects without delaying reviews or creating a Git cache. */
export class LocalPrLinks {
  private pending = new Map<string, string>();
  private attempted = new Map<string, { head: string; at: number }>();
  private running?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;

  constructor(private storage: Storage, private workspaces: Pick<Workspaces, "localRepositories" | "localChangeId">) {}

  /** Retry missing local objects and recover previously opened PRs after a server upgrade. */
  start(): void {
    this.timer ??= setInterval(() => this.wake(), retryInterval);
    this.timer.unref();
    this.wake();
  }

  /** Drain local lookups before the owner closes the shared database. */
  async stop(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
  }

  /** Queue each observed head once per retry interval; a newer head supersedes pending old work. */
  schedule(scope: string, head: string): void {
    // Only GitHub PR scopes (owner/repo/number) and full commit hashes may reach local Git commands.
    if (!/^[\w.-]+\/[\w.-]+\/[1-9]\d*$/.test(scope) || !/^[a-f0-9]{40,64}$/.test(head)) return;
    const previous = this.attempted.get(scope);
    if (previous?.head === head && Date.now() - previous.at < retryInterval) return;
    this.attempted.set(scope, { head, at: Date.now() });
    this.pending.set(scope, head);
    this.running ??= Promise.resolve().then(() => this.process()).finally(() => { this.running = undefined; });
  }

  /** Only PR heads and bookmark tips can link; shared ancestors are deliberately excluded. */
  wake(): void {
    if (!this.storage.db.query("SELECT id FROM reviews WHERE local_workspace IS NOT NULL AND pr IS NULL AND closed=0 LIMIT 1").get()) return;
    const heads = this.storage.db.query<{ pr: string; head: string }, []>(`SELECT r.pr,c.commit_sha AS head
      FROM reviews r JOIN review_commits c ON c.review_id=r.id
      WHERE r.pr IS NOT NULL AND r.local_workspace IS NULL AND r.closed=0
        AND c.pr_head_position=(SELECT max(pr_head_position) FROM review_commits WHERE review_id=r.id)`).all();
    for (const row of heads) this.schedule(row.pr, row.head);
  }

  /**
   * One worker bounds subprocesses and gathers all candidates before the atomic ambiguity check.
   *
   * Headers belong to immutable commits; missing objects remain retryable after normal user fetches.
   */
  private async process(): Promise<void> {
    while (this.pending.size) {
      const observations: PrHeadChange[] = [];
      const candidates = this.storage.db.query<{ workspace: string }, []>(`SELECT DISTINCT local_workspace AS workspace FROM reviews
        WHERE local_workspace IS NOT NULL AND pr IS NULL AND closed=0`).all();
      const repositories = await this.workspaces.localRepositories(candidates.map((row) => row.workspace));
      while (this.pending.size) {
        const [scope, head] = this.pending.entries().next().value!;
        this.pending.delete(scope);
        const repository = scope.slice(0, scope.lastIndexOf("/"));
        const matches = new Map<string, string[]>();
        for (const candidate of repositories.filter((entry) => entry.repositories.includes(repository))) {
          try {
            const change = await this.workspaces.localChangeId(candidate, head);
            if (!change) continue;
            matches.set(change, [...matches.get(change) ?? [], ...candidate.workspaces]);
          } catch { /* Missing objects, removed workspaces, and unavailable providers leave SHA linking intact. */ }
        }
        // One immutable commit must not acquire conflicting metadata from different providers.
        if (matches.size !== 1) continue;
        const [changeId, workspaces] = matches.entries().next().value!;
        observations.push({ scope, head, changeId, workspaces });
      }
      if (!observations.length) continue;
      try { await recordPrChangeIds(this.storage, observations); }
      catch (cause) { console.warn("Could not link local PR progress:", cause); }
    }
  }
}
