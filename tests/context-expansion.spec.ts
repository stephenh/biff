import { chromium, expect, test, type Browser, type Page } from "@playwright/test";
import { createTwoFilesPatch } from "diff";

test.describe("Unmodified context expansion", () => {
  let browser: Browser;
  let page: Page;

  test.beforeAll(async () => { browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium" }); });
  test.beforeEach(async () => {
    page = await browser.newPage({ baseURL: "http://127.0.0.1:5173", viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
    await openContextReview(page);
  });
  test.afterEach(async () => { await page.close(); });
  test.afterAll(async () => { await browser.close(); });

  test("expanding unmodified lines retains the focused source coordinate", async () => {
    // Given a focused change after a large omitted section
    await page.keyboard.press("n");
    await page.locator("[data-biff-focused]").filter({ hasText: "const changed1500 = 1500;" }).waitFor();

    // When all unmodified context is expanded
    await page.keyboard.press("u");
    await page.locator('[data-content] > [data-line="1491"]').waitFor();

    // Then the cursor still identifies the same source line
    await expect(page.locator("[data-biff-focused]")).toHaveText("const changed1500 = 1500;");
  });

  test("expanding unmodified lines keeps the focused row centered", async () => {
    // Given a centered change after a large omitted section
    await page.keyboard.press("n");
    await page.locator("[data-biff-focused]").filter({ hasText: "const changed1500 = 1500;" }).waitFor();

    // When expansion changes the virtualized window above the cursor
    await page.keyboard.press("u");
    await page.locator('[data-content] > [data-line="1491"]').waitFor();

    // Then the focused row settles in the middle of the reading viewport
    await expect.poll(() => focusedCenterOffset(page)).toBeLessThan(2);
  });

  test("collapsing unmodified lines keeps the focused row centered", async () => {
    // Given expanded context around the second change
    await page.keyboard.press("n");
    await page.locator("[data-biff-focused]").filter({ hasText: "const changed1500 = 1500;" }).waitFor();
    // And the surrounding source has been expanded
    await page.keyboard.press("u");
    await page.locator('[data-content] > [data-line="1491"]').waitFor();

    // When the unmodified context is collapsed again
    await page.keyboard.press("u");
    await page.locator('[data-content] > [data-line="1491"]').waitFor({ state: "hidden" });

    // Then the selected change stays centered after the reverse layout change
    await expect.poll(() => focusedCenterOffset(page)).toBeLessThan(2);
  });

  test("releasing a context peek retains the focused row in the middle", async () => {
    // Given temporary context around a centered change
    await page.keyboard.press("n");
    await page.locator("[data-biff-focused]").filter({ hasText: "const changed1500 = 1500;" }).waitFor();
    // And the reader is holding Shift+U
    await page.keyboard.down("Shift");
    await page.keyboard.down("u");
    await page.locator('[data-content] > [data-line="1491"]').waitFor();

    // When the peek is released
    await page.keyboard.up("u");
    await page.keyboard.up("Shift");
    await page.locator('[data-content] > [data-line="1491"]').waitFor({ state: "hidden" });

    // Then collapsing the temporary context does not lose the reading position
    await expect.poll(() => focusedCenterOffset(page)).toBeLessThan(2);
  });

  test("clicking a native context expander retains the focused change", async () => {
    // Given a focused change immediately below a native collapsed-context separator
    await page.keyboard.press("n");
    await page.locator("[data-biff-focused]").filter({ hasText: "const changed1500 = 1500;" }).waitFor();

    // When the reader expands the preceding unmodified lines with the mouse
    await page.locator('[data-gutter] [data-expand-index="1"] [data-expand-down]').click({ timeout: 5000 });
    await page.locator('[data-content] > [data-line="1491"]').waitFor({ timeout: 5000 });

    // Then native expansion centers the same keyboard reading cursor
    await expect.poll(() => focusedCenterOffset(page)).toBeLessThan(2);
  });

  test("source hydration retains a newer line selected while expansion is loading", async () => {
    // Given an uncached source lookup after the initial syntax lookup failed
    await page.route("**/contents", (route) => route.fulfill({ status: 503, json: { error: "Source unavailable" } }), { times: 1 });
    const initial = page.waitForResponse("**/contents");
    await page.reload();
    await initial;
    await page.locator("[data-biff-focused]").filter({ hasText: "const changed10 = 10;" }).waitFor();
    // And a held retry for expanding unmodified lines
    const held = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    await page.route("**/contents", async (route) => { started.resolve(); await held.promise; await route.fallback(); });
    await page.keyboard.press("n");
    await page.locator("[data-biff-focused]").filter({ hasText: "const changed1500 = 1500;" }).waitFor();
    await page.keyboard.press("u");
    await started.promise;

    // When navigation moves to a newer line before the full source arrives
    try {
      await page.keyboard.press("j");
      await page.locator("[data-biff-focused]").filter({ hasText: "const value1501 = 1501;" }).waitFor({ timeout: 5000 });
    } finally { held.resolve(); }
    await page.locator('[data-content] > [data-line="1491"]').waitFor();

    // Then hydration does not restore the obsolete pre-expansion cursor
    await expect(page.locator("[data-biff-focused]")).toHaveText("const value1501 = 1501;");
  });
});

/** Load syntax context before exercising the already-hydrated expansion path. */
async function openContextReview(page: Page) {
  const lines = Array.from({ length: 2000 }, (_, index) => `const value${index} = ${index};`);
  const oldSource = `${lines.join("\n")}\n`;
  lines[10] = "const changed10 = 10;";
  lines[1500] = "const changed1500 = 1500;";
  const newSource = `${lines.join("\n")}\n`;
  const patch = createTwoFilesPatch("large.ts", "large.ts", oldSource, newSource);
  const workspace = { id: "fixture", name: "fixture", path: "/fixture" };
  const revision = { commit_id: "a".repeat(40), change_id: "qwerty", description: "Context expansion fixture" };
  await page.route("**/api/**", (route) => route.fulfill({ json: route.request().url().includes("/contents")
    ? { oldFile: { name: "large.ts", contents: oldSource }, newFile: { name: "large.ts", contents: newSource } }
    : route.request().url().includes("/review?") ? { workspace, selected: revision, revisions: [revision], patch } : [] }));
  const loaded = page.waitForResponse("**/contents");
  await page.goto("/workspaces/fixture");
  await loaded;
  await page.locator("[data-biff-focused]").filter({ hasText: "const changed10 = 10;" }).waitFor();
}

/** Measure visual focus independently of renderer indexes and virtual scroll estimates. */
async function focusedCenterOffset(page: Page): Promise<number> {
  return page.evaluate(() => {
    const viewport = document.querySelector<HTMLElement>('main[aria-label="Diff reading surface"]');
    const row = viewport?.querySelector("diffs-container")?.shadowRoot?.querySelector("[data-biff-focused]");
    if (!viewport || !row) return Infinity;
    const line = row.getBoundingClientRect();
    return Math.abs(line.top + line.height / 2 - viewport.getBoundingClientRect().top - viewport.clientHeight / 2);
  });
}
