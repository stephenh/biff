import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { chromium, type Browser, type Locator, type Page } from "@playwright/test";

describe("viewer", () => {
  let server: ReturnType<typeof Bun.spawn>;
  let browser: Browser | undefined;
  let page: Page | undefined;
  const url = "http://127.0.0.1:5174";

  beforeAll(async () => {
    // Use an isolated server so testing does not depend on the user's dev session.
    server = Bun.spawn(["bun", "node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "5174", "--strictPort"], {
      cwd: new URL("..", import.meta.url).pathname,
      stdout: "ignore",
      stderr: "inherit",
    });
    await waitForServer(url, server);
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium" });
  });

  beforeEach(async () => {
    page = await browser!.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.goto(url);
    // Wait for syntax highlighting as well as the post-render deletion grouping.
    await page.locator('[data-line][data-biff-start] span[style*="color"]').first().waitFor({ state: "attached" });
    await page.clock.install();
    await page.clock.pauseAt(new Date(Date.now() + 1000));
  });

  afterEach(async () => { await page?.close(); });
  afterAll(async () => {
    await browser?.close();
    server?.kill();
    await server?.exited;
  });

  test("a quick pass over a deletion never expands it", async () => {
    // Given a collapsed block of two deleted lines
    const rows = page!.locator('[data-line][data-biff-group="1"]');

    // When the pointer leaves before the 50ms delay has elapsed
    await rows.first().hover();
    await page!.clock.runFor(49);
    await page!.mouse.move(0, 0);
    await page!.clock.runFor(100);

    // Then the entire block stays a single 10px strip
    expect(await rowHeights(rows)).toEqual([10, 0]);
  });

  test("hover expansion waits the full 50ms", async () => {
    // Given a collapsed block of two deleted lines
    const rows = page!.locator('[data-line][data-biff-group="1"]');

    // When the pointer remains over the strip for only 49ms
    await rows.first().hover();
    await page!.clock.runFor(49);

    // Then the code is still collapsed
    expect(await rowHeights(rows)).toEqual([10, 0]);
  });

  test("a deliberate hover reveals every deleted row at the normal text size", async () => {
    // Given a collapsed block of two deleted lines
    const rows = page!.locator('[data-line][data-biff-group="1"]');

    // When the pointer stays for 50ms
    await rows.first().hover();
    await page!.clock.runFor(50);

    // Then both rows expand with the same typography as new code
    expect(await rowHeights(rows)).toEqual([35, 35]);
    expect(await rows.evaluateAll((elements) => elements.map((element) => getComputedStyle(element).fontSize))).toEqual(["22px", "22px"]);
  });

  test("moving away collapses the whole revealed block", async () => {
    // Given an expanded deletion block
    const rows = page!.locator('[data-line][data-biff-group="1"]');
    await rows.first().hover();
    await page!.clock.runFor(50);

    // When the pointer moves into the header
    await page!.mouse.move(0, 0);

    // Then the block returns to one thin strip
    expect(await rowHeights(rows)).toEqual([10, 0]);
  });

  test("keyboard focus reveals old code without a hover delay", async () => {
    // Given a collapsed deletion block
    const rows = page!.locator('[data-line][data-biff-group="1"]');

    // When a keyboard user focuses its strip
    await rows.first().focus();

    // Then the whole block is immediately readable
    expect(await rowHeights(rows)).toEqual([35, 35]);
  });

  test("the toolbar can keep all deleted lines expanded", async () => {
    // Given collapsed deleted lines
    const deletions = page!.locator('[data-line][data-line-type="change-deletion"]');

    // When the reader disables collapsing
    await page!.getByLabel("Collapse deleted lines").uncheck();

    // Then every deleted row is readable without hovering
    expect(await rowHeights(deletions)).toEqual([35, 35, 35, 35]);
  });

  test("patch2 opens the downloaded PR", async () => {
    // Given the demo review
    // When the reader selects patch2 in the header
    await page!.getByRole("button", { name: "patch2", exact: true }).click();

    // Then the file picker lists the PR's two changed files
    expect(await page!.getByLabel("Current file").locator("option").allTextContents()).toEqual([
      "src/entities/CheckoutConfig.optionPricing.test.ts",
      "src/entities/CheckoutConfig.optionPricing.ts",
    ]);
  });
});

/** Measure rendered rows in Chromium: DOM emulators cannot verify grid collapse. */
async function rowHeights(rows: Locator): Promise<number[]> {
  return rows.evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().height));
}

/** Wait for Vite to serve the test app, failing if the child process exits. */
async function waitForServer(url: string, server: ReturnType<typeof Bun.spawn>) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Test server exited with code ${server.exitCode}`);
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // Vite has not bound its port yet.
    }
    await Bun.sleep(50);
  }
  throw new Error("Timed out waiting for the test server on port 5174");
}
