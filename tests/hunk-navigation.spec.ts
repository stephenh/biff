import { chromium, expect, test, type Browser, type Page } from "@playwright/test";

test.describe("Hunk navigation", () => {
  let browser: Browser;
  let page: Page;

  test.beforeAll(async () => { browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium" }); });
  test.afterAll(async () => { await browser.close(); });
  test.afterEach(async () => { await page.close(); });
  test.beforeEach(async () => {
    page = await browser.newPage({ baseURL: "http://127.0.0.1:5173", reducedMotion: "reduce" });
    const workspace = { id: "fixture", name: "fixture", path: "/fixture" };
    const revision = { commit_id: "a".repeat(40), change_id: "qwerty", description: "Blank line navigation" };
    const patch = "diff --git a/first.txt b/first.txt\n--- a/first.txt\n+++ b/first.txt\n@@ -1 +1,7 @@\n+\n+ \t\n+new first\n context\n+\n+ \t\n+new second\n"
      + "diff --git a/second.txt b/second.txt\n--- a/second.txt\n+++ b/second.txt\n@@ -1 +1,3 @@\n context\n+\n+new third\n";
    await page.route("**/api/**", (route) => route.fulfill({ json: route.request().url().includes("/review?") ? { workspace, selected: revision, revisions: [revision], patch } : [] }));
    await page.goto("/workspaces/fixture");
    await expect(page.getByLabel("File reviewed", { exact: true })).toBeEnabled();
    await page.locator("[data-biff-focused]").waitFor();
  });

  test("opening a hunk selects its first non-blank addition", async () => {
    // Given a review whose first hunk starts with blank additions
    // When the initial hunk receives focus
    // Then the first code line is selected
    await expect(page.locator("[data-biff-focused]")).toHaveText("new first");
  });

  test("n selects the next hunk's first non-blank line", async () => {
    // Given the first hunk is selected
    // When the reader advances to the next hunk
    await page.keyboard.press("n");

    // Then leading whitespace is skipped
    await expect(page.locator("[data-biff-focused]")).toHaveText("new second");
  });

  test("p selects the preceding hunk's first non-blank line", async () => {
    // Given the reader has advanced to the second hunk
    await page.keyboard.press("n");
    await expect(page.locator("[data-biff-focused]")).toHaveText("new second");

    // When the reader returns to the previous hunk
    await page.keyboard.press("p");

    // Then its first code line is selected rather than its leading blanks
    await expect(page.locator("[data-biff-focused]")).toHaveText("new first");
  });

  test("hunk navigation across files skips leading blank lines", async () => {
    // Given the reader has reached the last hunk of the first file
    await page.keyboard.press("n");
    await expect(page.locator("[data-biff-focused]")).toHaveText("new second");

    // When the next hunk is in another file
    await page.keyboard.press("n");

    // Then that hunk's first code line is selected
    await expect(page.locator("[data-biff-focused]")).toHaveText("new third");
  });
});
