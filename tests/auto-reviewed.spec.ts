import { chromium, expect, test, type Browser, type Page } from "@playwright/test";

test.describe("Automatically reviewed files", () => {
  let browser: Browser;
  let page: Page;

  test.beforeAll(async () => { browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium" }); });
  test.afterAll(async () => { await browser.close(); });
  test.afterEach(async () => { await page.close(); });
  test.beforeEach(async () => {
    page = await browser.newPage({ baseURL: "http://127.0.0.1:5173" });
    const workspace = { id: "fixture", name: "fixture", path: "/fixture" };
    const revision = { commit_id: "a".repeat(40), change_id: "qwerty", description: "Generated files" };
    const patch = ["schema.graphql", "yarn.lock", "src/schema.graphql"].map((path) =>
      `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old value\n+new value\n`,
    ).join("");
    await page.route("**/api/**", (route) => route.fulfill({ json:
      route.request().url().includes("/review?") ? { workspace, selected: revision, revisions: [revision], patch } : [],
    }));
    await page.goto("/workspaces/fixture");
    await expect(page.getByRole("progressbar", { name: "Change review progress" })).toHaveAttribute("aria-valuetext", "0 of 1 changes reviewed");
  });

  test("root generated files count toward file completion", async () => {
    // Given a fresh review with two generated files and one ordinary file
    // When progress loads without saved review marks
    // Then both root generated files are already complete
    await expect(page.getByRole("img", { name: "2 of 3 files reviewed" })).toBeVisible();
  });

  test("all hunks in the lockfile are reviewed automatically", async () => {
    // Given the viewer has skipped to the ordinary file
    // When the reader goes back to the lockfile
    await page.keyboard.press("ArrowLeft");

    // Then its changed hunk is already reviewed
    await expect(page.getByRole("progressbar", { name: "Change review progress" })).toHaveAttribute("aria-valuetext", "1 of 1 changes reviewed");
  });

  test("nested schema files still require review", async () => {
    // Given generated root files precede a nested schema file
    // When the viewer chooses the first unreviewed change
    // Then it skips the root files but keeps the nested file in the review
    await expect(page.getByLabel("Current file")).toHaveAttribute("title", "src/schema.graphql");
  });
});
