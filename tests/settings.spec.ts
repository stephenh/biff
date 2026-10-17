import { readFile } from "node:fs/promises";
import { chromium, expect, test, type Browser, type Page } from "@playwright/test";

test.describe("Settings", () => {
  let browser: Browser;
  let page: Page;

  test.beforeAll(async () => { browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium" }); });
  test.beforeEach(async () => {
    page = await browser.newPage({ baseURL: "http://127.0.0.1:5173", viewport: { width: 1440, height: 900 } });
    const patch = await readFile(new URL("../fixtures/demo.diff", import.meta.url), "utf8");
    const workspace = { id: "fixture", name: "fixture", path: "/fixture" };
    const revision = { commit_id: "a".repeat(40), change_id: "qwerty", description: "Settings fixture" };
    await page.route("**/api/**", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(
      route.request().url().includes("/review?") ? { workspace, selected: revision, revisions: [revision], patch } : [workspace],
    ) }));
  });
  test.afterEach(async () => { await page.close(); });
  test.afterAll(async () => { await browser.close(); });

  test("the code font setting survives reload", async () => {
    // Given a working-copy review and the top-navigation settings
    await page.goto("/workspaces/fixture");
    await page.getByRole("button", { name: "Settings", exact: true }).click();

    // When the reader changes the code font, then reloads
    await page.getByLabel("Code font", { exact: true }).selectOption("Monaspace Argon");
    await page.reload();
    const row = page.locator("[data-line]").first();

    // Then the code retains the chosen typography
    await expect(row).toHaveCSS("font-family", '"Monaspace Argon", monospace');
  });

  test("open settings suspend review navigation shortcuts", async () => {
    // Given the first file in a review
    await page.goto("/workspaces/fixture");
    await page.locator("[data-biff-focused]").waitFor();

    // When a navigation shortcut is pressed while settings are open
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.keyboard.press("l");
    await page.keyboard.press("Escape");

    // Then the selected file has not changed
    await expect(page.getByLabel("Current file", { exact: true })).toHaveValue("0");
  });

  test("the code text size setting survives reload", async () => {
    // Given a working-copy review and the top-navigation settings
    await page.goto("/workspaces/fixture");
    await page.getByRole("button", { name: "Settings", exact: true }).click();

    // When the reader changes the text size, then reloads
    await page.getByLabel("Text size", { exact: true }).fill("28");
    await page.reload();

    // Then the code retains the chosen size
    await expect(page.locator("[data-line]").first()).toHaveCSS("font-size", "28px");
  });

  test("the deleted-lines preference survives reload", async () => {
    // Given a review with collapsed deleted lines
    await page.goto("/workspaces/fixture");
    await page.getByRole("button", { name: "Settings", exact: true }).click();

    // When the reader disables collapsing and reloads
    await page.getByLabel("Collapse deleted lines", { exact: true }).uncheck();
    await page.reload();
    await page.getByRole("button", { name: "Settings", exact: true }).click();

    // Then Settings retains the expanded-lines preference
    await expect(page.getByLabel("Collapse deleted lines", { exact: true })).not.toBeChecked();
  });

  test("the shortcut guide suspends review navigation until dismissed", async () => {
    // Given the first file of a review
    await page.goto("/workspaces/fixture");
    await page.locator("[data-biff-focused]").waitFor();

    // When the reader opens the shortcut guide and presses a navigation key
    await page.getByRole("button", { name: "Keyboard shortcuts", exact: true }).click();
    await page.getByRole("dialog", { name: "Keyboard shortcuts", exact: true }).waitFor();
    await page.keyboard.press("l");
    await page.keyboard.press("Escape");

    // Then the file remains selected
    await expect(page.getByLabel("Current file", { exact: true })).toHaveValue("0");
  });
});
