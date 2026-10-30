import { chromium, expect, test, type Browser, type Page } from "@playwright/test";
import { inboxQueue } from "./inbox-fixture";

test.describe("Activity", () => {
  let browser: Browser;
  let page: Page;
  test.beforeAll(async () => { browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium" }); });
  test.afterAll(async () => { await browser.close(); });
  test.beforeEach(async () => { page = await browser.newPage({ baseURL: "http://127.0.0.1:5173" }); });
  test.afterEach(async () => { await page.close(); });

  test("successful reads return to idle without claiming a save", async () => {
    // Given a held initial working-copy lookup
    const held = Promise.withResolvers<void>();
    await page.route("**/api/workspaces", async (route) => { await held.promise; await route.fulfill({ json: [] }); });
    await page.goto("/workspaces");
    const indicator = page.locator(".shell-nav > .activity-slot");
    await expect(indicator).toHaveAttribute("data-activity-state", "loading");

    // When the read completes
    held.resolve();

    // Then completion is idle, not a saved-write receipt
    await expect(indicator).toHaveAttribute("data-activity-state", "idle");
  });

  test("a refresh leaves its loaded content available", async () => {
    // Given working copies already loaded and a held refresh
    const held = Promise.withResolvers<void>();
    let hold = false;
    await page.route("**/api/workspaces", async (route) => {
      if (hold) await held.promise;
      await route.fulfill({ json: [{ id: "fixture", name: "Fixture", path: "/fixture" }] });
    });
    await page.goto("/workspaces");
    await page.getByRole("link", { name: "Fixture", exact: true }).waitFor();
    hold = true;

    try {
      // When the reader refreshes the list
      await page.getByRole("button", { name: "Refresh", exact: true }).click();
      await page.getByRole("button", { name: "Activity: Loading (1)", exact: true }).waitFor();

      // Then the previous snapshot remains usable
      await expect(page.getByRole("link", { name: "Fixture", exact: true })).toBeVisible();
    } finally { held.resolve(); }
  });

  test("a foreground failure after navigation retains a working retry", async () => {
    // Given a held registration request
    const held = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    let fail = true;
    const saved: string[] = [];
    await page.route("**/api/inbox?*", (route) => route.fulfill({ json: inboxQueue([]) }));
    await page.route("**/api/workspaces", async (route) => {
      if (route.request().method() === "POST") {
        started.resolve();
        await held.promise;
        if (fail) return route.fulfill({ status: 503, json: { error: "Registration unavailable" } });
        saved.push(route.request().postDataJSON().path);
      }
      await route.fulfill({ json: [] });
    });
    await page.goto("/workspaces");
    await page.getByRole("textbox", { name: "Working copy path", exact: true }).fill("/fixture");
    await page.getByRole("button", { name: "Add working copy", exact: true }).click();
    await started.promise;
    // And the request fails after the owner unmounts
    await page.getByRole("link", { name: "My PRs", exact: true }).click();
    held.resolve();
    await page.getByRole("button", { name: "Activity: 1 operation needs attention", exact: true }).click();
    await page.getByText("Registration unavailable", { exact: true }).waitFor();
    fail = false;

    // When the reader retries from the shell
    await page.getByRole("button", { name: "Retry", exact: true }).click();

    // Then the original path is persisted despite its form having unmounted
    await expect.poll(() => saved).toEqual(["/fixture"]);
  });

  test("routine inbox polls do not animate the activity slot", async () => {
    // Given an inbox whose initial snapshot has loaded
    let polls = 0;
    await page.route("**/api/inbox?*", (route) => { polls++; return route.fulfill({ json: inboxQueue([]) }); });
    await page.goto("/prs");
    const indicator = page.locator(".shell-nav > .activity-slot");
    await expect(indicator).toHaveAttribute("data-activity-state", "idle");

    // When another routine snapshot is fetched
    await expect.poll(() => polls).toBeGreaterThan(1);

    // Then background polling stays quiet
    await expect(indicator).toHaveAttribute("data-activity-state", "idle");
  });
});
