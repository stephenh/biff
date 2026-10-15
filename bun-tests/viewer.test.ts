import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { chromium, expect as browserExpect, type Browser, type Locator, type Page } from "@playwright/test";

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
    // Keep layout assertions immediate; reduced motion is also a supported UI mode.
    page = await browser!.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
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

  test("Shift+J scrolls to the next change within the same file", async () => {
    // Given the demo's first change, inside a patch hunk containing three edits

    // When the reader moves forward one hunk
    await page!.keyboard.press("Shift+J");

    // Then the second change in reviews.ts is selected and visually centered
    expect(await page!.getByLabel("Current file").inputValue()).toBe("0");
    expect(await page!.getByLabel("Current hunk").textContent()).toBe("Hunk 2 / 3");
    const hunk = page!.locator('[data-line][data-biff-focused]');
    await hunk.waitFor({ state: "attached" });
    const viewport = await page!.locator("main").boundingBox();
    const bounds = await hunk.boundingBox();
    expect(await hunk.getAttribute("data-line-index")).toBe("10,7");
    expect(Math.abs(bounds!.y + bounds!.height / 2 - viewport!.y - viewport!.height / 2)).toBeLessThan(2);
  });

  test("Shift+J crosses the last change into the next file", async () => {
    // Given the demo's first file at its third and final change
    await page!.keyboard.press("Shift+J");
    await page!.keyboard.press("Shift+J");

    // When the reader advances again
    await page!.keyboard.press("Shift+J");

    // Then the next file opens at its first hunk
    expect(await page!.getByLabel("Current file").inputValue()).toBe("1");
    expect(await page!.getByLabel("Current hunk").textContent()).toBe("Hunk 1 / 3");
  });

  test("Shift+K crosses the first change into the previous file's last change", async () => {
    // Given the demo's second file at its first change
    await page!.keyboard.press("n");

    // When the reader moves backward one hunk
    await page!.keyboard.press("Shift+K");

    // Then the previous file opens at its last hunk
    expect(await page!.getByLabel("Current file").inputValue()).toBe("0");
    expect(await page!.getByLabel("Current hunk").textContent()).toBe("Hunk 3 / 3");
  });

  test("n skips remaining hunks and opens the next file", async () => {
    // Given the demo's first file still at its first change

    // When the reader requests the next file
    await page!.keyboard.press("n");

    // Then the next file opens at its first hunk
    expect(await page!.getByLabel("Current file").inputValue()).toBe("1");
    expect(await page!.getByLabel("Current hunk").textContent()).toBe("Hunk 1 / 3");
  });

  test("p opens the previous file at its first hunk", async () => {
    // Given the demo's second file
    await page!.keyboard.press("n");

    // When the reader requests the previous file
    await page!.keyboard.press("p");

    // Then the previous file opens at its first hunk
    expect(await page!.getByLabel("Current file").inputValue()).toBe("0");
    expect(await page!.getByLabel("Current hunk").textContent()).toBe("Hunk 1 / 3");
  });

  test("shortcut letters typed in a patch do not navigate", async () => {
    // Given the paste dialog
    await page!.getByRole("button", { name: "Paste diff" }).click();

    // When the reader types letters that are navigation shortcuts
    await page!.getByLabel("Unified diff").pressSequentially("jjknnp");

    // Then the text is entered and the current review stays selected
    expect(await page!.getByLabel("Unified diff").inputValue()).toBe("jjknnp");
    expect(await page!.getByLabel("Current file").inputValue()).toBe("0");
  });

  test("Shift+K centers the first change even near the beginning of a file", async () => {
    // Given the second change in reviews.ts
    await page!.keyboard.press("Shift+J");

    // When the reader navigates backward
    await page!.keyboard.press("Shift+K");

    // Then the first added line is centered, not clamped to the viewport top
    const line = await page!.locator("[data-biff-focused]").boundingBox();
    const viewport = await page!.locator("main").boundingBox();
    expect(Math.abs(line!.y + line!.height / 2 - viewport!.y - viewport!.height / 2)).toBeLessThan(2);
  });

  test("the last change can be centered near the end of a file", async () => {
    // Given the second change in reviews.ts
    await page!.keyboard.press("Shift+J");

    // When the reader navigates to its final change
    await page!.keyboard.press("Shift+J");

    // Then the final change is centered rather than clamped to the viewport bottom
    const line = await page!.locator("[data-biff-focused]").boundingBox();
    const viewport = await page!.locator("main").boundingBox();
    expect(Math.abs(line!.y + line!.height / 2 - viewport!.y - viewport!.height / 2)).toBeLessThan(2);
  });

  test("j moves to the next context line and centers it", async () => {
    // Given focus on the first added line in reviews.ts

    // When the reader steps down one line
    await page!.keyboard.press("j");

    // Then the following context line is focused at the center
    const focused = page!.locator("[data-biff-focused]");
    expect(await focused.getAttribute("data-line-index")).toBe("4,3");
    const line = await focused.boundingBox();
    const viewport = await page!.locator("main").boundingBox();
    expect(Math.abs(line!.y + line!.height / 2 - viewport!.y - viewport!.height / 2)).toBeLessThan(2);
  });

  test("k skips the preceding collapsed deletion and centers the context line", async () => {
    // Given focus on the first added line in reviews.ts

    // When the reader steps up one visible line
    await page!.keyboard.press("k");

    // Then the context line before the deletion is focused and centered
    const focused = page!.locator("[data-biff-focused]");
    expect(await focused.getAttribute("data-line-index")).toBe("1,1");
    const line = await focused.boundingBox();
    const viewport = await page!.locator("main").boundingBox();
    expect(Math.abs(line!.y + line!.height / 2 - viewport!.y - viewport!.height / 2)).toBeLessThan(2);
  });

  test("line navigation skips an entire collapsed deletion block", async () => {
    // Given focus on the context before the second change's deletion block
    await page!.keyboard.press("Shift+J");
    await page!.keyboard.press("k");

    // When the reader steps down one visible line
    await page!.keyboard.press("j");

    // Then focus returns to the addition instead of the hidden second deletion
    expect(await page!.locator("[data-biff-focused]").getAttribute("data-line-index")).toBe("10,7");
  });

  test("hover selection waits the full 250ms", async () => {
    // Given a context line below the current selection
    const target = page!.locator('[data-line][data-line-index="5,4"]');

    // When the pointer rests there for only 249ms
    await target.hover();
    await page!.clock.runFor(249);

    // Then the previous line remains selected
    expect(await page!.locator("[data-biff-focused]").getAttribute("data-line-index")).toBe("3,2");
  });

  test("a deliberate hover selects the line without scrolling", async () => {
    // Given a context line below the current selection
    const target = page!.locator('[data-line][data-line-index="5,4"]');
    const before = await page!.locator("main").evaluate((element) => element.scrollTop);

    // When the pointer rests on it for 250ms
    await target.hover();
    await page!.clock.runFor(250);

    // Then that line is selected in place
    expect(await page!.locator("[data-biff-focused]").getAttribute("data-line-index")).toBe("5,4");
    expect(await page!.locator("main").evaluate((element) => element.scrollTop)).toBe(before);
  });

  test("moving away cancels pending line selection", async () => {
    // Given a pending hover on another line
    await page!.locator('[data-line][data-line-index="5,4"]').hover();
    await page!.clock.runFor(200);

    // When the pointer leaves before the delay completes
    await page!.mouse.move(0, 0);
    await page!.clock.runFor(100);

    // Then the old selection remains
    expect(await page!.locator("[data-biff-focused]").getAttribute("data-line-index")).toBe("3,2");
  });

  test("keyboard navigation continues from a line selected via its gutter", async () => {
    // Given a line selected by hovering its line number
    await page!.locator('[data-gutter] [data-line-index="5,4"]').hover();
    await page!.clock.runFor(250);

    // When the reader steps down with j
    await page!.keyboard.press("j");

    // Then navigation continues from the hovered line
    expect(await page!.locator("[data-biff-focused]").getAttribute("data-line-index")).toBe("6,5");
  });

  test("a pending hover cannot steal selection after keyboard navigation", async () => {
    // Given a pending hover on a context line
    await page!.locator('[data-line][data-line-index="5,4"]').hover();
    await page!.clock.runFor(200);

    // When the reader navigates before the hover delay completes
    await page!.keyboard.press("j");
    await page!.clock.runFor(100);

    // Then the keyboard-selected line stays selected
    expect(await page!.locator("[data-biff-focused]").getAttribute("data-line-index")).toBe("4,3");
  });

  test("selecting a hovered deletion keeps its block expanded", async () => {
    // Given a two-line deletion block
    const rows = page!.locator('[data-line][data-biff-group="1"]');

    // When the pointer stays long enough to expand and select its first line
    await rows.first().hover();
    await page!.clock.runFor(250);

    // Then selection preserves the expanded code under the mouse
    expect(await page!.locator("[data-biff-focused]").getAttribute("data-line-index")).toBe("8,7");
    expect(await rowHeights(rows)).toEqual([35, 35]);
  });

  test("tapping d leaves nearby deleted blocks open", async () => {
    // Given collapsed deletions around the selected line
    const rows = page!.locator('[data-line][data-line-type="change-deletion"]');

    // When d is tapped and released
    await page!.keyboard.press("d");

    // Then nearby deletions remain readable after release
    expect(await rowHeights(rows)).toEqual([35, 35, 35, 35]);
  });

  test("tapping d again closes the toggled blocks", async () => {
    // Given deletions latched open by a tap
    await page!.keyboard.press("d");

    // When d is tapped again
    await page!.keyboard.press("d");

    // Then the deleted blocks return to thin strips
    expect(await rowHeights(page!.locator('[data-line][data-line-type="change-deletion"]'))).toEqual([10, 10, 0, 10]);
  });

  test("holding Shift+D reveals deletions immediately", async () => {
    // Given collapsed deletions
    // When the reader presses and holds Shift+D
    await page!.keyboard.down("Shift");
    await page!.keyboard.down("D");
    await page!.clock.runFor(300);

    // Then nearby old code is readable during the hold
    expect(await rowHeights(page!.locator('[data-line][data-line-type="change-deletion"]'))).toEqual([35, 35, 35, 35]);
  });

  test("releasing Shift+D restores collapsed deletions", async () => {
    // Given a temporary Shift+D peek
    await page!.keyboard.down("Shift");
    await page!.keyboard.down("D");
    await page!.clock.runFor(300);

    // When the reader releases D
    await page!.keyboard.up("D");

    // Then the original collapsed state returns
    expect(await rowHeights(page!.locator('[data-line][data-line-type="change-deletion"]'))).toEqual([10, 10, 0, 10]);
  });

  test("holding Shift+D preserves a previously latched-open state", async () => {
    // Given deletions already latched open
    await page!.keyboard.press("d");

    // When the reader holds Shift+D and releases it
    await page!.keyboard.down("Shift");
    await page!.keyboard.down("D");
    await page!.clock.runFor(300);
    await page!.keyboard.up("D");

    // Then the toggle remains open
    expect(await rowHeights(page!.locator('[data-line][data-line-type="change-deletion"]'))).toEqual([35, 35, 35, 35]);
  });

  test("losing window focus cancels a temporary deletion peek", async () => {
    // Given a held deletion peek
    await page!.keyboard.down("Shift");
    await page!.keyboard.down("D");
    await page!.clock.runFor(300);

    // When the window loses focus before keyup
    await page!.evaluate(() => window.dispatchEvent(new Event("blur")));

    // Then temporary deletions close
    expect(await rowHeights(page!.locator('[data-line][data-line-type="change-deletion"]'))).toEqual([10, 10, 0, 10]);
  });

  test("d reveals only the current block and three blocks on each side", async () => {
    // Given nine deletion blocks separated by unchanged lines
    const body = Array.from({ length: 9 }, (_, index) => `-const old${index} = 0;\n const keep${index} = 1;`).join("\n");
    const patch = `diff --git a/nearby.ts b/nearby.ts\n--- a/nearby.ts\n+++ b/nearby.ts\n@@ -1,18 +1,9 @@\n${body}\n`;
    await page!.locator('input[type="file"]').setInputFiles({ name: "nearby.diff", mimeType: "text/plain", buffer: Buffer.from(patch) });
    // And the middle deletion is selected
    for (let index = 0; index < 4; index++) await page!.keyboard.press("Shift+J");

    // When nearby deletions are toggled open
    await page!.keyboard.press("d");

    // Then the farthest block on each side stays collapsed
    expect(await rowHeights(page!.locator('[data-line][data-line-type="change-deletion"]'))).toEqual([10, 35, 35, 35, 35, 35, 35, 35, 10]);
  });

  test("changing files clears the deletion toggle and keeps the new selection centered", async () => {
    // Given deletions latched open in reviews.ts
    await page!.keyboard.press("d");

    // When the reader opens the next file
    await page!.keyboard.press("n");
    await page!.locator("[data-biff-focused]").waitFor({ state: "visible" });

    // Then the new file uses collapsed deletions and a centered selection
    expect(await page!.locator("[data-biff-revealed]").count()).toBe(0);
    await browserExpect.poll(async () => {
      const line = await page!.locator("[data-biff-focused]").boundingBox();
      const viewport = await page!.locator("main").boundingBox();
      return line && viewport ? Math.abs(line.y + line.height / 2 - viewport.y - viewport.height / 2) : Infinity;
    }).toBeLessThan(2);
  });

  test("plain d stays toggled regardless of how long it is held", async () => {
    // Given collapsed deletions
    // When plain d is held, including auto-repeat, and released
    await page!.keyboard.down("d");
    await page!.clock.runFor(1000);
    await page!.keyboard.down("d");
    await page!.keyboard.up("d");

    // Then the toggle remains open
    expect(await rowHeights(page!.locator('[data-line][data-line-type="change-deletion"]'))).toEqual([35, 35, 35, 35]);
  });

  test("opening nearby deletions preserves an off-center selected line", async () => {
    // Given the second change with the selection manually scrolled off-center
    await page!.keyboard.press("Shift+J");
    await page!.locator("main").evaluate((element) => { element.scrollTop += 80; });
    const focused = page!.locator("[data-biff-focused]");
    const before = await focused.boundingBox();

    // When deletions above and below it expand
    await page!.keyboard.press("d");

    // Then the selected line stays at exactly the same screen height
    const after = await focused.boundingBox();
    expect(Math.abs(after!.y - before!.y)).toBeLessThan(1);
  });

  test("closing nearby deletions preserves an off-center selected line", async () => {
    // Given expanded deletions around an off-center selected line
    await page!.keyboard.press("Shift+J");
    await page!.keyboard.press("d");
    await page!.locator("main").evaluate((element) => { element.scrollTop += 80; });
    const focused = page!.locator("[data-biff-focused]");
    const before = await focused.boundingBox();

    // When the deletions collapse
    await page!.keyboard.press("d");

    // Then the selected line stays at exactly the same screen height
    const after = await focused.boundingBox();
    expect(Math.abs(after!.y - before!.y)).toBeLessThan(1);
  });

  test("hover expansion above the selection keeps that line anchored", async () => {
    // Given focus on the second change
    await page!.keyboard.press("Shift+J");
    const focused = page!.locator("[data-biff-focused]");
    const before = await focused.boundingBox();

    // When the deletion directly above it expands on hover
    await page!.locator('[data-line][data-biff-group="1"]').first().hover();
    await page!.clock.runFor(50);

    // Then only surrounding content moves
    const after = await focused.boundingBox();
    expect(Math.abs(after!.y - before!.y)).toBeLessThan(1);
  });

  test("j skips a collapsed deletion strip when moving forward", async () => {
    // Given focus on the context before the first deletion
    await page!.keyboard.press("k");

    // When the reader moves down one readable line
    await page!.keyboard.press("j");

    // Then focus skips the deletion strip and lands on the added line
    expect(await page!.locator("[data-biff-focused]").getAttribute("data-line-index")).toBe("3,2");
  });

  test("expanded deleted lines remain available to line navigation", async () => {
    // Given deletions expanded using d
    await page!.keyboard.press("d");

    // When the reader moves up from the first addition
    await page!.keyboard.press("k");

    // Then the expanded deleted line is selected
    expect(await page!.locator("[data-biff-focused]").getAttribute("data-line-index")).toBe("2,2");
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
