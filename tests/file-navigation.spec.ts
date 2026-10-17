import { readFile } from "node:fs/promises";
import { chromium, expect, test, type Browser, type Page } from "@playwright/test";

test.describe("File navigation", () => {
  let browser: Browser;
  let page: Page;

  test.beforeAll(async () => { browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium" }); });
  test.beforeEach(async () => {
    page = await browser.newPage({ baseURL: "http://127.0.0.1:5173", viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
    const patch = await readFile(new URL("../fixtures/demo.diff", import.meta.url), "utf8");
    const workspace = { id: "fixture", name: "fixture", path: "/fixture" };
    const revision = { commit_id: "a".repeat(40), change_id: "qwerty", description: "Navigation fixture" };
    await page.route("**/api/**", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(
      route.request().url().includes("/review?") ? { workspace, selected: revision, revisions: [revision], patch } : [workspace],
    ) }));
    await page.goto("/workspaces/fixture");
    await page.locator("[data-biff-focused]").waitFor();
  });
  test.afterEach(async () => { await page.close(); });
  test.afterAll(async () => { await browser.close(); });

  test("neighboring files are shown as basenames", async () => {
    // Given the first file in the rail
    // When its neighboring file is clicked
    await page.getByRole("button", { name: "Open schema/review.graphql", exact: true }).click();

    // Then the rail shows only the basenames of the previous and next files
    await expect(page.locator("button.file-tile")).toHaveText(["reviews.ts", "settings.json"]);
  });

  test("the active filename is geometrically centered in the rail", async () => {
    // Given a review with more than one file
    // When the reader opens its middle file
    await page.keyboard.press("ArrowRight");
    await expect(page.getByLabel("Current file")).toHaveValue("1");
    const rail = await page.locator(".file-rail").boundingBox();
    const current = await page.locator(".current-file").boundingBox();

    // Then the current tile is centered independently of its neighbors' text widths
    expect(Math.abs(current!.x + current!.width / 2 - rail!.x - rail!.width / 2)).toBeLessThan(1);
  });

  test("moving forward slides the incoming code in from the right", async () => {
    // Given normal animation preferences
    await page.emulateMedia({ reducedMotion: "no-preference" });

    // When the reader advances a file and inspects the middle of the transition
    await page.keyboard.press("ArrowRight");
    await pauseSlide(page);
    await page.locator("[data-file-snapshot] [data-line]").filter({ hasText: "PAGE_SIZE = 50" }).waitFor({ state: "attached" });

    // Then the incoming pane is moving leftwards from a positive horizontal offset
    expect(await incomingOffset(page)).toBeGreaterThan(0);
  });

  test("moving backward slides the incoming code in from the left", async () => {
    // Given the second file with animations enabled
    await page.keyboard.press("n");
    await expect(page.getByLabel("Current file")).toHaveValue("1");
    await page.locator("[data-line]").filter({ hasText: "status: ReviewStatus!" }).waitFor();
    // And subsequent file changes should animate
    await page.emulateMedia({ reducedMotion: "no-preference" });

    // When the reader moves back a file
    await page.keyboard.press("ArrowLeft");
    await pauseSlide(page);

    // Then the incoming pane is moving rightwards from a negative horizontal offset
    expect(await incomingOffset(page)).toBeLessThan(0);
  });

  test("reduced motion changes files without an outgoing snapshot", async () => {
    // Given the browser requests reduced motion
    // When the reader opens the next file
    await page.keyboard.press("n");
    await expect(page.getByLabel("Current file")).toHaveValue("1");

    // Then no animated copy of the previous diff is retained
    await expect(page.locator("[data-file-snapshot]")).toHaveCount(0);
  });

  test("rapidly reversing direction leaves the final file interactive", async () => {
    // Given normal animations
    await page.emulateMedia({ reducedMotion: "no-preference" });

    // When navigation interrupts an unfinished slide and reverses direction
    await page.keyboard.press("n");
    await expect(page.getByLabel("Current file")).toHaveValue("1");
    await page.keyboard.press("n");
    await page.keyboard.press("p");
    await page.locator("[data-file-snapshot]").waitFor({ state: "detached" });

    // Then the final file remains selected and its code can receive line navigation
    await page.keyboard.press("j");
    await expect(page.locator("[data-biff-focused]")).toHaveText("isDraft: Boolean!");
  });

  test("the current filename does not repeat its directory path", async () => {
    // Given the first file has a directory in its repository path
    // When the rail renders its selected label
    const label = page.locator(".current-file selectedcontent");

    // Then the visible label contains only its basename
    await expect(label).toHaveJSProperty("innerText", "reviews.ts");
  });

  test("source and companion files share the same left edge", async () => {
    // Given two source/test pairs followed by another source file
    const names = ["src/Foo.ts", "src/Foo.test.ts", "src/Bar.ts", "src/Bar.test.ts", "src/Baz.ts"];
    const patch = names.map((name) => `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n@@ -1 +1 @@\n-const before = 1;\n+const after = 2;\n`).join("");
    const workspace = { id: "fixture", name: "fixture", path: "/fixture" };
    const revision = { commit_id: "a".repeat(40), change_id: "qwerty", description: "Companion fixture" };
    // And the API supplies those files in one review
    await page.route("**/api/**", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(
      route.request().url().includes("/review?") ? { workspace, selected: revision, revisions: [revision], patch } : [workspace],
    ) }));

    // When the file menu opens
    await page.reload();
    await page.getByLabel("Current file").click();
    const indents = await page.locator(".file-select option > .file-option-label").evaluateAll((labels) => {
      const origin = labels[0].getBoundingClientRect().x;
      return labels.map((label) => label.getBoundingClientRect().x - origin);
    });

    // Then every filename starts at the same left edge without a reserved status column
    expect(indents).toEqual([0, 0, 0, 0, 0]);
  });

  test("a relocated line is blue only at its new location", async () => {
    // Given a long line moved past two unchanged lines with different indentation
    const patch = "diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n@@ -1,3 +1,3 @@\n-const movedValue = 123;\n const firstContext = 1;\n const secondContext = 2;\n+  const movedValue = 123;\n";
    const workspace = { id: "fixture", name: "fixture", path: "/fixture" };
    const revision = { commit_id: "a".repeat(40), change_id: "qwerty", description: "Moved line fixture" };
    // And the API supplies that diff
    await page.route("**/api/**", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(
      route.request().url().includes("/review?") ? { workspace, selected: revision, revisions: [revision], patch } : [workspace],
    ) }));

    // When the diff opens with deleted lines expanded
    await page.reload();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByLabel("Collapse deleted lines").uncheck();
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.querySelector("diffs-container")?.shadowRoot?.querySelectorAll("[data-content] > [data-biff-moved]").length === 1);
    const locations = await page.locator("[data-content] > [data-biff-moved]").evaluateAll((rows) => rows.map((row) => (row as HTMLElement).dataset.lineType));

    // Then only the addition receives moved-line styling and the deletion retains its red styling
    expect(locations).toEqual(["change-addition"]);
  });
});

/** Freeze both panes halfway through their real browser animations. */
async function pauseSlide(page: Page) {
  await page.waitForFunction(() => {
    const stage = document.querySelector(".file-stage")!;
    if (!stage.querySelector("[data-file-snapshot]")) return false;
    const animations = stage.getAnimations({ subtree: true });
    if (animations.length < 2) return false;
    for (const animation of animations) { animation.pause(); animation.currentTime = 160; }
    return true;
  });
}

/** Read the actual animated pane's horizontal transform, excluding the inert copy. */
async function incomingOffset(page: Page): Promise<number> {
  return page.locator("main:not([data-file-snapshot])").evaluate((element) => new DOMMatrix(getComputedStyle(element).transform).m41);
}
