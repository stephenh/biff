import { chromium, expect, test, type Browser, type Page } from "@playwright/test";
import { createTwoFilesPatch } from "diff";

test.describe("Deletion folds", () => {
  let browser: Browser;
  let page: Page;
  test.beforeAll(async () => { browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium" }); });
  test.beforeEach(async () => { page = await browser.newPage({ baseURL: "http://127.0.0.1:5173", viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" }); });
  test.afterEach(async () => { await page.close(); });
  test.afterAll(async () => { await browser.close(); });

  test("standalone deletions stay readable while another change is selected", async () => {
    // Given a replacement followed by a deletion-only block
    await openReview(page, "const before = 0;\nconst keep = 1;\nconst removed = 2;\n", "const before = 1;\nconst keep = 1;\n");
    // When the replacement is selected with deletion collapsing enabled
    const deletion = page.locator('[data-content] > [data-line]').filter({ hasText: "const removed = 2;" });
    // Then the standalone deletion has normal reading height
    await expect.poll(() => deletion.evaluate((row) => row.getBoundingClientRect().height)).toBe(35);
  });

  test("navigation reaches a trailing deletion after a large collapsed replacement", async () => {
    // Given a large replacement, another edit, and a trailing deletion-only block
    const first = Array.from({ length: 105 }, (_, index) => `const old${index} = ${index};\n`).join("");
    const middle = Array.from({ length: 4 }, (_, index) => `const middle${index} = ${index};\n`).join("");
    const last = Array.from({ length: 4 }, (_, index) => `const last${index} = ${index};\n`).join("");
    const removed = Array.from({ length: 49 }, (_, index) => `const removed${index} = ${index};\n`).join("");
    await openReview(page, `${first}${middle}const second = 0;\n${last}${removed}`, `const replacement = 1;\n${middle}const second = 1;\n${last}`);
    // When navigation moves through the second edit to the trailing deletion
    await page.keyboard.press("n");
    await expect(page.locator("[data-biff-focused]")).toHaveText("const second = 1;");
    await page.keyboard.press("n");
    // Then the old-side deletion is selected inside the viewport
    await expect(page.locator("[data-biff-focused]")).toHaveText("const removed0 = 0;");
    await expect(page.locator("[data-biff-focused]")).toBeInViewport();
  });

  test("a collapsed replacement reports its complete deletion count", async () => {
    // Given a replacement larger than the native mounted window
    const oldSource = Array.from({ length: 1000 }, (_, index) => `const old${index} = ${index};\n`).join("");
    await openReview(page, oldSource, "const replacement = 1;\n");
    // When the replacement opens in its collapsed view
    // Then its summary counts the whole block, not just mounted rows
    await expect(page.getByRole("button", { name: "1000 deleted lines", exact: true })).toBeVisible();
  });

  test("collapsed replacements do not mount hidden source rows", async () => {
    // Given a replacement with a thousand deleted lines
    const oldSource = Array.from({ length: 1000 }, (_, index) => `const old${index} = ${index};\n`).join("");
    await openReview(page, oldSource, "const replacement = 1;\n");
    // When the replacement opens in its collapsed view
    // Then only its new source row is mounted
    await expect(page.locator("[data-content] > [data-line]")).toHaveCount(1);
  });

  test("peeking at a large deletion retains the selected replacement", async () => {
    // Given a replacement whose deleted source spans many native windows
    const oldSource = Array.from({ length: 1000 }, (_, index) => `const old${index} = ${index};\n`).join("");
    await openReview(page, oldSource, "const replacement = 1;\n");
    // When nearby old code is expanded and collapsed again
    await page.keyboard.press("d");
    await expect(page.locator('[data-content] > [data-line-type="change-deletion"]').last()).toBeVisible();
    await page.keyboard.press("d");
    // Then the same replacement remains selected and visible
    await expect(page.locator("[data-biff-focused]")).toHaveText("const replacement = 1;");
    await expect(page.locator("[data-biff-focused]")).toBeInViewport();
  });

  test("moving from deleted code to its replacement does not jump before following the cursor", async () => {
    // Given nearby deletions with a large block above the current replacement
    // And the cursor is on the deletion immediately before the fourth replacement
    await openNearbyDeletionReview(page);
    const movement = await page.evaluateHandle(recordRowMovement, '[data-content] > [data-line-type="change-addition"][data-line="7"]');
    // When j crosses to the addition and the nearby fold window changes
    await page.keyboard.press("j");
    const displacement = await movement.evaluate(async (samples) => { await samples.finished; return Math.max(...samples.frames.map((frame) => frame.offset)); });
    await movement.dispose();
    // Then the adjacent line stays in place instead of jumping and scrolling back
    expect(displacement).toBeLessThanOrEqual(2);
  });

  test("crossing a deletion boundary in either direction never paints an empty code window", async () => {
    // Given nearby folds that change a large block above the selected deletion
    await openNearbyDeletionReview(page);
    const movement = await page.evaluateHandle(recordRowMovement, '[data-content] > [data-line-type="change-addition"][data-line="7"]');
    // When the cursor crosses to the replacement and back
    await page.keyboard.press("j");
    await expect(page.locator("[data-biff-focused]")).toHaveText("const replacement3 = 3;");
    await page.keyboard.press("k");
    await expect(page.locator("[data-biff-focused]")).toHaveText("const old3_0 = 0;");
    const visible = await movement.evaluate(async (samples) => { await samples.finished; return samples.frames.every((frame) => frame.present); });
    await movement.dispose();
    // Then the replacement remains mounted on every painted frame
    expect(visible).toBe(true);
  });
});

/** Exercise ordinary patch parsing without a live PR or persisted review state. */
async function openReview(page: Page, oldSource: string, newSource: string) {
  const patch = createTwoFilesPatch("file.ts", "file.ts", oldSource, newSource);
  const workspace = { id: "fixture", name: "fixture", path: "/fixture" };
  const revision = { commit_id: "a".repeat(40), change_id: "qwerty", description: "Deletion fixture" };
  await page.route("**/api/**", (route) => route.fulfill({ json: route.request().url().includes("/review?") ? { workspace, selected: revision, revisions: [revision], patch } : [] }));
  await page.goto("/workspaces/fixture");
  await page.locator("[data-biff-focused]").waitFor();
}

/** Record painted positions so a transient jump cannot hide behind the final settled scroll. */
function recordRowMovement(selector: string) {
  const root = document.querySelector("main diffs-container")!.shadowRoot!;
  const top = root.querySelector(selector)!.getBoundingClientRect().top;
  const frames: { present: boolean; offset: number }[] = [];
  const finished = new Promise<void>((resolve) => {
    const start = performance.now();
    /** Include the first frame after folding changes, not just the completed animation. */
    function sample() {
      const row = root.querySelector(selector);
      frames.push({ present: Boolean(row), offset: row ? Math.abs(row.getBoundingClientRect().top - top) : 0 });
      if (performance.now() - start < 1000) requestAnimationFrame(sample);
      else resolve();
    }
    requestAnimationFrame(sample);
  });
  return { frames, finished };
}

/**
 * Select the old side of a replacement whose nearby window includes a large earlier deletion.
 *
 * Wrapped context exposes stale height estimates when that earlier deletion folds away.
 */
async function openNearbyDeletionReview(page: Page) {
  const oldBlocks: string[] = [];
  const newBlocks: string[] = [];
  for (const [block, length] of [105, 1, 4, 1, 3, 1, 1].entries()) {
    const context = `const context${block} = "${"unchanged ".repeat(20)}";\n`;
    oldBlocks.push(Array.from({ length }, (_, index) => `const old${block}_${index} = ${index};\n`).join("") + context);
    newBlocks.push(`const replacement${block} = ${block};\n${context}`);
  }
  await openReview(page, oldBlocks.join(""), newBlocks.join(""));
  for (let block = 1; block <= 3; block++) {
    await page.keyboard.press("n");
    await expect(page.locator("[data-biff-focused]")).toHaveText(`const replacement${block} = ${block};`);
  }
  await page.keyboard.press("d");
  await page.keyboard.press("k");
  await expect(page.locator("[data-biff-focused]")).toHaveText("const old3_0 = 0;");
  await page.mouse.move(0, 0);
  await page.evaluate(async () => { await document.fonts.ready; await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); });
  await page.emulateMedia({ reducedMotion: "no-preference" });
}
