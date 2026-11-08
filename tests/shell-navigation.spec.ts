import { readFile } from "node:fs/promises";
import { chromium, expect, test, type Browser, type Page } from "@playwright/test";
import { inboxQueue } from "./inbox-fixture";

test.describe("Shell navigation", () => {
  let browser: Browser;
  let page: Page;

  test.beforeAll(async () => { browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium" }); });
  test.afterAll(async () => { await browser.close(); });
  test.afterEach(async () => { await page.close(); });
  test.beforeEach(async () => {
    page = await browser.newPage({ baseURL: "http://127.0.0.1:5173", viewport: { width: 1440, height: 900 } });
    const patch = await readFile(new URL("../fixtures/demo.diff", import.meta.url), "utf8");
    const revision = { commit_id: "a".repeat(40), change_id: "qwerty", description: "Navigation fixture" };
    await page.route("**/api/**", (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/inbox") return route.fulfill({ json: inboxQueue([]) });
      if (path === "/api/workspaces/fixture/review") return route.fulfill({ json: {
        workspace: { id: "fixture", name: "fixture", path: "/fixture" }, selected: revision, revisions: [revision], patch,
      } });
      if (path === "/api/github/pr/example/repo/22/review") return route.fulfill({ json: {
        pr: { number: 22, title: "A pull request with a reasonably long title", body: "", state: "open", user: { login: "author" }, head: { sha: revision.commit_id, ref: "feature" }, base: { sha: "b".repeat(40), ref: "main" } },
        commit: "all", commits: [], patch,
      } });
      if (path.endsWith("/review-draft")) return route.fulfill({ json: { commitId: revision.commit_id, body: "", comments: [], version: 0 } });
      if (path.endsWith("/conversation")) return route.fulfill({ json: { viewer: "me", comments: [], reviews: [], inline: [] } });
      if (path.endsWith("/discussion")) return route.fulfill({ json: { identity: { id: "fixture" }, threads: [], version: 0 } });
      if (path.endsWith("/viewed")) return route.fulfill({ json: { files: {} } });
      if (path.endsWith("/stack") || path.endsWith("/status") || path.endsWith("/local-review")) return route.fulfill({ json: null });
      return route.fulfill({ json: [] });
    });
  });

  test("working-copy reviews reclaim the global header row", async () => {
    // Given a working-copy review
    await page.goto("/workspaces/fixture");
    // When its compact navigation mounts
    await page.getByRole("button", { name: "Biff menu", exact: true }).waitFor();
    // Then the review toolbar starts at the top of the window
    await expect.poll(async () => (await page.locator(".source-toolbar").boundingBox())?.y).toBe(0);
  });

  test("pull-request reviews also use compact navigation", async () => {
    // Given a pull-request URL
    // When the review opens
    await page.goto("/pr/example/repo/22");
    await page.locator("[data-biff-focused]").waitFor();
    // Then the Biff menu is part of its toolbar
    await expect(page.locator(".source-toolbar").getByRole("button", { name: "Biff menu", exact: true })).toBeVisible();
  });

  test("the menu exposes every global destination", async () => {
    // Given a working-copy review
    await page.goto("/workspaces/fixture");
    // When Biff navigation opens
    await page.getByRole("button", { name: "Biff menu", exact: true }).click();
    // Then the original destination labels remain available
    await expect(page.getByRole("navigation", { name: "Main navigation" }).getByRole("link")).toHaveText(["My PRs", "Needs Review", "Working Copies"]);
  });

  test("Escape dismisses the menu and restores focus", async () => {
    // Given an open Biff menu
    await page.goto("/workspaces/fixture");
    await page.getByRole("button", { name: "Biff menu", exact: true }).click();
    // When the reader presses Escape
    await page.keyboard.press("Escape");
    // Then the trigger receives keyboard focus
    await expect(page.getByRole("button", { name: "Biff menu", exact: true })).toBeFocused();
  });

  test("Settings replaces the menu rather than leaving stacked popovers", async () => {
    // Given an open Biff menu
    await page.goto("/workspaces/fixture");
    await page.getByRole("button", { name: "Biff menu", exact: true }).click();
    // When reading settings open
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("dialog", { name: "Settings", exact: true }).waitFor();
    // Then only the settings popover remains open
    await expect(page.locator(":popover-open")).toHaveAttribute("id", "reading-settings");
  });

  test("menu navigation restores the dashboard header", async () => {
    // Given an open Biff menu in a review
    await page.goto("/workspaces/fixture");
    await page.getByRole("button", { name: "Biff menu", exact: true }).click();
    // When the reader chooses My PRs
    await page.getByRole("link", { name: "My PRs", exact: true }).click();
    // Then the full dashboard navigation is available without another menu
    await expect(page.locator(".shell-header").getByRole("navigation", { name: "Main navigation" })).toBeVisible();
  });

  test("global review shortcuts still leave the compact view", async () => {
    // Given a review with keyboard focus in the diff
    await page.goto("/workspaces/fixture");
    await page.locator("[data-biff-focused]").waitFor();
    // When the reader uses the go-to-working-copies shortcut
    await page.keyboard.press("g");
    await page.keyboard.press("w");
    // Then the working copies dashboard opens
    await expect(page).toHaveURL("/workspaces");
  });

  test("Activity remains accessible with the Biff menu closed", async () => {
    // Given a working-copy review
    await page.goto("/workspaces/fixture");
    // When compact navigation mounts with its menu closed
    await page.getByRole("button", { name: "Biff menu", exact: true }).waitFor();
    // Then activity feedback stays in the toolbar
    await expect(page.locator(".review-navigation > .activity-slot > button")).toBeVisible();
  });

  test("dashboard and review headers have exactly the same height", async () => {
    // Given the dashboard header height
    await page.goto("/workspaces");
    const height = (await page.locator(".shell-header").boundingBox())!.height;
    // When a pull-request review opens
    await page.goto("/pr/example/repo/22");
    await page.locator("[data-biff-focused]").waitFor();
    // Then its toolbar occupies exactly the same vertical space
    expect((await page.locator(".source-toolbar").boundingBox())!.height).toBe(height);
  });

  test("the Biff wordmark stays in the same position after opening a review", async () => {
    // Given the dashboard wordmark position
    await page.goto("/workspaces");
    const brand = await page.locator(".brand").boundingBox();
    // When a working-copy review opens
    await page.goto("/workspaces/fixture");
    await page.locator("[data-biff-focused]").waitFor();
    // Then the shared wordmark keeps its top-left position
    expect(await page.locator(".brand").boundingBox()).toMatchObject({ x: brand!.x, y: brand!.y, height: brand!.height });
  });

  test("the cloud stays in exactly the same place after opening a review", async () => {
    // Given the dashboard activity position
    await page.goto("/workspaces");
    const cloud = await page.locator(".shell-nav > .activity-slot").boundingBox();
    // When a pull-request review opens
    await page.goto("/pr/example/repo/22");
    await page.locator("[data-biff-focused]").waitFor();
    // Then the cloud keeps its full bounding box
    expect(await page.locator(".review-navigation > .activity-slot").boundingBox()).toEqual(cloud);
  });

  test("review controls end with comments, navigation, help and activity", async () => {
    // Given an open pull-request review
    await page.goto("/pr/example/repo/22");
    await page.locator("[data-biff-focused]").waitFor();
    // When the toolbar controls are read in document order
    const buttons = page.locator(".source-toolbar .review-toolbar-actions > button, .review-navigation button:visible");
    // Then global controls follow Review comments rather than the Biff wordmark
    await expect.poll(() => buttons.evaluateAll((elements) => elements.map((element) => element.getAttribute("aria-label")?.split(":")[0] ?? element.textContent?.trim()))).toEqual(["PR overview", "Review comments", "Biff menu", "Keyboard shortcuts", "Activity"]);
  });
});
