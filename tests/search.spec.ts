import { chromium, expect, test, type Browser, type Page } from "@playwright/test";

test.describe("Review search", () => {
  let browser: Browser;
  let page: Page;
  test.beforeAll(async () => { browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium" }); });
  test.afterAll(async () => { await browser.close(); });
  test.afterEach(async () => { await page.close(); });
  test.beforeEach(async () => {
    page = await browser.newPage({ baseURL: "http://127.0.0.1:5173", viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
    const workspace = { id: "fixture", name: "fixture", path: "/fixture" };
    const revision = { commit_id: "a".repeat(40), change_id: "qwerty", description: "Search fixture" };
    const patch = 'diff --git a/first.ts b/first.ts\n--- a/first.ts\n+++ b/first.ts\n@@ -1 +1 @@\n-const before = 1;\n+const useFeature = 2;\ndiff --git a/second.ts b/second.ts\n--- a/second.ts\n+++ b/second.ts\n@@ -1 +1 @@\n-import { oldFeature } from "flags";\n+import { useFeature } from "flags";\n';
    await page.route("**/api/**", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(
      route.request().url().includes("/contents") ? { oldFile: { name: "second.ts", contents: 'import { oldFeature } from "flags";\nconst hiddenSymbol = 3;\n' }, newFile: { name: "second.ts", contents: 'import { useFeature } from "flags";\nconst hiddenSymbol = 3;\n' } }
        : route.request().url().includes("/review?") ? { workspace, selected: revision, revisions: [revision], patch } : [workspace],
    ) }));
    await page.goto("/workspaces/fixture");
  });

  test("finds symbols across files", async () => {
    // Given a review with a symbol in two files
    // When the find shortcut searches for that symbol
    await page.keyboard.press("Control+f");
    await page.getByRole("textbox", { name: "Search files and symbols" }).fill("useFeature");
    // Then both files have a matching snippet
    await expect(page.locator(".search-result")).toHaveCount(2);
  });

  test("reveals a folded import in another file", async () => {
    // Given a symbol in a folded import
    await page.keyboard.press("Control+f");
    await page.getByRole("textbox", { name: "Search files and symbols" }).fill("useFeature");
    // When its result is selected
    await page.locator(".search-result").filter({ hasText: "import" }).click();
    // Then the import becomes the selected diff line
    await expect(page.getByRole("main", { name: "Diff reading surface" }).locator("[data-biff-focused]")).toHaveText('import { useFeature } from "flags";');
  });

  test("reveals omitted source context", async () => {
    // Given a symbol outside the patch context
    await page.keyboard.press("Control+f");
    await page.getByRole("textbox", { name: "Search files and symbols" }).fill("hiddenSymbol");
    // When the second file's hidden result is selected
    await page.locator(".search-result").last().click();
    // Then hydration reveals and selects the requested source line
    await expect(page.getByRole("main", { name: "Diff reading surface" }).locator("[data-biff-focused]")).toHaveText("const hiddenSymbol = 3;");
  });

  test("finds files and closes with Escape", async () => {
    // Given a filename search
    await page.keyboard.press("Control+f");
    await page.getByRole("textbox", { name: "Search files and symbols" }).fill("second.ts");
    // When the file is opened and search dismissed
    await page.getByRole("textbox", { name: "Search files and symbols" }).press("Enter");
    await page.keyboard.press("Escape");
    // Then the overlay is closed
    await expect(page.getByRole("dialog", { name: "Find in review" })).toHaveCount(0);
  });

  test("reopening search retains matches for navigation to another file", async () => {
    // Given a search that has already navigated to one match
    await page.keyboard.press("Control+f");
    await page.getByRole("textbox", { name: "Search files and symbols" }).fill("useFeature");
    await page.locator(".search-result").first().click();
    await page.keyboard.press("Escape");

    // When search reopens and the other match is selected without retyping
    await page.keyboard.press("Control+f");
    await page.locator(".search-result").filter({ hasText: "import" }).click();

    // Then the other file's matching line is selected
    await expect(page.getByRole("main", { name: "Diff reading surface" }).locator("[data-biff-focused]")).toHaveText('import { useFeature } from "flags";');
  });

  test("j previews the next match without closing search", async () => {
    // Given keyboard focus on the first result
    await page.keyboard.press("Control+f");
    await page.getByRole("textbox", { name: "Search files and symbols" }).fill("useFeature");
    await page.keyboard.press("ArrowDown");

    // When the next result is selected with j
    await page.keyboard.press("j");

    // Then its source line is selected in the main view
    await expect(page.getByRole("main", { name: "Diff reading surface" }).locator("[data-biff-focused]")).toHaveText('import { useFeature } from "flags";');
  });

  test("Enter closes search and reopening restores the selected option", async () => {
    // Given the second result selected with the keyboard
    await page.keyboard.press("Control+f");
    await page.getByRole("textbox", { name: "Search files and symbols" }).fill("useFeature");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("j");

    // When the selection is accepted and search reopened
    await page.keyboard.press("Enter");
    await page.getByRole("dialog", { name: "Find in review" }).waitFor({ state: "detached" });
    await page.keyboard.press("Control+f");

    // Then keyboard focus returns to the same result
    await expect(page.locator(".search-result").filter({ hasText: "import" })).toBeFocused();
  });

  test("k previews the preceding match after reopening", async () => {
    // Given a search closed by clicking its second match
    await page.keyboard.press("Control+f");
    await page.getByRole("textbox", { name: "Search files and symbols" }).fill("useFeature");
    await page.locator(".search-result").filter({ hasText: "import" }).click();
    await page.getByRole("dialog", { name: "Find in review" }).waitFor({ state: "detached" });

    // When search reopens and k selects the preceding match
    await page.keyboard.press("Control+f");
    await page.locator(".search-result").filter({ hasText: "import" }).waitFor();
    await page.keyboard.press("k");

    // Then the first file's match is selected in the main view
    await expect(page.getByRole("main", { name: "Diff reading surface" }).locator("[data-biff-focused]")).toHaveText("const useFeature = 2;");
  });
});
