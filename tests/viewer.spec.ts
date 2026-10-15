import { chromium, expect, test, type Browser, type Page } from "@playwright/test";

let browser: Browser;
let page: Page;

test.beforeAll(async () => { browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium" }); });
test.beforeEach(async () => { page = await browser.newPage({ baseURL: "http://127.0.0.1:5173", viewport: { width: 1440, height: 900 } }); });
test.afterEach(async () => { await page.close(); });
test.afterAll(async () => { await browser.close(); });

test.describe("Biff", () => {
  test("opens a patch file from disk", async () => {
    // Given the file picker
    await page.goto("/");

    // When a multi-file patch is loaded
    await page.locator('input[type="file"]').setInputFiles("fixtures/demo.diff");
    await page.getByLabel("Current file").selectOption("1");

    // Then the GraphQL file is rendered
    await expect(page.locator('[data-line-type="change-addition"]').getByText("CHANGES_REQUESTED", { exact: true })).toBeVisible();
  });

  test("rejects non-patch input without losing the current review", async () => {
    // Given an existing review
    await page.goto("/");
    await page.getByRole("button", { name: "Paste diff" }).click();

    // When invalid patch content is submitted
    await page.getByLabel("Unified diff").fill("This is not a diff");
    await page.getByRole("button", { name: "Open diff", exact: true }).click();
    await page.getByRole("button", { name: "Cancel" }).click();

    // Then an error explains why the review did not change
    await expect(page.getByRole("alert")).toHaveText("No file changes found. Open a Git-style unified .diff or .patch file.×");
    await expect(page.getByLabel("Current file")).toHaveValue("0");
  });
});
