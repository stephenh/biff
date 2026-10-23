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
      route.request().url().includes("/review?") ? { workspace, selected: revision, revisions: [revision], patch } : [],
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
    await expect(page.getByLabel("Current file", { exact: true })).toHaveText("reviews.ts");
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

  test("review hints explain case-sensitive shortcuts on hover", async () => {
    // Given the first file of a review
    await page.goto("/workspaces/fixture");
    await page.locator("[data-biff-focused]").waitFor();

    // When the reader hovers over the uppercase deletion shortcut
    await page.getByRole("button", { name: "Keyboard shortcuts", exact: true }).click();
    await page.getByRole("button", { name: "D shortcut", exact: true }).hover();

    // Then the hint explains the hold behavior
    await expect(page.getByRole("tooltip")).toHaveText("DHold to peek at deleted lines");
  });

  test("file picker shows its own shortcuts while page hints are suspended", async () => {
    // Given an open review
    await page.goto("/workspaces/fixture");
    await page.locator("[data-biff-focused]").waitFor();

    // When the file picker opens
    await page.keyboard.press("Control+p");
    await page.getByRole("dialog", { name: "Go to file" }).getByRole("button", { name: "Keyboard shortcuts", exact: true }).click();

    // Then its compact strip describes result navigation
    await expect(page.getByRole("dialog", { name: "Go to file" }).getByRole("button", { name: "↓ shortcut", exact: true })).toBeVisible();
  });

  test("shortcut hints are available to keyboard focus", async () => {
    // Given an open review
    await page.goto("/workspaces/fixture");
    await page.locator("[data-biff-focused]").waitFor();

    // When the reader focuses a shortcut hint
    await page.keyboard.press("?");
    await page.getByRole("button", { name: "j shortcut", exact: true }).focus();

    // Then its description is visible without a pointer
    await expect(page.getByRole("tooltip")).toHaveText("jNext line");
  });

  test("modal shortcuts start collapsed", async () => {
    // Given a review
    await page.goto("/workspaces/fixture");
    await page.locator("[data-biff-focused]").waitFor();

    // When the picker opens
    await page.keyboard.press("Control+p");

    // Then its help is collapsed
    await expect(page.getByRole("dialog", { name: "Go to file" }).getByRole("button", { name: "Keyboard shortcuts", exact: true })).toHaveAttribute("aria-expanded", "false");
  });

  test("question mark toggles only the active modal's help", async () => {
    // Given a picker with focus outside its search input
    await page.goto("/workspaces/fixture");
    await page.locator("[data-biff-focused]").waitFor();
    await page.keyboard.press("Control+p");
    const dialog = page.getByRole("dialog", { name: "Go to file" });
    await dialog.getByRole("button", { name: "Close file picker", exact: true }).focus();

    // When the reader requests help
    await page.keyboard.press("?");

    // Then only modal help is expanded
    await expect(page.locator('.shortcuts-toggle[aria-expanded="true"]')).toHaveCount(1);
    await expect(dialog.getByRole("button", { name: "↓ shortcut", exact: true })).toBeVisible();
  });

  test("question marks in modal inputs remain text", async () => {
    // Given a picker focused on its query
    await page.goto("/workspaces/fixture");
    await page.locator("[data-biff-focused]").waitFor();
    await page.keyboard.press("Control+p");

    // When the reader types a question mark
    await page.keyboard.type("?");

    // Then the input receives it without expanding help
    await expect(page.getByRole("combobox", { name: "Search files" })).toHaveValue("?");
    await expect(page.getByRole("dialog", { name: "Go to file" }).getByRole("button", { name: "Keyboard shortcuts", exact: true })).toHaveAttribute("aria-expanded", "false");
  });

  test("settings has an explicit close control", async () => {
    // Given open settings with its help expanded
    await page.goto("/workspaces/fixture");
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
    await dialog.getByRole("button", { name: "Keyboard shortcuts", exact: true }).click();

    // When the reader closes settings with X
    await dialog.getByRole("button", { name: "Close settings", exact: true }).click();

    // Then the popover is dismissed
    await expect(dialog).not.toBeVisible();
  });

  test("reopened popovers reset their shortcut disclosure", async () => {
    // Given settings whose help was expanded and dismissed
    await page.goto("/workspaces/fixture");
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
    await dialog.getByRole("button", { name: "Keyboard shortcuts", exact: true }).click();
    await dialog.getByRole("button", { name: "Close settings", exact: true }).click();

    // When settings reopens
    await page.getByRole("button", { name: "Settings", exact: true }).click();

    // Then help starts collapsed again
    await expect(dialog.getByRole("button", { name: "Keyboard shortcuts", exact: true })).toHaveAttribute("aria-expanded", "false");
  });
});
