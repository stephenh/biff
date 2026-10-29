import type { Storage } from "./storage";
import type { WorkingCopy, LocalReview } from "../shared/types";
import { runCommand, type RunCommand } from "./commands";
import { LocalWorkspaceProvider, type LocalGitRepository } from "./localWorkspaceProvider";
import type { WorkspaceProvider } from "./workspaceProvider";
import { acceptSnapshot, readSnapshot } from "./reviewSnapshots";

/** Own registrations centrally and route source operations through a working-copy provider. */
export class Workspaces {
  private local: LocalWorkspaceProvider;
  private provider: WorkspaceProvider;

  constructor(private storage: Storage, run: RunCommand = runCommand, provider?: WorkspaceProvider) {
    this.local = new LocalWorkspaceProvider(run);
    this.provider = provider ?? this.local;
  }

  /** Read the registry without contacting its source provider. */
  async list(): Promise<WorkingCopy[]> {
    return this.storage.db.query<WorkingCopy, []>("SELECT id,name,path FROM workspaces ORDER BY name").all();
  }

  /** Local registration resolves paths before committing; it never holds a database lock over JJ. */
  async add(path: string, name?: string): Promise<WorkingCopy> {
    const entry = await this.local.add(path, name);
    this.storage.db.query(`INSERT INTO workspaces (id,name,path) VALUES (?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,path=excluded.path`).run(entry.id, entry.name, entry.path);
    return entry;
  }

  /** Removing a registration does not delete accepted reviews or touch the source directory. */
  async remove(id: string): Promise<void> {
    this.storage.db.query("DELETE FROM workspaces WHERE id=?").run(id);
  }

  /** Discovery is a local operation, limited to immediate children of the selected directory. */
  async discover(path: string): Promise<WorkingCopy[]> {
    const entries = await this.local.discover(path);
    this.storage.db.transaction(() => {
      for (const entry of entries) this.storage.db.query(`INSERT INTO workspaces (id,name,path) VALUES (?,?,?)
        ON CONFLICT(id) DO UPDATE SET name=excluded.name,path=excluded.path`).run(entry.id, entry.name, entry.path);
    })();
    return entries;
  }

  /** Resolve selectors at the provider; the server owns acceptance of the returned snapshot. */
  async review(id: string, revision: string): Promise<LocalReview> {
    return this.accept(id, await this.provider.review(this.workspace(id), revision));
  }

  /** Preserve bookmark and base selection semantics across the provider boundary. */
  async bookmarkReview(id: string, bookmark?: string, changes = "all", baseOverride?: string, followWorkingCopy = bookmark === undefined): Promise<LocalReview> {
    return this.accept(id, await this.provider.bookmarkReview(this.workspace(id), bookmark, changes, baseOverride, followWorkingCopy));
  }

  /** Immutable coordinates, including merged parents, are resolved by the source provider. */
  async contents(id: string, commit: string, path: string, base?: string) {
    return this.provider.contents(this.workspace(id), commit, path, base);
  }

  /** Accepted captures remain readable after a provider disconnects or a registration is removed. */
  snapshot(workspace: string, id: string): LocalReview {
    const snapshot = readSnapshot(this.storage.db, id);
    if (snapshot.workspace.id !== workspace) throw new Error("Snapshot belongs to another workspace.");
    return snapshot;
  }

  /** Group shared JJ workspaces so background linking reads each Git object database only once. */
  async localRepositories(ids: string[]): Promise<LocalGitRepository[]> {
    const repositories = new Map<string, LocalGitRepository>();
    for (const id of ids) {
      try {
        const repository = await this.local.repository(this.workspace(id));
        const existing = repositories.get(repository.gitDirectory);
        if (existing) existing.workspaces.push(id);
        else repositories.set(repository.gitDirectory, repository);
      } catch { /* Removed directories and non-local providers supply no optional linking evidence. */ }
    }
    return [...repositories.values()];
  }

  /** Optional linking evidence comes only from local object storage, never a network fetch. */
  async localChangeId(repository: LocalGitRepository, head: string): Promise<string | undefined> {
    return this.local.changeId(repository, head);
  }

  /** A request selects a registered identity, never an arbitrary provider path. */
  private workspace(id: string): WorkingCopy {
    const workspace = this.storage.db.query<WorkingCopy, [string]>("SELECT id,name,path FROM workspaces WHERE id=?").get(id);
    if (!workspace) throw new Error("Working copy not found. Add it from the dashboard.");
    return workspace;
  }

  /** A provider result cannot select another workspace's review namespace. */
  private accept(workspace: string, snapshot: LocalReview): LocalReview {
    if (snapshot.workspace.id !== workspace) throw new Error("Snapshot belongs to another workspace.");
    return acceptSnapshot(this.storage.db, snapshot);
  }
}
