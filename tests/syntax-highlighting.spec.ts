import { chromium, expect, test, type Browser, type Page } from "@playwright/test";
import { createTwoFilesPatch } from "diff";
import { syntaxContextFixture } from "../fixtures/syntaxContext";

const declarationTokens = ['it', '(', '"hides proposed fields"', ',', 'async', '()', '=>', '{'];

test.describe("Syntax highlighting", () => {
  let browser: Browser;
  let page: Page;
  let heldSource: Promise<void> | undefined;
  let failSource: boolean;
  const contents = syntaxContextFixture();

  test.beforeAll(async () => { browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium" }); });
  test.afterAll(async () => { await browser.close(); });
  test.afterEach(async () => { await page.close(); });
  test.beforeEach(async () => {
    page = await browser.newPage({ baseURL: "http://127.0.0.1:5173", reducedMotion: "reduce" });
    heldSource = undefined;
    failSource = false;
    const workspace = { id: "fixture", name: "fixture", path: "/fixture" };
    const revision = { commit_id: "a".repeat(40), change_id: "qwerty", description: "Syntax context fixture" };
    const other = { oldFile: { name: "other.ts", contents: "const other = 1;\n" }, newFile: { name: "other.ts", contents: "const other = 2;\n" } };
    const patch = contents.patch + createTwoFilesPatch("other.ts", "other.ts", other.oldFile.contents, other.newFile.contents);
    await page.route("**/api/**", async (route) => {
      const url = route.request().url();
      if (url.endsWith("/contents")) {
        if (route.request().postDataJSON().path === "other.ts") return route.fulfill({ json: other });
        await heldSource;
        return failSource ? route.fulfill({ status: 503, json: { error: "Source unavailable" } }) : route.fulfill({ json: contents });
      }
      return route.fulfill({ json: url.includes("/review?") ? { workspace, selected: revision, revisions: [revision], patch } : [] });
    });
  });

  test("a hunk beginning with a closing backtick retains normal syntax highlighting", async () => {
    // Given a template literal whose opening delimiter is omitted from the patch
    // When the review loads its full syntax context
    await page.goto("/workspaces/fixture");

    // Then the test declaration is code rather than one template-string token
    await expect(declaration(page).locator(":scope > span")).toHaveText(declarationTokens);
  });

  test("background syntax context preserves the latest reading cursor", async () => {
    // Given an initial partial diff with its full-source response held
    const held = Promise.withResolvers<void>();
    heldSource = held.promise;
    await page.goto("/workspaces/fixture");
    await declaration(page).click();
    // And the reader moves before source loading finishes
    await page.keyboard.press("j");
    const selected = page.locator("[data-biff-focused]");
    const text = await selected.textContent();

    try {
      // When the omitted syntax context arrives
      held.resolve();
      await expect(declaration(page).locator(":scope > span")).toHaveText(declarationTokens);

      // Then it does not undo the reader's latest line selection
      await expect(selected).toHaveText(text!);
    } finally { held.resolve(); }
  });

  test("loading syntax context does not expand unchanged source", async () => {
    // Given a review with many unchanged snapshot lines
    await page.goto("/workspaces/fixture");

    // When full-source syntax highlighting is ready
    await expect(declaration(page).locator(":scope > span")).toHaveText(declarationTokens);

    // Then omitted snapshot content stays collapsed
    await expect(page.locator("[data-content] > [data-line]").filter({ hasText: "Snapshot line 0" })).toHaveCount(0);
  });

  test("the frozen reference shares complete syntax context", async () => {
    // Given a correctly highlighted main-pane declaration
    await page.goto("/workspaces/fixture");
    await expect(declaration(page).locator(":scope > span")).toHaveText(declarationTokens);
    await declaration(page).click();

    // When the reader freezes it
    await page.keyboard.press("f");

    // Then the frozen declaration has the same complete syntax tokens
    await expect(page.locator("[data-biff-pinned]").locator(":scope > span")).toHaveText(declarationTokens);
  });

  test("unavailable syntax context leaves the cached diff navigable", async () => {
    // Given a source lookup that fails
    failSource = true;
    await page.goto("/workspaces/fixture");
    await declaration(page).click();

    // When the reader continues through the partial diff
    await page.keyboard.press("j");

    // Then source loading does not block normal review navigation
    await expect(page.locator("[data-biff-focused]")).toHaveText("    const view = await render(<Component />);");
  });

  test("late syntax context for a previous file does not change the current file", async () => {
    // Given the first file's source response is held
    const held = Promise.withResolvers<void>();
    heldSource = held.promise;
    await page.goto("/workspaces/fixture");
    await declaration(page).waitFor();
    // And the reader has moved to another file
    await page.keyboard.press("l");
    await expect(page.locator("[data-biff-focused]")).toHaveText("const other = 2;");

    try {
      // When the previous file's response arrives
      const loaded = page.waitForResponse((response) => response.url().endsWith("/contents") && response.request().postDataJSON().path !== "other.ts");
      held.resolve();
      await loaded;

      // Then the current reading file remains selected
      await expect(page.locator("[data-biff-focused]")).toHaveText("const other = 2;");
    } finally { held.resolve(); }
  });
});

/** Find the source declaration without depending on its syntax span boundaries. */
function declaration(page: Page) { return page.getByRole("main", { name: "Diff reading surface", exact: true }).locator("[data-content] > [data-line]").filter({ hasText: 'it("hides proposed fields"' }); }
