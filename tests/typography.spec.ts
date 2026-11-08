import { chromium, expect, test, type Browser, type Page } from "@playwright/test";

test.describe("Typography", () => {
  let browser: Browser;
  let page: Page;
  test.beforeAll(async () => { browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium" }); });
  test.afterAll(async () => { await browser.close(); });
  test.afterEach(async () => { await page.close(); });
  test.beforeEach(async () => {
    page = await browser.newPage({ baseURL: "http://127.0.0.1:5173" });
    await page.route("**/api/**", (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith("/review")) return route.fulfill({ json: {
        pr: { number: 1, title: "Keep review discussion readable", body: "Review `descriptions` and comments share a comfortable reading scale.\n\n```ts\nconst review = 123;\n```", state: "OPEN", user: { login: "author" }, head: { sha: "a".repeat(40), ref: "feature" }, base: { sha: "b".repeat(40), ref: "main" } },
        commit: "all", commits: [], patch: "diff --git a/example.ts b/example.ts\n--- a/example.ts\n+++ b/example.ts\n@@ -1 +1 @@\n-old value\n+new value\n",
      } });
      if (path.endsWith("/review-draft")) return route.fulfill({ json: { commitId: "a".repeat(40), body: "", comments: [], version: 0 } });
      if (path.endsWith("/conversation")) return route.fulfill({ json: { comments: [], reviews: [], inline: [] } });
      if (path.endsWith("/discussion")) return route.fulfill({ json: { identity: { id: "fixture" }, threads: [], version: 0 } });
      if (path.endsWith("/viewed")) return route.fulfill({ json: { files: {} } });
      if (path.endsWith("/identity") || path.endsWith("/stack")) return route.fulfill({ json: null });
      return route.fulfill({ json: [] });
    });
  });

  test("default code fonts load without Google Fonts access", async () => {
    // Given third-party font services are unavailable
    await page.route("https://fonts.googleapis.com/**", (route) => route.abort());
    await page.route("https://fonts.gstatic.com/**", (route) => route.abort());
    // When the default code font is requested
    await page.goto("/pr/example/repo/1");
    const loadedFaces = await page.evaluate(async () => (await document.fonts.load('400 22px "IBM Plex Mono"', "const review = 123;")).length);
    // Then the bundled font is available rather than silently falling back
    expect(loadedFaces).toBeGreaterThan(0);
  });

  test("review summaries use the discussion prose scale", async () => {
    // Given an open PR overview
    await page.goto("/pr/example/repo/1");
    // When the summary composer appears
    await page.getByRole("button", { name: "PR overview", exact: true }).click();
    // Then summary text uses the same readable size as discussion text
    await expect(page.getByRole("combobox", { name: "Review summary", exact: true })).toHaveCSS("font-size", "16px");
  });

  test("review summaries use the prose family rather than the diff font", async () => {
    // Given an open PR overview
    await page.goto("/pr/example/repo/1");
    // When the summary composer appears
    await page.getByRole("button", { name: "PR overview", exact: true }).click();
    // Then writing and reading a review share the established sans-serif face
    await expect(page.getByRole("combobox", { name: "Review summary", exact: true })).toHaveCSS("font-family", '"Geist Variable", system-ui, sans-serif');
  });

  test("long dialog titles do not squeeze the header controls together", async () => {
    // Given a PR overview on a narrow display
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/pr/example/repo/1");
    // When the title must wrap beside its actions
    await page.getByRole("button", { name: "PR overview", exact: true }).click();
    const gap = await page.locator(".review-dialog > .modal-header > .modal-header-actions").evaluate((actions) => {
      const activity = actions.querySelector(".activity-slot")!.getBoundingClientRect();
      const help = actions.querySelector(":scope > .shortcut-help")!.getBoundingClientRect();
      return help.left - activity.right;
    });
    // Then activity and keyboard help remain distinct targets
    expect(gap).toBeGreaterThanOrEqual(8);
  });

  test("Geist Mono loads without third-party font services", async () => {
    // Given third-party font services are unavailable
    await page.route("https://fonts.googleapis.com/**", (route) => route.abort());
    await page.route("https://fonts.gstatic.com/**", (route) => route.abort());
    // When the reader selects Geist Mono
    await page.goto("/pr/example/repo/1");
    await page.getByRole("button", { name: "Biff menu", exact: true }).click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByLabel("Code font", { exact: true }).selectOption({ label: "Geist Mono" });
    const loadedFaces = await page.evaluate(async () => (await document.fonts.load('400 22px "Geist Mono Variable"', "const review = 123;")).length);
    // Then the bundled face is available rather than silently falling back
    expect(loadedFaces).toBeGreaterThan(0);
  });

  test("inline Markdown code follows the selected code font", async () => {
    // Given a PR description containing inline code
    await page.goto("/pr/example/repo/1");
    // When the reader changes the code font and opens the description
    await page.getByRole("button", { name: "Biff menu", exact: true }).click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByLabel("Code font", { exact: true }).selectOption("JetBrains Mono");
    await page.getByRole("button", { name: "Close settings", exact: true }).click();
    await page.getByRole("button", { name: "PR overview", exact: true }).click();
    // Then inline code uses the preference rather than a separate UI font
    await expect(page.locator(".markdown-body p code")).toHaveCSS("font-family", '"JetBrains Mono", monospace');
  });

  test("Markdown code blocks follow the selected code font", async () => {
    // Given a PR description containing a fenced code block
    await page.goto("/pr/example/repo/1");
    // When the reader changes the code font and opens the description
    await page.getByRole("button", { name: "Biff menu", exact: true }).click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByLabel("Code font", { exact: true }).selectOption("JetBrains Mono");
    await page.getByRole("button", { name: "Close settings", exact: true }).click();
    await page.getByRole("button", { name: "PR overview", exact: true }).click();
    // Then block code uses the same font as the diff
    await expect(page.locator(".markdown-body pre code")).toHaveCSS("font-family", '"JetBrains Mono", monospace');
  });

  test("code outside Markdown updates with the code font preference", async () => {
    // Given the working-copies page with its inline CLI instructions
    await page.goto("/workspaces");
    // When the reader changes the code font without reloading
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByLabel("Code font", { exact: true }).selectOption("Monaspace Argon");
    // Then ordinary inline code follows the same preference
    await expect(page.locator("code").filter({ hasText: "biff" })).toHaveCSS("font-family", '"Monaspace Argon", monospace');
  });
});
