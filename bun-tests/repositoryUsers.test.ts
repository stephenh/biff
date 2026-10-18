import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { RepositoryUsers } from "../server/repositoryUsers";
import { Storage } from "../server/storage";

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
});

/** Encode a complete GitHub page for a repository user. */
function response(login: string) {
  return JSON.stringify([{ data: { repository: { mentionableUsers: { nodes: [{ login, name: null }] } } } }]);
}
