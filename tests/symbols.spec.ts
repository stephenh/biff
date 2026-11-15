import { chromium, expect, test, type Browser, type Locator, type Page } from "@playwright/test";
import { createTwoFilesPatch } from "diff";
import type { ReviewSymbol, SymbolIndex } from "../shared/symbols";

test.describe("Review symbols", () => {
  let browser: Browser;
  let page: Page;
  let hold: Promise<void> | undefined;
  let started: ReturnType<typeof Promise.withResolvers<void>>;
  let paintedAtRequest: boolean;
  let ambiguous: boolean;
  let failed: boolean;
  let progressive: boolean;
  let advanced: boolean;
  const head = "a".repeat(40);
  const base = "b".repeat(40);
  const reviewId = "c".repeat(64);
  const oldMain = "saveReview(); // previous call\n// saveReview helps reviewers.\nconst example = \"saveReview\";\n";
  const newMain = "saveReview(); // current call\n// saveReview helps reviewers.\nconst example = \"saveReview\";\n";
  const oldDefinitions = ['const label = "before";', ...Array.from({ length: 43 }, (_, index) => `// context ${index}`), "export function saveReview() {}", ""].join("\n");
  const newDefinitions = ['const label = "after";', "", ...Array.from({ length: 43 }, (_, index) => `// context ${index}`), "export function saveReview() {}", ""].join("\n");
  const declarations: ReviewSymbol[] = [
    { name: "saveReview", kind: "function", path: "definitions.ts", side: "RIGHT", line: 46 },
    { name: "saveReview", kind: "function", path: "definitions.ts", side: "LEFT", line: 45 },
  ];

  test.beforeAll(async () => { browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium" }); });
  test.afterAll(async () => { await browser.close(); });
  test.afterEach(async () => { await page.close(); });
  test.beforeEach(async () => {
    page = await browser.newPage({ baseURL: "http://127.0.0.1:5173", viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
    hold = undefined;
    ambiguous = false;
    failed = false;
    progressive = false;
    advanced = false;
    paintedAtRequest = false;
    started = Promise.withResolvers<void>();
    await page.route("**/api/**", async (route) => {
      const url = new URL(route.request().url());
      const path = url.pathname;
      const main = ambiguous ? `${newMain}function saveReview() {}\n` : newMain;
      if (path.endsWith("/symbols")) {
        paintedAtRequest = await page.locator('[data-content] > [data-line]').filter({ hasText: "current call" }).isVisible();
        started.resolve();
        await hold;
        if (failed) return route.fulfill({ json: { symbols: [], completed: 1, total: 2, state: "failed", errors: ["Source unavailable"] } satisfies SymbolIndex });
        const symbols = [...declarations, ...(ambiguous ? [{ name: "saveReview", kind: "function", path: "main.ts", side: "RIGHT" as const, line: 4 }] : []),
          ...(advanced ? [{ name: "example", kind: "constant", path: "main.ts", side: "RIGHT" as const, line: 3 }] : [])];
        return route.fulfill({ json: { symbols, completed: progressive && !advanced ? 1 : 2, total: 2, state: progressive && !advanced ? "indexing" : "complete", errors: [] } satisfies SymbolIndex });
      }
      if (path.endsWith("/contents")) {
        const file = route.request().postDataJSON().path;
        return route.fulfill({ json: file === "main.ts"
          ? { oldFile: { name: file, contents: oldMain }, newFile: { name: file, contents: main } }
          : { oldFile: { name: file, contents: oldDefinitions }, newFile: { name: file, contents: newDefinitions } } });
      }
      if (path.endsWith("/discussion")) return route.fulfill({ json: { identity: { id: reviewId }, threads: [], commentReads: [] } });
      if (path.endsWith("/identity")) return route.fulfill({ json: { id: reviewId, closed: false } });
      if (path.endsWith("/review")) {
        const revision = { commit_id: head, change_id: "k".repeat(32), description: "Symbol fixture" };
        const patch = createTwoFilesPatch("main.ts", "main.ts", oldMain, main, "", "", { context: 2 })
          + createTwoFilesPatch("definitions.ts", "definitions.ts", oldDefinitions, newDefinitions, "", "", { context: 2 });
        return route.fulfill({ json: { workspace: { id: "fixture", name: "fixture", path: "/fixture" }, selected: revision,
          base: { ...revision, commit_id: base }, revisions: [revision], patch, changes: "all", identity: { id: reviewId, closed: false }, progressScope: reviewId } });
      }
      return route.fulfill({ json: [] });
    });
  });

  test("paints the first diff before starting symbol work", async () => {
    // Given a symbol request held indefinitely
    const latch = Promise.withResolvers<void>();
    hold = latch.promise;
    try {
      // When the review opens and background indexing starts
      await page.goto("/workspaces/fixture");
      await started.promise;
      // Then the initial source was already visible at admission
      expect(paintedAtRequest).toEqual(true);
    } finally { latch.resolve(); }
  });

  test("file navigation works while symbol indexing is held", async () => {
    // Given a visible review with an unfinished symbol request
    const latch = Promise.withResolvers<void>();
    hold = latch.promise;
    await page.goto("/workspaces/fixture");
    await started.promise;
    try {
      // When the reader moves to another file
      await page.keyboard.press("l");
      // Then source navigation finishes without waiting for indexing
      await expect(page.getByLabel("Current file")).toHaveAttribute("title", "definitions.ts");
    } finally { latch.resolve(); }
  });

  test("Ctrl+O can open while declarations are still indexing", async () => {
    // Given a held background index
    const latch = Promise.withResolvers<void>();
    hold = latch.promise;
    await page.goto("/workspaces/fixture");
    await started.promise;
    try {
      // When the reader opens symbol search
      await page.keyboard.press("Control+o");
      // Then the picker describes pending work instead of claiming no symbols exist
      await expect(page.getByRole("dialog", { name: "Find symbol", exact: true }).getByText("Indexing declarations…")).toBeVisible();
    } finally { latch.resolve(); }
  });

  test("Ctrl+O fuzzy search reveals a declaration outside diff context", async () => {
    // Given a loaded declaration outside the changed hunks
    await openSymbols(page);
    // When a fuzzy name is accepted
    await page.getByRole("combobox", { name: "Search symbols" }).fill("svRv");
    await page.getByRole("listbox", { name: "Symbols in this review" }).getByRole("option").click();
    // Then navigation expands the exact full-source line
    await expect(page.locator("[data-biff-focused]")).toHaveText("export function saveReview() {}");
  });

  test("Ctrl-click follows a function name mentioned in a comment", async () => {
    // Given an indexed comment mentioning a declaration in another file
    await openSymbols(page);
    await page.keyboard.press("Escape");
    // When the whole identifier is Ctrl-clicked
    await clickWord(page, page.locator('[data-content] > [data-line]').filter({ hasText: "// saveReview helps" }), "saveReview");
    // Then its declaration becomes the focused source line
    await expect(page.locator("[data-biff-focused]")).toHaveText("export function saveReview() {}");
  });

  test("Ctrl-click follows names inside strings", async () => {
    // Given an indexed identifier inside a string
    await openSymbols(page);
    await page.keyboard.press("Escape");
    // When its name is Ctrl-clicked
    await clickWord(page, page.locator('[data-content] > [data-line]').filter({ hasText: 'const example = "saveReview"' }), "saveReview");
    // Then the matching declaration opens
    await expect(page.getByLabel("Current file")).toHaveAttribute("title", "definitions.ts");
  });

  test("holding Control highlights known names", async () => {
    // Given indexed source text
    await openSymbols(page);
    await page.keyboard.press("Escape");
    // When Control is held
    await page.keyboard.down("Control");
    // Then known names have navigation highlights
    await expect.poll(() => symbolHighlights(page)).toBeGreaterThan(0);
    await page.screenshot({ path: test.info().outputPath("symbol-links.png") });
  });

  test("releasing Control clears navigation highlights", async () => {
    // Given visible navigation highlights while Control is held
    await openSymbols(page);
    await page.keyboard.press("Escape");
    await page.keyboard.down("Control");
    await page.waitForFunction(() => Array.from(CSS.highlights.entries()).some((entry) => entry[0].startsWith("biff-symbols-") && entry[1].size > 0));
    // When Control is released
    await page.keyboard.up("Control");
    // Then no modifier-only highlight remains
    await expect.poll(() => symbolHighlights(page)).toEqual(0);
  });

  test("ambiguous names open a declaration chooser instead of guessing", async () => {
    // Given two same-named definitions in this comparison
    ambiguous = true;
    await openSymbols(page);
    await page.keyboard.press("Escape");
    // When a matching name is Ctrl-clicked
    await clickWord(page, page.locator('[data-content] > [data-line]').filter({ hasText: "// saveReview helps" }), "saveReview");
    // Then both candidates are offered without including the base snapshot
    await expect(page.getByRole("dialog", { name: "Go to saveReview", exact: true }).getByRole("option")).toHaveCount(2);
  });

  test("Back returns to the clicked comment rather than the nearest changed hunk", async () => {
    // Given a comment-to-definition jump
    await openSymbols(page);
    await page.keyboard.press("Escape");
    await clickWord(page, page.locator('[data-content] > [data-line]').filter({ hasText: "// saveReview helps" }), "saveReview");
    await page.locator("[data-biff-focused]").filter({ hasText: "export function saveReview" }).waitFor();
    // When the reader returns
    await page.keyboard.press("Alt+ArrowLeft");
    // Then the original comment is focused
    await expect(page.locator("[data-biff-focused]")).toHaveText("// saveReview helps reviewers.");
  });

  test("base search uses old source coordinates independently of head", async () => {
    // Given head and base declarations on different lines
    await openSymbols(page);
    // When searching the base snapshot
    await page.getByLabel("Symbol revision").selectOption("LEFT");
    await page.screenshot({ path: test.info().outputPath("symbol-picker.png") });
    // Then the option displays the base coordinate
    await expect(page.getByRole("listbox", { name: "Symbols in this review" }).getByRole("option")).toHaveText("saveReviewdefinitions.ts:45function");
  });

  test("an indexing failure remains retryable after closing the picker", async () => {
    // Given an incomplete index shown in the declaration picker
    failed = true;
    await page.goto("/workspaces/fixture");
    await started.promise;
    await page.keyboard.press("Control+o");
    await page.getByText("Symbol index incomplete. Open Activity to retry.").waitFor();
    // And the picker is closed after its source recovers
    await page.keyboard.press("Escape");
    failed = false;
    // When the reader retries from the shell's existing Activity feedback
    await page.getByRole("button", { name: "Activity: 1 operation needs attention", exact: true }).click();
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await page.keyboard.press("Escape");
    await page.keyboard.press("Control+o");
    // Then a usable declaration replaces the incomplete state
    await expect(page.getByRole("listbox", { name: "Symbols in this review" }).getByRole("option")).toHaveCount(1);
  });

  test("the symbol picker fits a narrow reading surface", async () => {
    // Given a phone-width review
    await page.setViewportSize({ width: 390, height: 844 });
    // When symbol search opens
    await openSymbols(page);
    await page.screenshot({ path: test.info().outputPath("symbol-picker-mobile.png") });
    // Then the complete picker remains within the viewport
    await expect(page.getByRole("dialog", { name: "Find symbol", exact: true })).toBeInViewport({ ratio: 1 });
  });

  test("moving within a known name does not repeatedly reset its hover feedback", async () => {
    // Given pointer feedback on a known name with Control held
    await openSymbols(page);
    await page.keyboard.press("Escape");
    const point = await wordPoint(page.locator('[data-content] > [data-line]').filter({ hasText: "// saveReview helps" }), "saveReview");
    await page.keyboard.down("Control");
    await page.mouse.move(point.x, point.y);
    const feedback = page.locator('[title="Go to saveReview · definitions.ts:46"]');
    await feedback.waitFor();
    // And a native observer records changes to that feedback
    await feedback.evaluate((element) => {
      element.setAttribute("data-symbol-hover-mutations", "0");
      new MutationObserver((records) => {
        element.setAttribute("data-symbol-hover-mutations", String(Number(element.getAttribute("data-symbol-hover-mutations")) + records.length));
      }).observe(element, { attributes: true, attributeFilter: ["title", "style"] });
    });
    // When the pointer moves inside the same identifier
    await page.mouse.move(point.x + 2, point.y, { steps: 8 });
    // Then its cursor and tooltip remain untouched instead of being removed and reapplied
    await expect(feedback).toHaveAttribute("data-symbol-hover-mutations", "0");
  });

  test("holding Control activates hover feedback without moving the pointer again", async () => {
    // Given a pointer already resting on a known identifier
    await openSymbols(page);
    await page.keyboard.press("Escape");
    const point = await wordPoint(page.locator('[data-content] > [data-line]').filter({ hasText: "// saveReview helps" }), "saveReview");
    await page.mouse.move(point.x, point.y);
    // When Control is pressed without another pointer event
    await page.keyboard.down("Control");
    // Then the current name immediately offers navigation
    await expect(page.locator('[title="Go to saveReview · definitions.ts:46"]')).toBeVisible();
  });

  test("progressive indexing retains active highlights while Control is held", async () => {
    // Given active navigation highlights while another file is still indexing
    progressive = true;
    await openSymbols(page);
    await page.keyboard.press("Escape");
    await page.keyboard.down("Control");
    await page.waitForFunction(() => Array.from(CSS.highlights.entries()).some((entry) => entry[0].startsWith("biff-symbols-") && entry[1].size > 0));
    const original = await page.evaluateHandle(() => Array.from(CSS.highlights.entries()).find((entry) => entry[0].startsWith("biff-symbols-"))![1]);
    // When another declaration arrives
    advanced = true;
    await page.waitForFunction(() => Array.from(CSS.highlights.entries()).some((entry) => entry[0].startsWith("biff-symbols-") && Array.from(entry[1]).some((range) => range.toString() === "example")));
    // Then the active highlight layer is retained rather than removed and rebuilt from empty
    expect(await original.evaluate((highlight) => Array.from(CSS.highlights.values()).includes(highlight))).toEqual(true);
  });

  test("Left returns to the exact Ctrl-click origin", async () => {
    // Given a jump from a comment while the keyboard cursor is on another row
    await openSymbols(page);
    await page.keyboard.press("Escape");
    await clickWord(page, page.locator('[data-content] > [data-line]').filter({ hasText: "// saveReview helps" }), "saveReview");
    await page.locator("[data-biff-focused]").filter({ hasText: "export function saveReview" }).waitFor();
    // When the reader goes back with Left
    await page.keyboard.press("ArrowLeft");
    // Then the clicked comment, not the keyboard cursor, is restored
    await expect(page.locator("[data-biff-focused]")).toHaveText("// saveReview helps reviewers.");
  });

  test("Right restores the destination's latest reading coordinate", async () => {
    // Given a declaration jump followed by ordinary reading
    await openSymbols(page);
    await page.keyboard.press("Enter");
    await page.locator("[data-biff-focused]").filter({ hasText: "export function saveReview" }).waitFor();
    await page.keyboard.press("k");
    await page.locator("[data-biff-focused]").filter({ hasText: "// context 42" }).waitFor();
    // When the reader goes back and then forward
    await page.keyboard.press("ArrowLeft");
    await page.locator("[data-biff-focused]").filter({ hasText: "current call" }).waitFor();
    await page.keyboard.press("ArrowRight");
    // Then Forward returns to the last-read line, not just the declaration anchor
    await expect(page.locator("[data-biff-focused]")).toHaveText("// context 42");
  });

  test("local movement after Back preserves Forward", async () => {
    // Given a declaration jump followed by Back
    await openSymbols(page);
    await page.keyboard.press("Enter");
    await page.locator("[data-biff-focused]").filter({ hasText: "export function saveReview" }).waitFor();
    await page.keyboard.press("ArrowLeft");
    await page.locator("[data-biff-focused]").filter({ hasText: "current call" }).waitFor();
    // When the reader moves locally before going forward
    await page.keyboard.press("j");
    await page.locator("[data-biff-focused]").filter({ hasText: "// saveReview helps" }).waitFor();
    await page.keyboard.press("ArrowRight");
    // Then the original forward destination is still available
    await expect(page.locator("[data-biff-focused]")).toHaveText("export function saveReview() {}");
  });

  test("same-file jumps participate in browser Back and Forward", async () => {
    // Given a same-file declaration selected from an ambiguous Ctrl-click
    ambiguous = true;
    await openSymbols(page);
    await page.keyboard.press("Escape");
    await clickWord(page, page.locator('[data-content] > [data-line]').filter({ hasText: "// saveReview helps" }), "saveReview");
    await page.getByRole("option").filter({ hasText: "main.ts:4" }).click();
    await page.locator("[data-biff-focused]").filter({ hasText: "function saveReview() {}" }).waitFor();
    // When native browser Back and Forward traverse entries with the same pathname
    await page.goBack();
    await page.locator("[data-biff-focused]").filter({ hasText: "// saveReview helps" }).waitFor();
    await page.goForward();
    // Then the destination line is restored without needing a pathname change
    await expect(page.locator("[data-biff-focused]")).toHaveText("function saveReview() {}");
  });

  test("a new jump after Back discards the old forward branch", async () => {
    // Given a cross-file jump followed by Back
    ambiguous = true;
    await openSymbols(page);
    await page.getByRole("option").filter({ hasText: "definitions.ts:46" }).click();
    await page.locator("[data-biff-focused]").filter({ hasText: "export function saveReview" }).waitFor();
    await page.keyboard.press("ArrowLeft");
    await page.locator("[data-biff-focused]").filter({ hasText: "current call" }).waitFor();
    // When the reader takes a new, same-file jump and tries Forward
    await clickWord(page, page.locator('[data-content] > [data-line]').filter({ hasText: "// saveReview helps" }), "saveReview");
    await page.getByRole("option").filter({ hasText: "main.ts:4" }).click();
    await page.locator("[data-biff-focused]").filter({ hasText: "function saveReview() {}" }).waitFor();
    await page.goForward();
    // Then the discarded cross-file destination cannot be revisited
    await expect(page.getByLabel("Current file")).toHaveAttribute("title", "main.ts");
  });

  test("jumps publish a side-aware line anchor", async () => {
    // Given base declarations are selected
    await openSymbols(page);
    await page.getByLabel("Symbol revision").selectOption("LEFT");
    // When the old-side declaration is accepted
    await page.keyboard.press("Enter");
    // Then its URL identifies both the file and old-side source coordinate
    await expect(page).toHaveURL("http://127.0.0.1:5173/workspaces/fixture/f/definitions.ts#L45");
  });

  test("an explicit line URL wins over a previously saved cursor", async () => {
    // Given a saved reading cursor at the declaration
    await openSymbols(page);
    await page.keyboard.press("Enter");
    await page.locator("[data-biff-focused]").filter({ hasText: "export function saveReview" }).waitFor();
    // When an explicit old-side source URL is opened
    await page.goto("/workspaces/fixture/f/definitions.ts#L1");
    // Then the old-side declaration is selected rather than the saved new-side row
    await expect(page.locator("[data-biff-focused]")).toHaveText('const label = "before";');
  });

  test("Back remains usable while destination source is held", async () => {
    // Given a destination whose full source cannot finish loading yet
    const requested = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    await page.route("**/contents", async (route) => {
      if (route.request().postDataJSON().path === "definitions.ts") {
        requested.resolve();
        await release.promise;
      }
      return route.fallback();
    });
    await openSymbols(page);
    // When a declaration jump starts loading and the reader returns before it finishes
    try {
      await page.keyboard.press("Enter");
      await requested.promise;
      await page.keyboard.press("ArrowLeft");
      await page.locator("[data-biff-focused]").filter({ hasText: "current call" }).waitFor();
      const response = page.waitForResponse((response) => response.url().endsWith("/contents") && response.request().postDataJSON().path === "definitions.ts");
      release.resolve();
      await response;
      // Then late source hydration cannot steal focus back to the destination
      await expect(page.locator("[data-biff-focused]")).toHaveText("saveReview(); // current call");
    } finally { release.resolve(); }
  });

  test("reading after a jump keeps the shareable anchor unchanged", async () => {
    // Given a declaration checkpoint
    await openSymbols(page);
    await page.keyboard.press("Enter");
    await page.locator("[data-biff-focused]").filter({ hasText: "export function saveReview" }).waitFor();
    const url = page.url();
    // When the reader moves away from the declaration
    await page.keyboard.press("k");
    await page.locator("[data-biff-focused]").filter({ hasText: "// context 42" }).waitFor();
    // Then only the in-memory coordinate changes, not the URL anchor
    await expect(page).toHaveURL(url);
  });
});

/** Open the declaration-only picker with no special query prefix. */
async function openSymbols(page: Page): Promise<void> {
  await page.goto("/workspaces/fixture");
  await page.getByRole("button", { name: "Symbols", exact: true }).waitFor();
  await page.keyboard.press("Control+o");
  await page.getByRole("listbox", { name: "Symbols in this review" }).getByRole("option").first().waitFor();
}

/**
 * Click the source word itself, even when highlighting splits it across text nodes.
 *
 * Native pointer coordinates exercise the same shadow-DOM hit testing as a real Ctrl-click.
 */
async function clickWord(page: Page, row: Locator, word: string): Promise<void> {
  const point = await wordPoint(row, word);
  await page.keyboard.down("Control");
  await page.mouse.click(point.x, point.y);
  await page.keyboard.up("Control");
}

/**
 * Find the center of a whole source name across syntax spans.
 *
 * Reuse native text ranges for stationary hover, movement, and actual navigation tests.
 */
async function wordPoint(row: Locator, word: string): Promise<{ x: number; y: number }> {
  await row.scrollIntoViewIfNeeded();
  return row.evaluate((element, name) => {
    const text = element.textContent ?? "";
    const start = text.indexOf(name);
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    let offset = 0;
    while (walker.nextNode()) {
      const node = walker.currentNode as Text;
      if (start >= offset && start < offset + node.length) range.setStart(node, start - offset);
      if (start + name.length > offset && start + name.length <= offset + node.length) { range.setEnd(node, start + name.length - offset); break; }
      offset += node.length;
    }
    const bounds = range.getBoundingClientRect();
    return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  }, word);
}

/** Count only active navigation ranges, not syntax or file-search highlights. */
async function symbolHighlights(page: Page): Promise<number> {
  return page.evaluate(() => Array.from(CSS.highlights.entries()).filter((entry) => entry[0].startsWith("biff-symbols-")).reduce((count, entry) => count + entry[1].size, 0));
}
