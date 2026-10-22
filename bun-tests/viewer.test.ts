import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { chromium, expect as browserExpect, type Browser, type Locator, type Page } from "@playwright/test";

describe("viewer", () => {
  let server: ReturnType<typeof Bun.spawn>;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let patch: string;
  const url = "http://127.0.0.1:5174";

  beforeAll(async () => {
    patch = await Bun.file(new URL("../fixtures/demo.diff", import.meta.url)).text();
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
    await openFixtureReview(page, patch);
    // Wait for syntax highlighting as well as the post-render deletion grouping.
    await page.locator('[data-line][data-biff-start] span[style*="color"]').first().waitFor({ state: "attached" });
    // Font swaps resize the viewport; allow its layout observers to run before freezing browser time.
    await page.evaluate(async () => { await document.fonts.ready; await new Promise(requestAnimationFrame); });
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

  test("Settings can keep all deleted lines expanded", async () => {
    // Given collapsed deleted lines
    const deletions = page!.locator('[data-line][data-line-type="change-deletion"]');

    // When the reader disables collapsing
    await page!.getByRole("button", { name: "Settings", exact: true }).click();
    await page!.getByLabel("Collapse deleted lines").uncheck();
    await page!.keyboard.press("Escape");

    // Then every deleted row is readable without hovering
    expect(await rowHeights(deletions)).toEqual([35, 35, 35, 35]);
  });

  test("n scrolls to the next change within the same file", async () => {
    // Given the demo's first change, inside a patch hunk containing three edits

    // When the reader moves forward one hunk
    await page!.keyboard.press("n");

    // Then the second change in reviews.ts is selected and visually centered
    expect(await page!.getByLabel("Current file").textContent()).toBe("reviews.ts");
    const hunk = page!.locator('[data-line][data-biff-focused]');
    await hunk.waitFor({ state: "attached" });
    const viewport = await page!.locator("main").boundingBox();
    const bounds = await hunk.boundingBox();
    expect(await hunk.getAttribute("data-line-index")).toBe("10,7");
    expect(Math.abs(bounds!.y + bounds!.height / 2 - viewport!.y - viewport!.height / 2)).toBeLessThan(2);
  });

  test("n crosses the last change into the next file", async () => {
    // Given the demo's first file at its third and final change
    await page!.keyboard.press("n");
    await page!.keyboard.press("n");

    // When the reader advances again
    await page!.keyboard.press("n");

    // Then the next file opens at its first hunk
    expect(await page!.getByLabel("Current file").textContent()).toBe("review.graphql");
    await browserExpect(page!.locator("[data-biff-focused]")).toHaveText("status: ReviewStatus!");
  });

  test("p crosses the first change into the previous file's last change", async () => {
    // Given the demo's second file at its first change
    await page!.keyboard.press("l");

    // When the reader moves backward one hunk
    await page!.keyboard.press("p");

    // Then the previous file opens at its last hunk
    expect(await page!.getByLabel("Current file").textContent()).toBe("reviews.ts");
    await browserExpect(page!.locator("[data-biff-focused]")).toHaveText("const fileCount = review.files.length;");
  });

  test("l skips remaining hunks and opens the next file", async () => {
    // Given the demo's first file still at its first change

    // When the reader requests the next file
    await page!.keyboard.press("l");

    // Then the next file opens at its first hunk
    expect(await page!.getByLabel("Current file").textContent()).toBe("review.graphql");
    await browserExpect(page!.locator("[data-biff-focused]")).toHaveText("status: ReviewStatus!");
  });

  test("h opens the previous file at its first hunk", async () => {
    // Given the demo's second file
    await page!.keyboard.press("l");

    // When the reader requests the previous file
    await page!.keyboard.press("h");

    // Then the previous file opens at its first hunk
    expect(await page!.getByLabel("Current file").textContent()).toBe("reviews.ts");
    await browserExpect(page!.locator("[data-biff-focused]")).toHaveText("const PAGE_SIZE = 50;");
  });

  test("p centers the first change even near the beginning of a file", async () => {
    // Given the second change in reviews.ts
    await page!.keyboard.press("n");

    // When the reader navigates backward
    await page!.keyboard.press("p");

    // Then the first added line is centered, not clamped to the viewport top
    const line = await page!.locator("[data-biff-focused]").boundingBox();
    const viewport = await page!.locator("main").boundingBox();
    expect(Math.abs(line!.y + line!.height / 2 - viewport!.y - viewport!.height / 2)).toBeLessThan(2);
  });

  test("the last change can be centered near the end of a file", async () => {
    // Given the second change in reviews.ts
    await page!.keyboard.press("n");

    // When the reader navigates to its final change
    await page!.keyboard.press("n");

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
    await page!.keyboard.press("n");
    await page!.keyboard.press("k");

    // When the reader steps down one visible line
    await page!.keyboard.press("j");

    // Then focus returns to the addition instead of the hidden second deletion
    expect(await page!.locator("[data-biff-focused]").getAttribute("data-line-index")).toBe("10,7");
  });

  test("resting the pointer over a line never selects it", async () => {
    // Given a context line below the current selection
    const target = page!.locator('[data-line][data-line-index="5,4"]');

    // When the pointer rests there longer than the former hover delay
    await target.hover();
    await page!.clock.runFor(1000);

    // Then the previous line remains selected
    expect(await page!.locator("[data-biff-focused]").getAttribute("data-line-index")).toBe("3,2");
  });

  test("clicking a line selects it without scrolling", async () => {
    // Given a context line below the current selection
    const target = page!.locator('[data-line][data-line-index="5,4"]');
    const before = await page!.locator("main").evaluate((element) => element.scrollTop);

    // When the reader clicks the line
    await target.click();

    // Then that line is selected in place
    expect(await page!.locator("[data-biff-focused]").getAttribute("data-line-index")).toBe("5,4");
    expect(await page!.locator("main").evaluate((element) => element.scrollTop)).toBe(before);
  });

  test("moving across lines leaves selection alone", async () => {
    // Given the pointer over another line
    await page!.locator('[data-line][data-line-index="5,4"]').hover();
    await page!.clock.runFor(200);

    // When the pointer moves away
    await page!.mouse.move(0, 0);
    await page!.clock.runFor(100);

    // Then the old selection remains
    expect(await page!.locator("[data-biff-focused]").getAttribute("data-line-index")).toBe("3,2");
  });

  test("keyboard navigation continues from a line selected via its gutter", async () => {
    // Given a line selected by clicking its line number
    await page!.locator('[data-gutter] [data-line-index="5,4"]').click();

    // When the reader steps down with j
    await page!.keyboard.press("j");

    // Then navigation continues from the clicked line
    expect(await page!.locator("[data-biff-focused]").getAttribute("data-line-index")).toBe("6,5");
  });

  test("the pointer cannot steal selection after keyboard navigation", async () => {
    // Given the pointer resting on a context line
    await page!.locator('[data-line][data-line-index="5,4"]').hover();
    await page!.clock.runFor(200);

    // When the reader navigates using the keyboard
    await page!.keyboard.press("j");
    await page!.clock.runFor(100);

    // Then the keyboard-selected line stays selected
    expect(await page!.locator("[data-biff-focused]").getAttribute("data-line-index")).toBe("4,3");
  });

  test("selecting a hovered deletion keeps its block expanded", async () => {
    // Given a two-line deletion block
    const rows = page!.locator('[data-line][data-biff-group="1"]');

    // When the pointer expands the block and the reader clicks its first line
    await rows.first().hover();
    await page!.clock.runFor(50);
    await rows.first().click();

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
    // Native virtual rendering is frame-driven, including the first mounted window.
    await page!.clock.resume();
    await openFixtureReview(page!, patch);
    // And the middle deletion is selected
    for (let index = 0; index < 4; index++) await page!.keyboard.press("n");

    // When nearby deletions are toggled open
    await page!.keyboard.press("d");

    // Then the farthest block on each side stays collapsed
    expect(await rowHeights(page!.locator('[data-line][data-line-type="change-deletion"]'))).toEqual([10, 35, 35, 35, 35, 35, 35, 35, 10]);
  });

  test("changing files clears the deletion toggle and opens code near the picker", async () => {
    // Given deletions latched open in reviews.ts
    await page!.keyboard.press("d");

    // When the reader opens the next file
    await page!.keyboard.press("l");
    await page!.locator("[data-biff-focused]").waitFor({ state: "visible" });

    // Then the new file uses collapsed deletions and starts near the picker
    expect(await page!.locator("[data-biff-revealed]").count()).toBe(0);
    await browserExpect.poll(async () => {
      const code = await page!.locator("diffs-container").boundingBox();
      const viewport = await page!.locator("main").boundingBox();
      return code && viewport ? Math.abs(code.y - viewport.y - 8) : Infinity;
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
    await page!.keyboard.press("n");
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
    await page!.keyboard.press("n");
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
    await page!.keyboard.press("n");
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

  test("u reveals nearby unmodified lines without opening deletions", async () => {
    // Given collapsed context around the first change
    await openLongContext(page!);
    await page!.locator("main").focus();
    await page!.mouse.move(0, 0);

    // When context is toggled open
    await page!.keyboard.press("u");

    // Then context is readable while deleted blocks stay collapsed
    await browserExpect(page!.locator('[data-line]').filter({ hasText: "context 20" })).toBeVisible();
    expect(await rowHeights(page!.locator('[data-line][data-biff-group="1"]'))).toEqual([10]);
  });

  test("Shift+U restores collapsed context when released", async () => {
    // Given collapsed unmodified lines
    await openLongContext(page!);
    await page!.locator("main").focus();
    await page!.mouse.move(0, 0);

    // When a temporary peek ends
    await page!.keyboard.down("Shift");
    await page!.keyboard.down("U");
    await page!.keyboard.up("U");
    await page!.keyboard.up("Shift");

    // Then the omitted middle context is hidden again, while surrounding context stays visible
    await browserExpect(page!.locator('[data-line]').filter({ hasText: "context 20" })).toHaveCount(0);
    await browserExpect.poll(() => rowHeights(page!.locator('[data-line][data-line-type="context"]').first())).toEqual([35]);
  });

  test("u preserves the selected line's screen position", async () => {
    // Given collapsed context and an off-center selected change
    await openLongContext(page!);
    await page!.locator("main").focus();
    await page!.mouse.move(0, 0);
    await page!.keyboard.press("n");
    await page!.locator("main").evaluate((element) => { element.scrollTop += 40; });
    const focused = page!.locator("[data-biff-focused]");
    const before = await focused.boundingBox();

    // When nearby context expands
    await page!.keyboard.press("u");
    await browserExpect(page!.locator('[data-line]').filter({ hasText: "context 20" })).toBeVisible();

    // Then selection stays anchored, allowing one pixel of browser scroll rounding
    expect(Math.abs((await focused.boundingBox())!.y - before!.y)).toBeLessThanOrEqual(1);
  });

  test("holding Shift+U reveals context immediately", async () => {
    // Given collapsed unmodified lines
    await openLongContext(page!);
    await page!.locator("main").focus();
    await page!.mouse.move(0, 0);

    // When the reader holds Shift+U
    await page!.keyboard.down("Shift");
    await page!.keyboard.down("U");

    // Then the previously omitted middle context is readable
    await browserExpect(page!.locator('[data-line]').filter({ hasText: "context 20" })).toBeVisible();
  });

  test("u toggles expanded context closed again", async () => {
    // Given context expanded with u
    await openLongContext(page!);
    await page!.locator("main").focus();
    await page!.mouse.move(0, 0);
    await page!.keyboard.press("u");

    // When u is pressed again
    await page!.keyboard.press("u");

    // Then only the middle context returns to its native collapsed section
    await browserExpect(page!.locator('[data-line]').filter({ hasText: "context 20" })).toHaveCount(0);
  });

  test("dragging to select text does not move the review cursor", async () => {
    // Given a context row away from the selected addition
    const target = await page!.locator('[data-line][data-line-index="5,4"]').boundingBox();

    // When the reader drags across its text
    await page!.mouse.move(target!.x + 15, target!.y + 15);
    await page!.mouse.down();
    await page!.mouse.move(target!.x + 140, target!.y + 15, { steps: 5 });
    await page!.mouse.up();

    // Then the original review line stays selected
    expect(await page!.locator("[data-biff-focused]").getAttribute("data-line-index")).toBe("3,2");
  });

  test("clicking expanded deleted code keeps its screen position", async () => {
    // Given a deletion expanded under the pointer
    const row = page!.locator('[data-line][data-biff-group="1"]').first();
    await row.hover();
    await page!.clock.runFor(50);
    const before = await row.boundingBox();

    // When the reader selects it
    await row.click();

    // Then selecting it does not collapse and reopen the surrounding layout
    expect(Math.abs((await row.boundingBox())!.y - before!.y)).toBeLessThan(1);
  });

  test("the first u keeps the clicked line selected after context loads", async () => {
    // Given a selected context line after an omitted section
    await openLongContext(page!);
    await page!.locator('[data-line]').filter({ hasText: "context 39" }).click();

    // When the first expansion loads full file contents and renumbers renderer rows
    await page!.keyboard.press("u");
    await browserExpect(page!.locator('[data-line]').filter({ hasText: "context 20" })).toBeVisible();

    // Then the clicked file line remains selected
    await browserExpect(page!.locator("[data-biff-focused]")).toHaveText("context 39");
  });

  test("a newly loaded review starts its code directly below the file picker", async () => {
    // Given a newly loaded working-copy review
    // When its first file finishes rendering
    const code = await page!.locator("diffs-container").boundingBox();
    const viewport = await page!.locator("main").boundingBox();

    // Then only a small reading margin separates the viewport and code
    expect(Math.abs(code!.y - viewport!.y - 8)).toBeLessThan(1);
  });

  test("repeated j presses keep scrolling forward without restarting the animation", async () => {
    // Given a line at the lower edge of the follow region with motion enabled
    await openScrollingReview(page!);
    const samples = [await page!.locator("main").evaluate((element) => element.scrollTop)];

    // When the reader keeps retargeting before the animation can finish
    for (let repeat = 0; repeat < 8; repeat++) {
      await page!.keyboard.press("j");
      await page!.clock.runFor(32);
      samples.push(await page!.locator("main").evaluate((element) => element.scrollTop));
    }

    // Then repeats continue moving after the initial frame, whose sub-pixel
    // movement can round to zero in scrollTop.
    expect(samples.slice(2).every((top, index) => top > samples[index + 1]), JSON.stringify(samples)).toBe(true);
  });

  test("smooth navigation settles on the latest line after reversing direction", async () => {
    // Given several downward steps still animating
    await openScrollingReview(page!);
    for (let repeat = 0; repeat < 8; repeat++) {
      await page!.keyboard.press("j");
      await page!.clock.runFor(16);
    }

    // When the reader reverses and releases the keys
    for (let repeat = 0; repeat < 3; repeat++) {
      await page!.keyboard.press("k");
      await page!.clock.runFor(16);
    }
    await page!.clock.runFor(1200);
    const focused = await page!.locator("[data-biff-focused]").boundingBox();
    const viewport = await page!.locator("main").boundingBox();

    // Then the final line stays near the middle without being forced to its exact center
    expect(Math.abs(focused!.y + focused!.height / 2 - viewport!.y - viewport!.height / 2)).toBeLessThanOrEqual(viewport!.height * 0.1 + 1);
  });

  test("manual scrolling cancels an unfinished keyboard animation", async () => {
    // Given a keyboard animation in flight
    await openScrollingReview(page!);
    await page!.keyboard.press("j");
    await page!.clock.runFor(16);

    // When wheel input takes over the reading position
    await page!.locator("main").dispatchEvent("wheel", { deltaY: 80 });
    const manual = await page!.locator("main").evaluate((element) => { element.scrollTop += 80; return element.scrollTop; });
    await page!.clock.runFor(500);

    // Then the old keyboard target no longer pulls the viewport back
    expect(await page!.locator("main").evaluate((element) => element.scrollTop)).toBe(manual);
  });

  test("small selection movements near the middle leave the text at rest", async () => {
    // Given a centered line with motion enabled
    await openScrollingReview(page!);
    const before = await page!.locator("main").evaluate((element) => { element.scrollTop += element.clientHeight * 0.1; return element.scrollTop; });

    // When the reader takes one step within the comfortable reading region
    await page!.keyboard.press("j");
    await page!.clock.runFor(1200);

    // Then the viewport does not recenter that small movement
    expect(await page!.locator("main").evaluate((element) => element.scrollTop)).toBe(before);
  });

  test("a single step beyond the follow region eases in gradually", async () => {
    // Given a line at the lower edge of the follow region
    await openScrollingReview(page!);
    const before = await page!.locator("main").evaluate((element) => element.scrollTop);

    // When the reader takes one step and the first 96ms elapse
    await page!.keyboard.press("j");
    await page!.clock.runFor(96);

    // Then most of the line's movement is still ahead, rather than snapping into place
    expect((await page!.locator("main").evaluate((element) => element.scrollTop)) - before).toBeLessThan(12);
  });

  test("holding j rebuilds code only at native window boundaries", async () => {
    // Given a highlighted file whose code content is being observed for replacement
    await openScrollingReview(page!);
    await page!.locator('[data-line] span[style*="color"]').first().waitFor();
    const mutations = await page!.evaluateHandle(() => {
      let changes = 0;
      const observer = new MutationObserver((records) => { if (records.some((record) => record.type === "childList" && record.target instanceof Element && record.target.hasAttribute("data-content"))) changes++; });
      observer.observe(document.querySelector("diffs-container")!.shadowRoot!, { childList: true, characterData: true, subtree: true });
      return { stop() { observer.disconnect(); return changes; } };
    });

    // When the cursor advances repeatedly through the same rendered file
    for (let repeat = 0; repeat < 20; repeat++) {
      await page!.keyboard.press("j");
      await page!.clock.runFor(32);
    }

    // Then twenty cursor steps require at most two native window replacements
    expect(await mutations.evaluate((tracker) => tracker.stop())).toBeLessThanOrEqual(2);
    await mutations.dispose();
  });
});

/** Start at the lower follow boundary so animation tests do not depend on the file-load position. */
async function openScrollingReview(page: Page) {
  const lines = Array.from({ length: 100 }, (_, index) => `+const value${index} = ${index};`).join("\n");
  await page.clock.resume();
  await openFixtureReview(page, `diff --git a/long.ts b/long.ts\nnew file mode 100644\n--- /dev/null\n+++ b/long.ts\n@@ -0,0 +1,100 @@\n${lines}\n`);
  await page.locator("[data-biff-focused]").waitFor();
  await page.evaluate(async () => { await document.fonts.ready; await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); });
  await page.locator("main").focus();
  for (let step = 0; step < 10; step++) await page.keyboard.press("j");
  await page.locator("main").evaluate((element) => { element.scrollTop -= element.clientHeight * 0.1; });
  await page.evaluate(async () => { await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
}

/** Open supplied patch data through the working-copy API rather than demo controls. */
async function openFixtureReview(page: Page, patch: string) {
  const workspace = { id: "fixture", name: "fixture", path: "/fixture" };
  const revision = { commit_id: "a".repeat(40), change_id: "qwerty", description: "Viewer fixture" };
  await page.route("**/api/**", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(
    route.request().url().includes("/review?") ? { workspace, selected: revision, revisions: [revision], patch }
      : new URL(route.request().url()).pathname === "/api/workspaces" ? [workspace] : [],
  ) }));
  await page.goto("http://127.0.0.1:5174/workspaces/fixture");
  await page.locator("[data-biff-focused]").waitFor();
}

/** Supply enough unchanged context for Pierre's native unmodified-lines section. */
async function openLongContext(page: Page) {
  // Let the native virtualizer mount its first window before freezing animation time.
  await page.clock.resume();
  const context = Array.from({ length: 40 }, (_, index) => `context ${index}\n`).join("");
  const patch = "diff --git a/context.txt b/context.txt\n--- a/context.txt\n+++ b/context.txt\n@@ -1,2 +1,2 @@\n-old first\n+new first\n context 0\n@@ -41,2 +41,2 @@\n context 39\n-old last\n+new last\n";
  const workspace = { id: "context", name: "context", path: "/context" };
  const revision = { commit_id: "a".repeat(40), change_id: "qwerty", description: "Context fixture" };
  await page.route("**/api/**", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(
    route.request().url().endsWith("/contents")
      ? { oldFile: { name: "context.txt", contents: `old first\n${context}old last\n` }, newFile: { name: "context.txt", contents: `new first\n${context}new last\n` } }
      : route.request().url().includes("/review?") ? { workspace, selected: revision, revisions: [revision], patch }
        : new URL(route.request().url()).pathname === "/api/workspaces" ? [workspace] : [],
  ) }));
  await page.goto("http://127.0.0.1:5174/workspaces/context");
  await browserExpect(page.locator('[data-line]').filter({ hasText: "new first" })).toBeVisible();
  await browserExpect(page.locator('[data-line]').filter({ hasText: "context 20" })).toHaveCount(0);
}

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
