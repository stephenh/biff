import { chromium, expect, test, type Browser, type Page } from "@playwright/test";
import { createTwoFilesPatch } from "diff";

test.describe("Native diff virtualization", () => {
  let browser: Browser;
  let page: Page;
  test.beforeAll(async () => { browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium" }); });
  test.beforeEach(async () => { page = await browser.newPage({ baseURL: "http://127.0.0.1:5173", viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" }); });
  test.afterEach(async () => { await page.close(); });
  test.afterAll(async () => { await browser.close(); });

  test("multiplying file length does not multiply mounted source rows", async () => {
    // Given two reviews with the same viewport and different source lengths
    await openLargeReview(page, 100);
    const smaller = await page.locator("[data-content] > [data-line]").count();

    // When a review ten times as large is opened
    await openLargeReview(page, 1000);
    const larger = await page.locator("[data-content] > [data-line]").count();

    // Then mounted rows remain bounded by the viewport and native overscan
    expect(larger).toBeLessThanOrEqual(smaller + 100);
    expect(larger).toBeLessThan(250);
  });

  test("search reveals an offscreen source row and hunk navigation works in both directions", async () => {
    // Given the last business edit is outside the mounted window
    await openLargeReview(page, 100);
    await expect(page.locator('[data-line="1981"]')).toHaveCount(0);

    // When search selects that source coordinate and navigation moves back and forth
    await page.keyboard.press("Control+f");
    await page.getByRole("textbox", { name: "Search files and symbols" }).fill("newValue99");
    await page.locator(".search-result").click();
    await expect(page.locator("[data-biff-focused]")).toHaveText("const newValue99 = 99;");
    await page.keyboard.press("p");
    await expect(page.locator("[data-biff-focused]")).toHaveText("const newValue98 = 98;");
    await page.keyboard.press("n");

    // Then the same source row is focused inside a bounded mounted window
    await expect(page.locator("[data-biff-focused]")).toHaveText("const newValue99 = 99;");
    expect(await page.locator("[data-content] > [data-line]").count()).toBeLessThan(250);
  });

  test("line navigation crosses the mounted window in both directions", async () => {
    // Given a file larger than the native window
    await openLargeReview(page, 100);

    // When the cursor moves beyond the initial window and returns
    for (let index = 0; index < 180; index++) await page.keyboard.press("j");
    await expect(page.locator("[data-biff-focused]")).toHaveAttribute("data-line", "181");
    for (let index = 0; index < 180; index++) await page.keyboard.press("k");

    // Then it reaches the original source coordinate
    await expect(page.locator("[data-biff-focused]")).toHaveAttribute("data-line", "1");
  });

  test("a comment jump from a deep-linked file reveals its offscreen source coordinate", async () => {
    // Given a PR discussion on an unmounted line in a deep-linked file
    const patch = await openLargeReview(page, 100);
    await page.route("**/api/github/pr/**", (route) => {
      const path = new URL(route.request().url()).pathname;
      let json: unknown = [];
      if (path.endsWith("/review")) json = { pr: { title: "Virtual review", user: { login: "author" }, state: "open", head: { sha: "a".repeat(40), ref: "feature" }, base: { sha: "b".repeat(40), ref: "main" } }, commit: "all", commits: [], patch };
      else if (path.endsWith("/conversation")) json = { comments: [], reviews: [], inline: [{ id: 1, path: "large.ts", line: 1981, side: "RIGHT", body: "Offscreen discussion", user: { login: "reviewer" }, html_url: "" }] };
      else if (path.endsWith("/discussion")) json = { identity: { id: "fixture" }, threads: [], version: 0 };
      else if (path.endsWith("/viewed")) json = { files: {} };
      else if (path.endsWith("/identity") || path.endsWith("/stack")) json = null;
      return route.fulfill({ json });
    });
    await page.goto("/pr/example/repo/1/f/large.ts");
    await page.locator("[data-biff-focused]").waitFor();

    // When the discussion's source link is followed
    await page.getByRole("button", { name: "Discussion & review", exact: true }).click();
    await page.getByRole("button", { name: "View line", exact: true }).click();

    // Then source focus and its gutter marker appear in the native window
    await expect(page.locator("[data-biff-focused]")).toHaveText("const newValue99 = 99;");
    await expect(page.locator("[data-biff-comments]")).toHaveCount(1);
  });

  test("font-size and viewport changes retain an offscreen navigation target", async () => {
    // Given a source coordinate revealed near the end of a large file
    await openLargeReview(page, 100);
    await page.keyboard.press("Control+f");
    await page.getByRole("textbox", { name: "Search files and symbols" }).fill("newValue99");
    await page.locator(".search-result").click();
    await expect(page.locator("[data-biff-focused]")).toHaveText("const newValue99 = 99;");

    // When typography changes and the viewport becomes narrow enough to wrap code
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("slider", { name: "Text size" }).fill("34");
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 600, height: 900 });

    // Then the same source row remains visible with a bounded mounted window
    await expect(page.locator("[data-biff-focused]")).toHaveText("const newValue99 = 99;");
    await expect(page.locator("[data-biff-focused]")).toBeInViewport();
    expect(await page.locator("[data-content] > [data-line]").count()).toBeLessThan(250);
  });

  test("search hydrates omitted context without mounting the entire source", async () => {
    // Given two distant edits with the search target omitted from the patch
    const lines = Array.from({ length: 2000 }, (_, index) => `const context${index} = ${index};`);
    lines[1000] = "const hiddenNeedle = 1000;";
    const oldSource = `${lines.join("\n")}\n`;
    lines[0] = "const firstChange = 1;";
    lines[1999] = "const lastChange = 2;";
    await openSourceReview(page, oldSource, `${lines.join("\n")}\n`);

    // When the omitted source coordinate is selected from search
    await page.keyboard.press("Control+f");
    await page.getByRole("textbox", { name: "Search files and symbols" }).fill("hiddenNeedle");
    await page.locator(".search-result").click();

    // Then hydration reveals the correct source row in a bounded native window
    await expect(page.locator("[data-biff-focused]")).toHaveAttribute("data-line", "1001");
    await expect(page.locator("[data-biff-focused]")).toHaveText("const hiddenNeedle = 1000;");
    expect(await page.locator("[data-content] > [data-line]").count()).toBeLessThan(250);
  });

  test("large import folds expand into a bounded window with original source coordinates", async () => {
    // Given an import replacement much larger than a viewport
    const oldSource = Array.from({ length: 300 }, (_, index) => `import { Old${index} } from "module${index}";`).join("\n") + "\n\nconst body = 1;\n";
    const newSource = oldSource.replaceAll("Old", "New").replace("body = 1", "body = 2");
    await openSourceReview(page, oldSource, newSource);

    // When imports are expanded and an offscreen import is selected
    await page.locator("[data-fold-toggle][aria-expanded=false]").first().click();
    await page.keyboard.press("Control+f");
    await page.getByRole("textbox", { name: "Search files and symbols" }).fill("New250");
    await page.locator(".search-result").click();

    // Then native folding and virtualization preserve the new-file coordinate
    await expect(page.locator("[data-biff-focused]")).toHaveAttribute("data-line", "251");
    await expect(page.locator("[data-biff-focused]")).toHaveText('import { New250 } from "module250";');
    expect(await page.locator("[data-content] > [data-line]").count()).toBeLessThan(250);
  });
});

/** Use ordinary patch metadata so the test also exercises semantic review splitting. */
async function openLargeReview(page: Page, blocks: number) {
  await page.unroute("**/api/**");
  const lines = Array.from({ length: blocks }, (_, index) => [
    `-const oldValue${index} = ${index};`, `+const newValue${index} = ${index};`,
    ...Array.from({ length: 19 }, (_, offset) => ` const context${index}_${offset} = ${offset};`),
  ]).flat();
  const patch = `diff --git a/large.ts b/large.ts\n--- a/large.ts\n+++ b/large.ts\n@@ -1,${blocks * 20} +1,${blocks * 20} @@\n${lines.join("\n")}\n`;
  const workspace = { id: "fixture", name: "fixture", path: "/fixture" };
  const revision = { commit_id: "a".repeat(40), change_id: "qwerty", description: "Virtualization fixture" };
  await page.route("**/api/**", (route) => route.fulfill({ json: route.request().url().includes("/review?") ? { workspace, selected: revision, revisions: [revision], patch } : [] }));
  await page.goto("/workspaces/fixture");
  await page.locator("[data-biff-focused]").waitFor();
  return patch;
}

/** Serve full source through the same endpoint used by import preparation and hydration. */
async function openSourceReview(page: Page, oldSource: string, newSource: string) {
  const patch = createTwoFilesPatch("large.ts", "large.ts", oldSource, newSource);
  const workspace = { id: "fixture", name: "fixture", path: "/fixture" };
  const revision = { commit_id: "a".repeat(40), change_id: "qwerty", description: "Source fixture" };
  await page.route("**/api/**", (route) => route.fulfill({ json: route.request().url().includes("/contents")
    ? { oldFile: { name: "large.ts", contents: oldSource }, newFile: { name: "large.ts", contents: newSource } }
    : route.request().url().includes("/review?") ? { workspace, selected: revision, revisions: [revision], patch } : [] }));
  await page.goto("/workspaces/fixture");
  await page.locator("[data-biff-focused]").waitFor();
}
