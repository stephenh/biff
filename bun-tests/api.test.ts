import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createApi, type Services } from "../server/api";
import { GitHub } from "../server/github";
import { Inbox } from "../server/inbox";
import { Storage } from "../server/storage";
import { Workspaces } from "../server/workspaces";

const publicOrigin = "https://biff.draconian.app";

describe("api", () => {
  let storage: Storage;
  let services: Services;
  let inbox: Inbox;

  beforeEach(() => {
    storage = new Storage();
    const github = new GitHub(undefined, storage);
    inbox = new Inbox(storage, github);
    services = { github, inbox, workspaces: new Workspaces(storage) };
  });
  afterEach(async () => { await storage.close(); });

  test.each(["127.0.0.1", "localhost", "[::1]"])("accepts default loopback host %s", async (host) => {
    // Given no public origin is configured
    const api = createApi(services);

    // When a local client checks the daemon
    const response = await api(new Request(`http://${host}:4567/api/health`));

    // Then the CLI health protocol is available
    expect(await response.json()).toEqual({ name: "biff", version: 1 });
  });

  test("accepts local CLI writes without browser headers", async () => {
    // Given no public origin is configured
    const api = createApi(services);

    // When a local non-browser client writes a preference
    await api(preferencesRequest("http://127.0.0.1:4567"));

    // Then the preference is saved
    expect(inbox.preferences("authored")).toEqual({ sort: "recent", repository: "example/project" });
  });

  test.each(["https://biff.draconian.app", "http://rebind.example", "http://100.70.106.46:4567"])("rejects unconfigured host %s", async (origin) => {
    // Given the default localhost-only policy
    const api = createApi(services);

    // When an untrusted Host reaches the loopback listener
    const response = await api(new Request(`${origin}/api/health`));

    // Then DNS rebinding and remote names remain forbidden
    expect(response.status).toBe(403);
  });

  test("accepts same-origin localhost browser writes", async () => {
    // Given the default localhost-only policy
    const api = createApi(services);

    // When the local browser writes with its own origin
    await api(preferencesRequest("http://localhost:4567", { Origin: "http://localhost:4567", "Sec-Fetch-Site": "same-origin" }));

    // Then the preference is saved
    expect(inbox.preferences("authored").sort).toBe("recent");
  });

  test("rejects cross-origin localhost writes", async () => {
    // Given the default localhost-only policy
    const api = createApi(services);

    // When a different local port tries to write
    const response = await api(preferencesRequest("http://localhost:4567", { Origin: "http://localhost:9999" }));

    // Then localhost is not a blanket origin allowlist
    expect(response.status).toBe(403);
  });

  test("accepts the configured HTTPS origin", async () => {
    // Given an explicit public origin
    const api = createApi(services, publicOrigin);

    // When a request uses that exact origin
    const response = await api(new Request(`${publicOrigin}/api/health`, { headers: { Origin: publicOrigin } }));

    // Then the public API is available
    expect(response.status).toBe(200);
  });

  test("accepts HTTPS browser writes across Caddy's HTTP upstream hop", async () => {
    // Given the configured API behind an HTTP loopback listener
    const api = createApi(services, publicOrigin);
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: api });

    try {
      // When Caddy preserves the public Host and the browser's HTTPS Origin, without forwarded headers
      const request = preferencesRequest(server.url.origin, { Host: "biff.draconian.app", Origin: publicOrigin, "Sec-Fetch-Site": "same-origin" });
      const response = await fetch(request);
      if (!response.ok) throw new Error(await response.text());

      // Then the real HTTP request saves the preference
      expect(inbox.preferences("authored").sort).toBe("recent");
    } finally { await server.stop(true); }
  });

  test("keeps local browser access when a public origin is configured", async () => {
    // Given public access has been opted into
    const api = createApi(services, publicOrigin);

    // When a browser uses the existing localhost URL
    await api(preferencesRequest("http://127.0.0.1:4567", { Origin: "http://127.0.0.1:4567" }));

    // Then local writes still work
    expect(inbox.preferences("authored").sort).toBe("recent");
  });

  test.each(["http://evil.example", "http://biff.draconian.app.evil.example", "http://sub.biff.draconian.app", "http://biff.draconian.app:4567"])("rejects hostile or wrong-port public host %s", async (origin) => {
    // Given only one exact public authority is configured
    const api = createApi(services, publicOrigin);

    // When a different authority sends even the allowed Origin
    const response = await api(preferencesRequest(origin, { Origin: publicOrigin }));

    // Then the Origin cannot authorize a hostile Host
    expect(response.status).toBe(403);
  });

  test.each(["https://evil.example", "https://sibling.draconian.app", "http://biff.draconian.app", "https://biff.draconian.app:8443", "null", "not an origin", "https://biff.draconian.app/path"])("rejects hostile or invalid browser origin %s", async (origin) => {
    // Given the configured public Host
    const api = createApi(services, publicOrigin);

    // When a write carries anything but the exact HTTPS browser origin
    const response = await api(preferencesRequest("http://biff.draconian.app", { Origin: origin }));

    // Then the write is forbidden, including same-site sibling domains
    expect(response.status).toBe(403);
  });

  test("does not treat the public origin as same-origin with localhost", async () => {
    // Given both local and public access are allowed
    const api = createApi(services, publicOrigin);

    // When the public browser tries to write through the localhost authority
    const response = await api(preferencesRequest("http://127.0.0.1:4567", { Origin: publicOrigin }));

    // Then allowed origins are not interchangeable
    expect(response.status).toBe(403);
  });

  test("does not treat localhost as same-origin with the public host", async () => {
    // Given both local and public access are allowed
    const api = createApi(services, publicOrigin);

    // When a localhost browser targets the public authority
    const response = await api(preferencesRequest("http://biff.draconian.app", { Origin: "http://127.0.0.1:4567" }));

    // Then the browser origin must match the requested authority
    expect(response.status).toBe(403);
  });

  test("rejects cross-site writes even with an otherwise valid public origin", async () => {
    // Given the configured public API
    const api = createApi(services, publicOrigin);

    // When a cross-site request attempts a preference write
    await api(preferencesRequest("http://biff.draconian.app", { Origin: publicOrigin, "Sec-Fetch-Site": "cross-site" }));

    // Then the preference remains unchanged
    expect(inbox.preferences("authored").sort).toBe("attention");
  });

  test("rejects cross-site reads without Origin", async () => {
    // Given the default localhost-only policy
    const api = createApi(services);

    // When a foreign site attempts to read local data
    const response = await api(new Request("http://127.0.0.1:4567/api/health", { headers: { "Sec-Fetch-Site": "cross-site" } }));

    // Then missing Origin does not bypass Fetch Metadata protection
    expect(response.status).toBe(403);
  });

  test("does not trust forwarded headers to authorize a hostile Host", async () => {
    // Given an explicitly configured public origin
    const api = createApi(services, publicOrigin);

    // When an attacker claims that origin through proxy headers
    const response = await api(new Request("http://evil.example/api/health", { headers: { Forwarded: "host=biff.draconian.app;proto=https", "X-Forwarded-Host": "biff.draconian.app", "X-Forwarded-Proto": "https" } }));

    // Then only the actual request authority grants access
    expect(response.status).toBe(403);
  });

  test("ignores forwarded headers on a valid public request", async () => {
    // Given the configured public API
    const api = createApi(services, publicOrigin);

    // When proxy headers claim a different host or scheme
    const response = await api(new Request("http://biff.draconian.app/api/health", { headers: { Origin: publicOrigin, "X-Forwarded-Host": "evil.example", "X-Forwarded-Proto": "http" } }));

    // Then proxy headers cannot change the configured origin comparison
    expect(response.status).toBe(200);
  });

  test.each(["", "not a URL", "http://biff.draconian.app", "https://*.draconian.app", "https://user:password@biff.draconian.app", "https://biff.draconian.app/path", "https://biff.draconian.app?query", "https://biff.draconian.app#fragment"])("fails closed for invalid public configuration %s", (origin) => {
    // Given an invalid explicit public-origin setting
    // When the API is initialized
    // Then startup fails rather than weakening the default policy
    expect(() => createApi(services, origin)).toThrow("BIFF_PUBLIC_ORIGIN must be an HTTPS origin");
  });

  test("CLI reuses the daemon and keeps browser URLs local with a public origin configured", async () => {
    // Given a running local daemon that also permits the public origin
    const api = createApi(services, publicOrigin);
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: api });

    try {
      // When the CLI is run with the public-origin setting too
      const cli = new URL("../bin/biff.ts", import.meta.url).pathname;
      const child = Bun.spawn([process.execPath, cli, "--dashboard", "--no-open"], { env: { ...process.env, BIFF_PORT: String(server.port), BIFF_PUBLIC_ORIGIN: publicOrigin }, stdout: "pipe", stderr: "pipe" });
      const output = await new Response(child.stdout).text();
      if (await child.exited !== 0) throw new Error(await new Response(child.stderr).text());

      // Then the browser URL still uses loopback, without requiring Caddy or DNS
      expect(output.trim()).toBe(`${server.url.origin}/workspaces`);
    } finally { await server.stop(true); }
  });
});

/** Exercise a real JSON write without running jj or contacting GitHub. */
function preferencesRequest(origin: string, headers: Record<string, string> = {}): Request {
  return new Request(`${origin}/api/inbox/preferences`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ sort: "recent", repository: "example/project" }) });
}
