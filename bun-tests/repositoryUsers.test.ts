import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { RepositoryUsers } from "../server/repositoryUsers";
import { Storage } from "../server/storage";
import { Database } from "bun:sqlite";

describe("RepositoryUsers", () => {
  let directory: string;
  let storage: Storage;
  beforeEach(async () => { directory = await mkdtemp("/tmp/opencode/biff-users-"); storage = new Storage(`${directory}/biff.sqlite`); });
  afterEach(async () => { await storage.close(); await rm(directory, { recursive: true, force: true }); });

  test("searches all pages locally across queries and server restarts", async () => {
    // Given a persisted repository list spanning two pages
    const cache = new RepositoryUsers(async () => JSON.stringify([
      { data: { repository: { mentionableUsers: { nodes: [{ login: "alice", name: "Alice" }] } } } },
      { data: { repository: { mentionableUsers: { nodes: [{ login: "bob", name: "Robert" }] } } } },
    ]), storage);
    await cache.search("example/repo", "alice");

    // When a new server searches by a name without access to GitHub
    await storage.close();
    storage = new Storage(`${directory}/biff.sqlite`);
    const restarted = new RepositoryUsers(async () => { throw new Error("offline"); }, storage);
    const users = await restarted.search("Example/Repo", "ROB");

    // Then users from later pages remain searchable
    expect(users).toEqual([{ login: "bob", name: "Robert" }]);
  });

  test("serves stale users while refreshing the list in the background", async () => {
    // Given a cached list older than one week
    let now = 0;
    const cache = new RepositoryUsers(async () => response("alice"), storage, () => now);
    await cache.search("example/repo", "");
    now = 8 * 24 * 60 * 60 * 1000;

    // And a refresh that cannot complete yet
    const refresh = Promise.withResolvers<string>();
    const restarted = new RepositoryUsers(() => refresh.promise, storage, () => now);

    // When the reader searches during the refresh
    const users = await restarted.search("example/repo", "");

    // Then the old list is available without waiting for GitHub
    expect(users).toEqual([{ login: "alice", name: null }]);
  });

  test("shares a cold fetch across simultaneous searches", async () => {
    // Given a repository that has not been cached
    let calls = 0;
    const cache = new RepositoryUsers(async () => {
      if (++calls > 1) throw new Error("Duplicate fetch");
      return response("alice");
    }, storage);

    // When two searches arrive together
    const users = await Promise.all([cache.search("example/repo", "ali"), cache.search("example/repo", "ice")]);

    // Then both receive the shared complete list
    expect(users).toEqual([[{ login: "alice", name: null }], [{ login: "alice", name: null }]]);
  });
  test("sorts cold and cached suggestions by login before limiting results", async () => {
    // Given more than twenty users returned in reverse alphabetical order
    const users = Array.from({ length: 22 }, (_, index) => ({ login: `user${String(21 - index).padStart(2, "0")}`, name: null }));
    const cache = new RepositoryUsers(async () => JSON.stringify([{ data: { repository: { mentionableUsers: { nodes: users } } } }]), storage);

    // When the first search populates the relational cache
    const results = await cache.search("example/repo", "");

    // Then suggestions are alphabetical and limited after sorting
    expect(results).toEqual([...users].reverse().slice(0, 20));
  });

  test("a fetched empty list survives a restart without another GitHub call", async () => {
    // Given a successfully fetched empty user list
    const cache = new RepositoryUsers(async () => JSON.stringify([{ data: { repository: { mentionableUsers: { nodes: [] } } } }]), storage);
    await cache.search("example/repo", "");

    // When a restarted service searches while GitHub is unavailable
    await storage.close();
    storage = new Storage(`${directory}/biff.sqlite`);
    const restarted = new RepositoryUsers(async () => { throw new Error("Unexpected fetch"); }, storage);

    // Then the empty result is a valid cached snapshot
    expect(await restarted.search("example/repo", "")).toEqual([]);
  });

  test("a repository discovered through PRs still fetches its first user list", async () => {
    // Given a repository with no user-fetch timestamp
    storage.db.query("INSERT INTO repositories (id) VALUES (?)").run("example/repo");
    const cache = new RepositoryUsers(async () => response("alice"), storage);

    // When mention suggestions are requested for the first time
    const users = await cache.search("example/repo", "");

    // Then the repository row does not masquerade as a fetched empty list
    expect(users).toEqual([{ login: "alice", name: null }]);
  });

  test("a failed user write rolls back the fetch timestamp and partial list", async () => {
    // Given a database that rejects the second user in a fetched page
    storage.db.exec("CREATE TRIGGER reject_user BEFORE INSERT ON repository_users WHEN NEW.login='bob' BEGIN SELECT RAISE(ABORT, 'write rejected'); END");
    const cache = new RepositoryUsers(async () => JSON.stringify([{ data: { repository: { mentionableUsers: { nodes: [{ login: "alice", name: null }, { login: "bob", name: null }] } } } }]), storage);

    // When persistence fails and the service is recreated for a retry
    await cache.search("example/repo", "").catch(() => {});
    const restarted = new RepositoryUsers(async () => response("charlie"), storage);

    // Then the failed snapshot is fetched again rather than served as a partial success
    expect(await restarted.search("example/repo", "")).toEqual([{ login: "charlie", name: null }]);
  });

  test("legacy user arrays migrate to alphabetical rows with their fetch timestamps", async () => {
    // Given a pre-migration database with a cached list and an empty snapshot
    const file = `${directory}/legacy.sqlite`;
    const legacy = new Database(file);
    legacy.exec("CREATE TABLE repository_users (repo TEXT PRIMARY KEY, updated_at INTEGER NOT NULL, users TEXT NOT NULL)");
    legacy.query("INSERT INTO repository_users VALUES (?, ?, ?)").run("example/repo", 123, JSON.stringify([{ login: "zoe", name: null }, { login: "Alice", name: "Alice" }]));
    legacy.query("INSERT INTO repository_users VALUES (?, ?, ?)").run("example/empty", 456, "[]");
    legacy.close();

    // When startup migrates the old database and another startup reopens it
    await storage.close();
    storage = new Storage(file);
    await storage.close();
    storage = new Storage(file);

    // Then both cache timestamps survive, including the empty snapshot
    expect(storage.db.query("SELECT * FROM repositories ORDER BY id").all()).toEqual([
      { id: "example/empty", users_fetched_at: 456 },
      { id: "example/repo", users_fetched_at: 123 },
    ]);
    // And migrated users are searchable alphabetically without fetching
    const cache = new RepositoryUsers(async () => { throw new Error("Unexpected fetch"); }, storage, () => 500);
    expect(await cache.search("EXAMPLE/REPO", "")).toEqual([{ login: "Alice", name: "Alice" }, { login: "zoe", name: null }]);
  });
});

/** Encode a complete GitHub page for a repository user. */
function response(login: string) {
  return JSON.stringify([{ data: { repository: { mentionableUsers: { nodes: [{ login, name: null }] } } } }]);
}
