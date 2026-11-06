import { chromium, expect, test, type Browser, type Page } from "@playwright/test";

test.describe("Resource snapshots", () => {
  let browser: Browser;
  let page: Page;

  test.beforeAll(async () => { browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium" }); });
  test.afterAll(async () => { await browser.close(); });
  test.beforeEach(async () => {
    const context = await browser.newContext({ baseURL: "http://127.0.0.1:5173" });
    page = await context.newPage();
    await page.route("**/resource-fixture?*", (route) => route.fulfill({ contentType: "text/html", body: '<div id="root"></div><script type="module" src="/tests/resource-fixture.tsx"></script>' }));
    await page.route("**/api/resource-fixture/*", (route) => route.fulfill({ json: route.request().method() === "POST" ? { version: 3, label: "Acknowledged mutation" } : { version: 1, label: new URL(route.request().url()).pathname.endsWith("/first") ? "First resource" : "Second resource" } }));
  });
  test.afterEach(async () => { await page.context().close(); });

  test("a held refresh retains the last good snapshot", async () => {
    // Given a loaded resource
    await openFixture(page);
    // And a refresh held in flight
    const held = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    await page.route("**/api/resource-fixture/first", async (route) => { started.resolve(); await held.promise; await route.fallback(); });
    try {
      // When a same-resource refresh starts
      await page.getByRole("button", { name: "Refresh", exact: true }).click();
      await started.promise;
      // Then existing data stays visible
      await expect(page.getByLabel("Resource data")).toHaveText("First resource");
    } finally { held.resolve(); }
  });

  test("an unversioned read started before a mutation cannot undo its acknowledgement", async () => {
    // Given a read held before a mutation
    await openFixture(page);
    const held = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    await page.route("**/api/resource-fixture/first", async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      started.resolve(); await held.promise; await route.fulfill({ json: { label: "Obsolete read" } });
    });
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await started.promise;
    // And a completed mutation installs its receipt
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByLabel("Resource data").filter({ hasText: "Acknowledged mutation" }).waitFor();
    // When the earlier read finally completes
    const response = page.waitForResponse((response) => response.request().method() === "GET" && response.url().endsWith("/first"));
    held.resolve(); await response;
    await page.getByLabel("Resource loading").filter({ hasText: "false" }).waitFor();
    // Then the acknowledged value remains
    await expect(page.getByLabel("Resource data")).toHaveText("Acknowledged mutation");
  });

  test("a stale versioned read cannot undo a mutation even when requested afterward", async () => {
    // Given an acknowledged version newer than the cached GET response
    await openFixture(page, true);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByLabel("Resource data").filter({ hasText: "Acknowledged mutation" }).waitFor();
    // When a later refresh reads the older server cache
    const response = page.waitForResponse((response) => response.request().method() === "GET" && response.url().endsWith("/first"));
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await response;
    await page.getByLabel("Resource loading").filter({ hasText: "false" }).waitFor();
    // Then revision order wins over request order
    await expect(page.getByLabel("Resource data")).toHaveText("Acknowledged mutation");
  });

  test("a stream snapshot uses the same revision rules as reads and mutation receipts", async () => {
    // Given a versioned resource
    await openFixture(page, true);
    await page.getByRole("button", { name: "Stream update", exact: true }).click();
    await page.getByLabel("Resource data").filter({ hasText: "Stream snapshot" }).waitFor();
    // When an older mutation receipt arrives afterward
    const response = page.waitForResponse((response) => response.request().method() === "POST");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await response;
    await page.getByLabel("Mutation pending").filter({ hasText: "false" }).waitFor();
    // Then the newer stream version is retained
    await expect(page.getByLabel("Resource data")).toHaveText("Stream snapshot");
  });

  test("a late receipt for another resource cannot replace the active resource", async () => {
    // Given a held mutation on the first resource
    await openFixture(page);
    const held = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    await page.route("**/api/resource-fixture/first", async (route) => { started.resolve(); await held.promise; await route.fallback(); });
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await started.promise;
    // And the user has moved to another resource
    await page.getByRole("button", { name: "Switch resource", exact: true }).click();
    await page.getByLabel("Resource data").filter({ hasText: "Second resource" }).waitFor();
    // When the original receipt arrives
    const response = page.waitForResponse((response) => response.request().method() === "POST");
    held.resolve(); await response;
    await page.getByLabel("Mutation pending").filter({ hasText: "false" }).waitFor();
    // Then it cannot populate the new resource's snapshot
    await expect(page.getByLabel("Resource data")).toHaveText("Second resource");
  });

  test("a refresh failure does not roll back an acknowledged mutation", async () => {
    // Given an acknowledged mutation
    await openFixture(page);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByLabel("Resource data").filter({ hasText: "Acknowledged mutation" }).waitFor();
    // And subsequent reads fail
    await page.route("**/api/resource-fixture/first", (route) => route.fulfill({ status: 503, json: { error: "Read unavailable" } }));
    // When the user refreshes
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await page.getByLabel("Resource error").filter({ hasText: "Read unavailable" }).waitFor();
    // Then the last acknowledged data is preserved
    await expect(page.getByLabel("Resource data")).toHaveText("Acknowledged mutation");
  });

  test("a local invalidation refreshes mounted readers without a second same-tab broadcast fetch", async () => {
    // Given a mounted reader with requests counted
    let reads = 0;
    await page.route("**/api/resource-fixture/first", (route) => { reads++; return route.fulfill({ json: { label: reads === 1 ? "First resource" : "Refreshed resource" } }); });
    await openFixture(page);
    // When this tab publishes an invalidation
    await page.getByRole("button", { name: "Invalidate resource", exact: true }).click();
    await page.getByLabel("Resource data").filter({ hasText: "Refreshed resource" }).waitFor();
    // Then the local event and its broadcast cause only one new read
    expect(reads).toEqual(2);
  });

  test("an invalidation from another tab refreshes the same resource", async () => {
    // Given two tabs reading the same resource
    await openFixture(page);
    const other = await page.context().newPage();
    await other.route("**/resource-fixture?*", (route) => route.fulfill({ contentType: "text/html", body: '<div id="root"></div><script type="module" src="/tests/resource-fixture.tsx"></script>' }));
    await other.route("**/api/resource-fixture/*", (route) => route.fulfill({ json: { label: "First resource" } }));
    try {
      await openFixture(other);
      // And this tab's next snapshot has changed
      await page.route("**/api/resource-fixture/first", (route) => route.fulfill({ json: { label: "Cross-tab snapshot" } }));
      // When the other tab publishes its resource change
      await other.getByRole("button", { name: "Invalidate resource", exact: true }).click();
      // Then this tab follows the same refresh path
      await expect(page.getByLabel("Resource data")).toHaveText("Cross-tab snapshot");
    } finally { await other.close(); }
  });

  test("a newer revision can win even when its read started before a stream update", async () => {
    // Given a versioned read held before a stream update
    await openFixture(page, true);
    const held = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    await page.route("**/api/resource-fixture/first", async (route) => {
      started.resolve(); await held.promise; await route.fulfill({ json: { version: 5, label: "Newest snapshot" } });
    });
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await started.promise;
    // And the stream has installed version 4 in the meantime
    await page.getByRole("button", { name: "Stream update", exact: true }).click();
    await page.getByLabel("Resource data").filter({ hasText: "Stream snapshot" }).waitFor();
    // When the read returns a proven newer version
    held.resolve();
    await page.getByLabel("Resource loading").filter({ hasText: "false" }).waitFor();
    // Then explicit revision evidence takes precedence over request start order
    await expect(page.getByLabel("Resource data")).toHaveText("Newest snapshot");
  });
});

/** Mount the real hook through Vite, independent of production feature wrappers. */
async function openFixture(page: Page, versioned = false) {
  await page.goto(`/resource-fixture?${versioned ? "versioned=1" : "plain=1"}`);
  await page.getByLabel("Resource data").filter({ hasText: "First resource" }).waitFor();
}
