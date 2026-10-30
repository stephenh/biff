import { chromium, expect, test, type Browser, type Page } from "@playwright/test";
import { createTwoFilesPatch } from "diff";

test.describe("Frozen diff", () => {
  let browser: Browser;
  let page: Page;

  test.beforeAll(async () => { browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium" }); });
  test.beforeEach(async () => {
    page = await browser.newPage({ baseURL: "http://127.0.0.1:5173", viewport: { width: 1600, height: 1000 }, reducedMotion: "reduce" });
    await mockReview(page);
    await page.goto("/workspaces/fixture");
    await expect(page.locator("[data-biff-focused]")).toHaveText("const changed10 = 10;");
  });
  test.afterEach(async () => { await page.close(); });
  test.afterAll(async () => { await browser.close(); });

  test("f opens a reference at the selected source line", async () => {
    // Given the main review cursor on a business change
    // When the reader freezes it
    await page.keyboard.press("f");

    // Then the reference highlights that source coordinate in its own viewport
    await expect(page.locator("[data-biff-pinned]")).toHaveText("const changed10 = 10;");
    await expect(page.locator("[data-biff-pinned]")).toBeInViewport();
  });

  test("line navigation still belongs to the main reviewer", async () => {
    // Given a frozen reference
    await page.keyboard.press("f");
    await page.locator("[data-biff-pinned]").waitFor();

    // When the reader continues down in the main pane
    await page.keyboard.press("j");

    // Then its cursor advances without entering the reference
    await expect(page.locator("[data-biff-focused]")).toHaveText("const value11 = 11;");
  });

  test("the reference remains frozen across main-pane file switches", async () => {
    // Given a frozen reference to the first file
    await page.keyboard.press("f");
    await page.locator("[data-biff-pinned]").waitFor();

    // When the main reviewer opens another file
    await page.keyboard.press("l");
    await expect(page.locator("[data-biff-focused]")).toHaveText("const other = 2;");

    // Then the original file and line remain in the reference
    await expect(page.locator("[data-biff-pinned]")).toHaveText("const changed10 = 10;");
  });

  test("f replaces the reference with the current main-pane line", async () => {
    // Given an existing frozen reference
    await page.keyboard.press("f");
    await page.locator("[data-biff-pinned]").waitFor();

    // When the reader freezes a different line
    await page.keyboard.press("j");
    await page.keyboard.press("f");

    // Then the single reference points at the new line
    await expect(page.locator("[data-biff-pinned]")).toHaveText("const value11 = 11;");
  });

  test("Escape closes the reference without resetting the main cursor", async () => {
    // Given a frozen reference and a main cursor that has moved on
    await page.keyboard.press("f");
    await page.locator("[data-biff-pinned]").waitFor();
    await page.keyboard.press("j");

    // When the reader closes the split
    await page.keyboard.press("Escape");

    // Then the main reviewer retains its reading position
    await expect(page.getByRole("complementary", { name: "Frozen diff", exact: true })).toHaveCount(0);
    await expect(page.locator("[data-biff-focused]")).toHaveText("const value11 = 11;");
  });

  test("scrolling the reference does not scroll the main reviewer", async () => {
    // Given the reference expanded to include the entire source
    await page.keyboard.press("f");
    await page.getByRole("button", { name: "Show unmodified lines in frozen diff", exact: true }).click();
    await expect(page.locator("[data-biff-pinned]")).toBeInViewport();
    const main = page.getByRole("main", { name: "Diff reading surface", exact: true });
    const top = await main.evaluate((element) => element.scrollTop);

    // When the reader scrolls far down in the reference
    const reference = page.getByLabel("Frozen diff reading surface", { exact: true });
    await reference.hover();
    await page.mouse.wheel(0, 6000);
    await expect.poll(() => reference.evaluate((element) => element.scrollTop)).toBeGreaterThan(5000);

    // Then the main scroll position is unchanged
    await expect.poll(() => main.evaluate((element) => element.scrollTop)).toBeCloseTo(top, 0);
  });

  test("the reference uses a bounded native window even with full context", async () => {
    // Given a reference with two thousand source lines available
    await page.keyboard.press("f");
    await page.getByRole("button", { name: "Show unmodified lines in frozen diff", exact: true }).click();
    const reference = page.getByLabel("Frozen diff reading surface", { exact: true });

    // When its window moves far beyond the frozen line
    await reference.evaluate((element) => { element.scrollTop = 30_000; });
    await expect(page.locator("[data-biff-pinned]")).toHaveCount(0);

    // Then only a viewport-sized subset of the reference is mounted
    expect(await reference.locator("[data-content] > [data-line]").count()).toBeLessThan(250);
  });

  test("return to frozen line reveals it after independent scrolling", async () => {
    // Given a reference scrolled away from its original pin
    await page.keyboard.press("f");
    await page.getByRole("button", { name: "Show unmodified lines in frozen diff", exact: true }).click();
    await page.getByLabel("Frozen diff reading surface", { exact: true }).evaluate((element) => { element.scrollTop = 30_000; });
    await expect(page.locator("[data-biff-pinned]")).toHaveCount(0);

    // When the reader returns to the pin
    await page.getByRole("button", { name: "Return to frozen line", exact: true }).click();

    // Then the original line is mounted and visible again
    await expect(page.locator("[data-biff-pinned]")).toBeInViewport();
    await expect(page.locator("[data-biff-pinned]")).toHaveText("const changed10 = 10;");
  });

  test("freezing a distant search result reveals the correct source coordinate", async () => {
    // Given the cursor moved to a distant change
    await page.keyboard.press("Control+f");
    await page.getByRole("textbox", { name: "Search files and symbols" }).fill("changed1500");
    await page.locator(".search-result").click();
    await expect(page.locator("[data-biff-focused]")).toHaveText("const changed1500 = 1500;");

    // When that line is frozen
    await page.keyboard.press("f");

    // Then the reference opens at the distant source line, not the first hunk
    await expect(page.locator("[data-biff-pinned]")).toHaveText("const changed1500 = 1500;");
    await expect(page.locator("[data-biff-pinned]")).toBeInViewport();
  });

  test("freezing a deleted line retains the old side", async () => {
    // Given the cursor on a revealed deletion
    await page.keyboard.press("d");
    await page.keyboard.press("k");
    await expect(page.locator("[data-biff-focused]")).toHaveText("const value10 = 10;");

    // When the old line is frozen
    await page.keyboard.press("f");

    // Then the reference shows the deletion rather than the same-numbered addition
    await expect(page.locator("[data-biff-pinned]")).toHaveText("const value10 = 10;");
    await expect(page.locator("[data-biff-pinned]")).toBeInViewport();
  });

  test("reference import expansion does not change the main pane's folds", async () => {
    // Given a frozen file with collapsed import changes
    await page.keyboard.press("f");
    const reference = page.getByLabel("Frozen diff reading surface", { exact: true });
    await reference.evaluate((element) => { element.scrollTop = 0; });

    // When the reference's import group is expanded
    await reference.locator("[data-fold-toggle][data-separator-content]").click();
    await reference.locator("[data-host-fold-expanded]").first().waitFor();

    // Then the main review still has no expanded import rows
    await expect(page.getByRole("main", { name: "Diff reading surface", exact: true }).locator("[data-host-fold-expanded]")).toHaveCount(0);
  });

  test("resizing the split retains the main source cursor", async () => {
    // Given a frozen comparison
    await page.keyboard.press("f");
    await page.locator("[data-biff-pinned]").waitFor();

    // When the keyboard resizes the divider
    const divider = page.getByRole("separator", { name: "Resize frozen diff", exact: true });
    await divider.focus();
    await divider.press("ArrowLeft");

    // Then resize does not run the main review's previous-file shortcut
    await expect(page.locator("[data-biff-focused]")).toHaveText("const changed10 = 10;");
    await expect(page.locator("[data-biff-focused]")).toBeInViewport();
  });

  test("freezing hydrated unmodified context retains its source coordinate", async () => {
    // Given a search result in context omitted from the original patch
    await page.keyboard.press("Control+f");
    await page.getByRole("textbox", { name: "Search files and symbols" }).fill("const value1000 =");
    await page.locator(".search-result").click();
    await expect(page.locator("[data-biff-focused]")).toHaveText("const value1000 = 1000;");

    // When the reader freezes the hydrated line
    await page.keyboard.press("f");

    // Then the reference also reveals the omitted source coordinate
    await expect(page.locator("[data-biff-pinned]")).toHaveText("const value1000 = 1000;");
    await expect(page.locator("[data-biff-pinned]")).toBeInViewport();
  });

  test("loading reference context does not block main-pane navigation", async () => {
    // Given a reference whose full source request is held
    await mockReview(page, false);
    // And the initial syntax lookup is unavailable, leaving reference context uncached
    await page.route("**/contents", (route) => route.fulfill({ status: 503, json: { error: "Source temporarily unavailable" } }), { times: 1 });
    const initialLookup = page.waitForResponse("**/contents");
    await page.reload();
    await initialLookup;
    await expect(page.locator("[data-biff-focused]")).toHaveText("const changed10 = 10;");
    await page.keyboard.press("f");
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    await page.route("**/contents", async (route) => { await held; await route.fallback(); });
    const requested = page.waitForRequest("**/contents");
    await page.getByRole("button", { name: "Show unmodified lines in frozen diff", exact: true }).click();
    await requested;

    try {
      // When the reader switches the main reviewer to another file
      await page.keyboard.press("l");

      // Then the main file opens before reference loading completes
      await expect(page.locator("[data-biff-focused]")).toHaveText("const other = 2;");
    } finally { release(); }
  });

  test("failed reference context loading can be retried", async () => {
    // Given an uncached source lookup that fails once
    await mockReview(page, false);
    // And both the initial syntax lookup and the first reference lookup fail
    await page.route("**/contents", (route) => route.fulfill({ status: 503, json: { error: "Source temporarily unavailable" } }), { times: 2 });
    const initialLookup = page.waitForResponse("**/contents");
    await page.reload();
    await initialLookup;
    await expect(page.locator("[data-biff-focused]")).toHaveText("const changed10 = 10;");
    await page.keyboard.press("f");
    await page.getByRole("button", { name: "Show unmodified lines in frozen diff", exact: true }).click();
    await page.getByRole("button", { name: /Activity: .*attention/ }).click();
    await page.getByText("Source temporarily unavailable", { exact: true }).waitFor();

    // When the reader retries the reference lookup and scrolls into omitted context
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    const reference = page.getByLabel("Frozen diff reading surface", { exact: true });
    await reference.evaluate((element) => { element.scrollTop = 30_000; });

    // Then full source is available beyond the original patch's context
    await expect.poll(async () => Number(await reference.locator("[data-content] > [data-line]").first().getAttribute("data-line"))).toBeGreaterThan(500);
  });

  test("typing f in file search does not open a reference", async () => {
    // Given focus in the current-file search field
    await page.keyboard.press("/");

    // When the reader types f
    await page.getByRole("textbox", { name: "Search current file", exact: true }).press("f");

    // Then typing does not run the freeze shortcut
    await expect(page.getByRole("complementary", { name: "Frozen diff", exact: true })).toHaveCount(0);
  });

  test("Escape closes file search before closing the reference", async () => {
    // Given a frozen reference with current-file search open
    await page.keyboard.press("f");
    await page.locator("[data-biff-pinned]").waitFor();
    await page.keyboard.press("/");

    // When the reader dismisses file search
    await page.keyboard.press("Escape");

    // Then the frozen comparison remains available
    await expect(page.getByRole("complementary", { name: "Frozen diff", exact: true })).toBeVisible();
  });

  test("review completion applies only to the main pane's current file", async () => {
    // Given a reference frozen on the first file
    await page.keyboard.press("f");
    await page.locator("[data-biff-pinned]").waitFor();
    // And a progress endpoint that acknowledges review completion
    const reviewed: string[] = [];
    await page.route("**/progress", (route) => {
      const body = route.request().postDataJSON() as { changes: { identity: { path: string }; reviewed: boolean }[] };
      reviewed.push(...body.changes.map((change) => change.identity.path));
      return route.fulfill({ json: body.changes.filter((change) => change.reviewed).map((change) => change.identity) });
    });

    // When the reader reviews the second file from the main pane
    await page.keyboard.press("l");
    await expect(page.locator("[data-biff-focused]")).toHaveText("const other = 2;");
    await page.keyboard.press("Space");

    // Then only the second file's change is acknowledged
    await expect.poll(() => reviewed).toEqual(["other.ts"]);
  });
});

/** Serve a long, source-hydratable diff and a second file without touching live review data. */
async function mockReview(page: Page, imports = true) {
  const oldSource = (imports ? 'import { Before } from "module";\n\n' : "") + Array.from({ length: 2000 }, (_, index) => `const value${index} = ${index};\n`).join("");
  const newSource = oldSource.replace("Before", "After").replace("value10 = 10", "changed10 = 10").replace("value1500 = 1500", "changed1500 = 1500");
  const otherOld = "const other = 1;\n";
  const otherNew = "const other = 2;\n";
  const patch = createTwoFilesPatch("large.ts", "large.ts", oldSource, newSource) + createTwoFilesPatch("other.ts", "other.ts", otherOld, otherNew);
  const workspace = { id: "fixture", name: "fixture", path: "/fixture" };
  const revision = { commit_id: "a".repeat(40), change_id: "qwerty", description: "Frozen diff fixture" };
  await page.route("**/api/**", (route) => {
    const url = route.request().url();
    if (url.includes("/contents")) {
      const path = route.request().postDataJSON().path as string;
      return route.fulfill({ json: { oldFile: { name: path, contents: path === "large.ts" ? oldSource : otherOld }, newFile: { name: path, contents: path === "large.ts" ? newSource : otherNew } } });
    }
    return route.fulfill({ json: url.includes("/review?") ? { workspace, selected: revision, revisions: [revision], patch } : [] });
  });
}
