import { chromium, expect, test, type Browser, type Locator, type Page } from "@playwright/test";
import { createTwoFilesPatch } from "diff";

test.describe("Diff text selection", () => {
  let browser: Browser;
  let page: Page;
  test.beforeAll(async () => { browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium", ignoreDefaultArgs: ["--hide-scrollbars"] }); });
  test.afterAll(async () => { await browser.close(); });
  test.beforeEach(async () => { page = await browser.newPage({ baseURL: process.env.BIFF_TEST_URL || "http://127.0.0.1:5173", viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce", permissions: ["clipboard-read", "clipboard-write"] }); });
  test.afterEach(async () => { await page.close(); });

  test("ordinary partial-row dragging still selects exact text", async () => {
    // Given a stable code row
    await openReview(page, "", "const alpha = omega;\n");
    const row = sourceRow(page, "const alpha = omega;");
    const start = await wordPoint(row, "alpha", "start");
    const end = await wordPoint(row, "omega", "end");
    // When the reader drags from alpha through omega
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(end.x, end.y, { steps: 10 });
    await page.mouse.up();
    // Then browser-native selection retains the intended endpoints
    expect(await selectedText(page)).toEqual("alpha = omega");
  });

  test("hovering a deletion strip during a drag does not replace its anchor", async () => {
    // Given selected text below a collapsed replacement
    await openReview(page, "const removed = 1;\n", "const alpha = omega;\nconst next = 2;\n");
    const row = sourceRow(page, "const alpha = omega;");
    const start = await wordPoint(row, "alpha", "start");
    const end = await wordPoint(row, "omega", "end");
    const retained = await row.elementHandle();
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(end.x, end.y, { steps: 10 });
    // When the held pointer stays on the hover strip beyond its expansion delay
    const strip = await page.locator('[data-content] [data-deletion-fold]').first().boundingBox();
    await page.mouse.move(strip!.x + 100, strip!.y + strip!.height / 2, { steps: 10 });
    await hoverDelay(page);
    await page.mouse.move(end.x, end.y, { steps: 10 });
    await page.mouse.up();
    // Then the original source node survives the entire gesture
    expect(await retained!.evaluate((node) => node.isConnected)).toBe(true);
  });

  test("a deletion hover cannot restart a selection at the fold or file beginning", async () => {
    // Given a partial selection below a deletion strip
    await openReview(page, "const removed = 1;\n", "const alpha = omega;\nconst next = 2;\n");
    const row = sourceRow(page, "const alpha = omega;");
    const start = await wordPoint(row, "alpha", "start");
    const end = await wordPoint(row, "omega", "end");
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(end.x, end.y, { steps: 10 });
    // When the drag crosses the strip and returns
    const strip = await page.locator('[data-content] [data-deletion-fold]').first().boundingBox();
    await page.mouse.move(strip!.x + 100, strip!.y + strip!.height / 2, { steps: 10 });
    await hoverDelay(page);
    await page.mouse.move(end.x, end.y, { steps: 10 });
    await page.mouse.up();
    // Then only the intended source text is selected
    expect(await selectedText(page)).toEqual("alpha = omega");
  });

  test("selected deleted code remains open after the pointer leaves it", async () => {
    // Given a hovered replacement deletion
    await openReview(page, "const removed = 1;\n", "const replacement = 2;\n");
    await page.locator('[data-content] [data-deletion-fold]').first().hover();
    const row = sourceRow(page, "const removed = 1;");
    await row.waitFor();
    const word = await wordPoint(row, "removed");
    await page.mouse.dblclick(word.x, word.y);
    // When the reader moves away from its selected word
    const replacement = await wordPoint(sourceRow(page, "const replacement = 2;"), "replacement");
    await page.mouse.move(replacement.x, replacement.y);
    await hoverDelay(page);
    // Then selection is not destroyed by a hover-driven collapse
    expect(await selectedText(page)).toEqual("removed");
  });

  test("dragging past the virtual window preserves the original text anchor", async () => {
    // Given a thousand-line file and a selection starting near its beginning
    const lines = sourceLines(1000);
    await openReview(page, "", lines.join("\n") + "\n");
    const start = await wordPoint(sourceRow(page, lines[1]), "word1", "start");
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + 40, start.y, { steps: 5 });
    // When scrolling mounts a distant native window during the held gesture
    await page.getByLabel("Diff reading surface", { exact: true }).evaluate((element) => { element.scrollTop = 4000; });
    const distant = sourceRow(page, lines[120]);
    await distant.waitFor();
    const end = await wordPoint(distant, "word120", "end");
    await page.mouse.move(end.x, end.y, { steps: 10 });
    await page.mouse.up();
    // Then the copied browser selection still starts at word1, not the new window
    expect(await selectedText(page)).toEqual([lines[1].slice(6), ...lines.slice(2, 120), "const word120"].join("\n"));
  });

  test("double-click then Shift-click copies complete words on one row", async () => {
    // Given identifiers containing underscores and dollar signs
    await openReview(page, "", "const $alpha_value = omega_value;\n");
    const row = sourceRow(page, "const $alpha_value = omega_value;");
    // When the reader selects the first word and Shift-clicks inside the second
    await selectWords(page, row, "$alpha_value", row, "omega_value");
    // Then neither endpoint is cut at the clicked character
    await expect.poll(() => clipboard(page)).toEqual("$alpha_value = omega_value");
  });

  test("backward word selection copies the same source range", async () => {
    // Given a simple expression
    await openReview(page, "", "const alpha = omega;\n");
    const row = sourceRow(page, "const alpha = omega;");
    // When the final word is selected before Shift-clicking the earlier word
    await selectWords(page, row, "omega", row, "alpha");
    // Then copying uses forward source order
    await expect.poll(() => clipboard(page)).toEqual("alpha = omega");
  });

  test("word copying across a replacement excludes deletion summaries and old code", async () => {
    // Given new-code endpoints separated by a collapsed replacement
    await openReview(page, "const alpha = 1;\n  const removed = 2;\nconst omega = 3;\n", "const alpha = 1;\n  const replacement = 2;\nconst omega = 3;\n");
    // When a new-side range crosses the replacement
    await selectWords(page, sourceRow(page, "const alpha = 1;"), "alpha", sourceRow(page, "const omega = 3;"), "omega");
    // Then only original new-source text, indentation, and line breaks are copied
    await expect.poll(() => clipboard(page)).toEqual("alpha = 1;\n  const replacement = 2;\nconst omega");
  });

  test("word selection survives scrolling to a distant word", async () => {
    // Given a double-clicked anchor near the start of a large diff
    const lines = sourceLines(1000);
    await openReview(page, "", lines.join("\n") + "\n");
    const first = await wordPoint(sourceRow(page, lines[1]), "word1");
    await page.mouse.dblclick(first.x, first.y);
    // When the reader scrolls past overscan and Shift-clicks a distant word
    await page.getByLabel("Diff reading surface", { exact: true }).evaluate((element) => { element.scrollTop = 4000; });
    const last = sourceRow(page, lines[120]);
    await last.waitFor();
    const end = await wordPoint(last, "word120");
    await page.keyboard.down("Shift");
    await page.mouse.click(end.x, end.y);
    await page.keyboard.up("Shift");
    // Then the clipboard includes every source line between both complete words
    await expect.poll(() => clipboard(page)).toEqual([lines[1].slice(6), ...lines.slice(2, 120), "const word120"].join("\n"));
  });

  test("ordinary Shift-click does not unexpectedly overwrite the clipboard", async () => {
    // Given a single-click caret rather than a double-clicked word anchor
    await openReview(page, "", "const alpha = omega;\n");
    await page.evaluate(() => navigator.clipboard.writeText("untouched"));
    const row = sourceRow(page, "const alpha = omega;");
    const first = await wordPoint(row, "alpha");
    const last = await wordPoint(row, "omega");
    await page.mouse.click(first.x, first.y);
    // When the reader extends ordinary browser selection
    await page.keyboard.down("Shift");
    await page.mouse.click(last.x, last.y);
    await page.keyboard.up("Shift");
    // Then auto-copy remains opt-in through double-click
    expect(await clipboard(page)).toEqual("untouched");
  });

  test("Escape clears the word anchor before another Shift-click", async () => {
    // Given a double-clicked word and unrelated clipboard contents
    await openReview(page, "", "const alpha = omega;\n");
    await page.evaluate(() => navigator.clipboard.writeText("untouched"));
    const row = sourceRow(page, "const alpha = omega;");
    const first = await wordPoint(row, "alpha");
    await page.mouse.dblclick(first.x, first.y);
    // When the selection is cleared before a later Shift-click
    await page.keyboard.press("Escape");
    const last = await wordPoint(row, "omega");
    await page.keyboard.down("Shift");
    await page.mouse.click(last.x, last.y);
    await page.keyboard.up("Shift");
    // Then the abandoned word range cannot trigger copying
    expect(await clipboard(page)).toEqual("untouched");
  });

  test("the frozen reference uses the same word-copy shortcut", async () => {
    // Given a frozen copy of the current diff
    await openReview(page, "", "const alpha = omega;\n");
    await page.keyboard.press("f");
    const frozen = page.getByLabel("Frozen diff reading surface", { exact: true });
    const row = frozen.locator("[data-content] > [data-line]").filter({ hasText: "const alpha = omega;" });
    await expect(frozen.locator("[data-biff-pinned]")).toBeInViewport();
    await expect(async () => { await row.scrollIntoViewIfNeeded(); }).toPass();
    // When word-to-word selection happens in the reference pane
    await selectWords(page, row, "alpha", row, "omega");
    // Then copying is independent of the main viewer's selection handlers
    await expect.poll(() => clipboard(page)).toEqual("alpha = omega");
  });

  test("a clipboard failure leaves a working retry instead of reporting Copied", async () => {
    // Given a clipboard write that the browser rejects once
    await openReview(page, "", "const alpha = omega;\n");
    await page.evaluate(() => {
      const write = navigator.clipboard.writeText.bind(navigator.clipboard);
      let fail = true;
      navigator.clipboard.writeText = async (text) => { if (fail) { fail = false; throw new Error("Clipboard unavailable"); } await write(text); };
    });
    const row = sourceRow(page, "const alpha = omega;");
    await selectWords(page, row, "alpha", row, "omega");
    await page.getByRole("button", { name: "Activity: 1 operation needs attention", exact: true }).click();
    // When the reader retries the failed copy
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    // Then the preserved source range reaches the clipboard
    await expect.poll(() => clipboard(page)).toEqual("alpha = omega");
  });

  test("clearing selection restores a bounded virtual window", async () => {
    // Given a retained selection far above the current viewport
    const lines = sourceLines(1000);
    await openReview(page, "", lines.join("\n") + "\n");
    const first = await wordPoint(sourceRow(page, lines[1]), "word1");
    await page.mouse.dblclick(first.x, first.y);
    const viewport = page.getByLabel("Diff reading surface", { exact: true });
    await viewport.evaluate((element) => { element.scrollTop = 15_000; });
    await sourceRow(page, lines[430]).waitFor();
    // When selection is cleared and the window renders again
    await page.keyboard.press("Escape");
    await viewport.evaluate((element) => { element.scrollTop += 100; });
    // Then selection retention does not permanently disable virtualization
    await expect.poll(() => page.locator("[data-content] > [data-line]").count()).toBeLessThan(250);
  });

  test("old-code word selection copies old context after an unequal replacement", async () => {
    // Given old code followed by context whose new line number differs
    await openReview(page, "const removed = 1;\nconst omega = 2;\n", "const first = 1;\nconst second = 2;\nconst omega = 2;\n");
    await page.locator('[data-content] [data-deletion-fold]').first().hover();
    const old = sourceRow(page, "const removed = 1;");
    await old.waitFor();
    // When the range extends from the deletion into unchanged context
    await selectWords(page, old, "removed", sourceRow(page, "const omega = 2;"), "omega");
    // Then additions are not mixed into the old-revision snippet
    await expect.poll(() => clipboard(page)).toEqual("removed = 1;\nconst omega");
  });

  test("native selection changes replace the shortcut's cached word range", async () => {
    // Given a double-clicked word
    await openReview(page, "", "const alpha = omega;\n");
    const first = await wordPoint(sourceRow(page, "const alpha = omega;"), "alpha");
    await page.mouse.dblclick(first.x, first.y);
    // When the browser extends selection beyond that word and the reader copies
    await page.evaluate(() => {
      window.getSelection()!.modify("extend", "forward", "character");
      window.getSelection()!.modify("extend", "forward", "character");
    });
    await page.keyboard.press("Control+c");
    // Then Copy uses the current native selection, not the old word-only cache
    await expect.poll(() => clipboard(page)).toEqual("alpha =");
  });

  test("scrollbar navigation keeps the double-clicked word anchor", async () => {
    // Given an anchored word in a scrollable file
    const lines = sourceLines(40);
    await openReview(page, "", lines.join("\n") + "\n");
    const first = await wordPoint(sourceRow(page, lines[1]), "word1");
    await page.mouse.dblclick(first.x, first.y);
    // When the reader uses the scrollbar before extending to the final word
    const viewport = page.getByLabel("Diff reading surface", { exact: true });
    const bounds = await viewport.boundingBox();
    await page.mouse.click(bounds!.x + bounds!.width - 4, bounds!.y + bounds!.height - 20);
    const last = sourceRow(page, lines[39]);
    await last.scrollIntoViewIfNeeded();
    const end = await wordPoint(last, "word39");
    await page.keyboard.down("Shift");
    await page.mouse.click(end.x, end.y);
    await page.keyboard.up("Shift");
    // Then scrolling does not silently downgrade the shortcut to ordinary Shift-click
    await expect.poll(() => clipboard(page)).toEqual([lines[1].slice(6), ...lines.slice(2, 39), "const word39"].join("\n"));
  });
});

/** Exercise real rendering and source metadata without touching the live review database. */
async function openReview(page: Page, oldSource: string, newSource: string) {
  const patch = createTwoFilesPatch("file.ts", "file.ts", oldSource, newSource);
  const workspace = { id: "fixture", name: "fixture", path: "/fixture" };
  const revision = { commit_id: "a".repeat(40), change_id: "qwerty", description: "Text selection fixture" };
  await page.route("**/api/**", (route) => route.fulfill({ json: route.request().url().includes("/review?") ? { workspace, selected: revision, revisions: [revision], patch } : [] }));
  await page.goto("/workspaces/fixture");
  await page.locator("[data-biff-focused]").waitFor();
  await page.evaluate(() => document.fonts.ready);
  await expect(async () => { await page.locator("[data-biff-focused]").scrollIntoViewIfNeeded(); }).toPass();
}

/** Keep test coordinates on source text rather than gutter or review controls. */
function sourceRow(page: Page, text: string): Locator {
  return page.locator("[data-content] > [data-line]").filter({ hasText: text });
}

/** Locate actual glyph bounds after fonts and viewport positioning have settled. */
async function wordPoint(row: Locator, word: string, edge: "start" | "end" | "middle" = "middle") {
  return row.evaluate((element, options) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const start = node.textContent!.indexOf(options.word);
      if (start < 0) continue;
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, start + options.word.length);
      const bounds = range.getBoundingClientRect();
      return { x: options.edge === "start" ? bounds.left + 1 : options.edge === "end" ? bounds.right - 1 : bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
    }
    throw new Error(`Missing word ${options.word}`);
  }, { word, edge });
}

/** Use real browser events so native selection and clipboard activation both participate. */
async function selectWords(page: Page, first: Locator, anchor: string, last: Locator, target: string) {
  const start = await wordPoint(first, anchor);
  await page.mouse.dblclick(start.x, start.y);
  const end = await wordPoint(last, target);
  await page.keyboard.down("Shift");
  await page.mouse.click(end.x, end.y);
  await page.keyboard.up("Shift");
}

/** Read native selection, not application-owned state. */
async function selectedText(page: Page): Promise<string> { return page.evaluate(() => window.getSelection()!.toString()); }

/** Inspect the real browser clipboard after acknowledged writes. */
async function clipboard(page: Page): Promise<string> { return page.evaluate(() => navigator.clipboard.readText()); }

/** Include the actual hover timer rather than asserting before it could have fired. */
async function hoverDelay(page: Page) { await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 120))); }

/** Enough source to force window replacement while remaining easy to inspect. */
function sourceLines(count: number): string[] { return Array.from({ length: count }, (_, index) => `const word${index} = "alpha beta gamma delta";`); }
