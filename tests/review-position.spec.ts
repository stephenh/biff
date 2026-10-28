import { chromium, expect, test, type Browser, type Page } from "@playwright/test";
import { createTwoFilesPatch } from "diff";

test.describe("Review position", () => {
  let browser: Browser;
  let page: Page;
  let oldLines: string[];
  let newLines: string[];
  let head: string;
  const url = "/workspaces/fixture/f/costs.ts?bookmark=&changes=all";

  test.beforeAll(async () => { browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium" }); });
  test.afterAll(async () => { await browser.close(); });
  test.afterEach(async () => { await page.close(); });
  test.beforeEach(async () => {
    page = await browser.newPage({ baseURL: "http://127.0.0.1:5173", viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
    oldLines = Array.from({ length: 600 }, (_, index) => `const value${index + 1} = ${index + 1};`);
    newLines = [...oldLines];
    newLines[10] = "const changed11 = 11;";
    newLines[469] = "const changed470 = 470;";
    head = "a".repeat(40);
    await page.route("**/api/**", (route) => {
      const path = new URL(route.request().url()).pathname;
      const oldSource = `${oldLines.join("\n")}\n`;
      const newSource = `${newLines.join("\n")}\n`;
      if (path.endsWith("/contents")) return route.fulfill({ json: {
        oldFile: { name: "src/costs.ts", contents: oldSource }, newFile: { name: "src/costs.ts", contents: newSource },
      } });
      if (path.endsWith("/review")) {
        const revision = { commit_id: head, change_id: "qwerty", description: "Position fixture" };
        const patch = createTwoFilesPatch("src/costs.ts", "src/costs.ts", oldSource, newSource)
          + createTwoFilesPatch("other.ts", "other.ts", "old\n", "new\n");
        return route.fulfill({ json: { workspace: { id: "fixture", name: "fixture", path: "/fixture" }, selected: revision, revisions: [revision], patch } });
      }
      return route.fulfill({ json: [] });
    });
    await page.goto(url);
    await page.locator("[data-biff-focused]").filter({ hasText: "const changed11 = 11;" }).waitFor();
  });

  test("reload restores a selected line after its hunk and commit change", async () => {
    // Given an individual context line selected below the second change
    await page.keyboard.press("n");
    await page.locator("[data-biff-focused]").filter({ hasText: "const changed470 = 470;" }).waitFor();
    await page.keyboard.press("j");
    await page.locator("[data-biff-focused]").filter({ hasText: "const value471 = 471;" }).waitFor();
    // And new edits change both the preceding diff indexes and the selected line's hunk identity
    newLines[100] = "const earlierChange = 101;";
    newLines[471 - 1] = "const replacement471 = 471;";
    head = "b".repeat(40);

    // When the updated review is reloaded
    await page.reload();

    // Then selection follows the new-side line number, not the old hunk or code text
    await expect(page.locator("[data-biff-focused]")).toHaveText("const replacement471 = 471;");
  });

  test("reload reveals a selected line that is no longer in any hunk", async () => {
    // Given the second changed line was selected
    await page.keyboard.press("n");
    await page.locator("[data-biff-focused]").filter({ hasText: "const changed470 = 470;" }).waitFor();
    // And that change disappears from the patch
    newLines[469] = oldLines[469];
    head = "b".repeat(40);

    // When the review is reloaded
    await page.reload();

    // Then omitted context is expanded to restore the same new-side line
    await expect(page.locator("[data-biff-focused]")).toHaveText("const value470 = 470;");
  });

  test("reload centers the restored source line", async () => {
    // Given a selected change far below the first hunk
    await page.keyboard.press("n");
    await page.locator("[data-biff-focused]").filter({ hasText: "const changed470 = 470;" }).waitFor();

    // When the review is reloaded
    await page.reload();
    await page.locator("[data-biff-focused]").filter({ hasText: "const changed470 = 470;" }).waitFor();

    // Then the restored row is visible in the middle of the reading surface
    await expect.poll(() => focusedCenterOffset(page)).toBeLessThan(2);
  });

  test("reload saves hydrated context using source numbers rather than renderer indexes", async () => {
    // Given expanded context around the second change
    await page.keyboard.press("n");
    await page.locator("[data-biff-focused]").filter({ hasText: "const changed470 = 470;" }).waitFor();
    await page.keyboard.press("u");
    // And an unchanged line outside the original patch is selected with the mouse
    await page.locator('[data-content] > [data-line="465"]').click();
    await page.locator("[data-biff-focused]").filter({ hasText: "const value465 = 465;" }).waitFor();

    // When the review is reloaded with context initially collapsed
    await page.reload();

    // Then the original source coordinate is restored
    await expect(page.locator("[data-biff-focused]")).toHaveText("const value465 = 465;");
  });

  test("reload preserves the old side of a selected deletion", async () => {
    // Given a deleted row selected with the mouse
    await page.keyboard.press("n");
    await page.locator("[data-biff-focused]").filter({ hasText: "const changed470 = 470;" }).waitFor();
    await page.keyboard.press("d");
    await page.locator('[data-content] > [data-line="470"][data-line-type="change-deletion"]').click();
    await page.locator("[data-biff-focused]").filter({ hasText: "const value470 = 470;" }).waitFor();
    // And the old text changes while retaining its line number
    oldLines[469] = "const previous470 = 470;";
    head = "b".repeat(40);

    // When the review is reloaded
    await page.reload();

    // Then the old-side line is selected and its deletion is visible
    await expect(page.locator("[data-biff-focused]")).toHaveText("const previous470 = 470;");
  });

  test("ordinary file navigation still starts at the first pending change", async () => {
    // Given a later line selected in the current file
    await page.keyboard.press("n");
    await page.locator("[data-biff-focused]").filter({ hasText: "const changed470 = 470;" }).waitFor();

    // When the reader leaves the file and returns without reloading
    await page.keyboard.press("l");
    await page.getByLabel("Current file").filter({ hasText: "other.ts" }).waitFor();
    await page.keyboard.press("h");

    // Then file navigation does not revive the old reading cursor
    await expect(page.locator("[data-biff-focused]")).toHaveText("const changed11 = 11;");
  });

  test("a different comparison does not inherit the saved line", async () => {
    // Given a later line selected in the all-changes comparison
    await page.keyboard.press("n");
    await page.locator("[data-biff-focused]").filter({ hasText: "const changed470 = 470;" }).waitFor();

    // When another comparison opens the same file
    await page.goto("/workspaces/fixture/f/costs.ts?rev=other");

    // Then that comparison starts normally instead of restoring unrelated coordinates
    await expect(page.locator("[data-biff-focused]")).toHaveText("const changed11 = 11;");
  });
});

/** Measure the selected row against the viewport, independent of virtual row indexes. */
async function focusedCenterOffset(page: Page): Promise<number> {
  return page.evaluate(() => {
    const viewport = document.querySelector<HTMLElement>('main[aria-label="Diff reading surface"]');
    const row = viewport?.querySelector("diffs-container")?.shadowRoot?.querySelector("[data-biff-focused]");
    if (!viewport || !row) return Infinity;
    const bounds = row.getBoundingClientRect();
    return Math.abs(bounds.top + bounds.height / 2 - viewport.getBoundingClientRect().top - viewport.clientHeight / 2);
  });
}
