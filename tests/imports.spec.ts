import { chromium, expect, test, type Browser, type Page } from "@playwright/test";

const stanzaPatch = 'diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n@@ -1,6 +1,7 @@\n+import { Added } from "added";\n import { Unchanged } from "unchanged";\n-import { Removed } from "removed";\n+import { Replacement } from "replacement";\n import { Last } from "last";\n-import { Before } from "changed";\n+import { After } from "changed";\n \n-const body = 1;\n+const body = 2;\n';

test.describe("Import folding", () => {
  let browser: Browser;
  let page: Page;
  let patch: string;
  let oldContents: string;
  let newContents: string;

  test.beforeAll(async () => { browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium" }); });
  test.beforeEach(async () => {
    page = await browser.newPage({ baseURL: "http://127.0.0.1:5173", viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
    patch = stanzaPatch;
    oldContents = 'import { Unchanged } from "unchanged";\nimport { Removed } from "removed";\nimport { Last } from "last";\nimport { Before } from "changed";\n\nconst body = 1;\n';
    newContents = 'import { Added } from "added";\nimport { Unchanged } from "unchanged";\nimport { Replacement } from "replacement";\nimport { Last } from "last";\nimport { After } from "changed";\n\nconst body = 2;\n';
    const workspace = { id: "fixture", name: "fixture", path: "/fixture" };
    const revision = { commit_id: "a".repeat(40), change_id: "qwerty", description: "Imports fixture" };
    await page.route("**/api/**", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(
      route.request().url().includes("/contents") ? { oldFile: { name: "file.ts", contents: oldContents }, newFile: { name: "file.ts", contents: newContents } }
        : route.request().url().includes("/review?") ? { workspace, selected: revision, revisions: [revision], patch } : [],
    ) }));
  });
  test.afterEach(async () => { await page.close(); });
  test.afterAll(async () => { await browser.close(); });

  test("a mixed import stanza occupies a single summary while business code stays visible", async () => {
    // Given several import changes interleaved with unchanged imports
    // When the review opens
    await page.goto("/workspaces/fixture");
    await page.getByRole("button", { name: "5 Import changes", exact: true }).waitFor();
    // Then folded import lines were never emitted as hidden DOM rows
    await expect(page.locator("[data-content] > [data-line]").filter({ hasText: /^import / })).toHaveCount(0);
  });

  test("expanded imports show deleted, added, and unchanged lines at full size", async () => {
    // Given a folded import stanza
    await page.goto("/workspaces/fixture");

    // When its summary is expanded
    await page.getByRole("button", { name: "5 Import changes", exact: true }).click();
    await expect(page.locator("[data-content] > [data-host-fold-expanded]")).toHaveCount(7);
    const heights = await page.locator("[data-content] > [data-host-fold-expanded]").evaluateAll((rows) => rows.map((row) => row.getBoundingClientRect().height));

    // Then no import line remains hidden by either import or deletion folding
    expect(heights.every((height) => height >= 35)).toBe(true);
  });

  test("imports can be collapsed again without folding the following business change", async () => {
    // Given an expanded import stanza
    await page.goto("/workspaces/fixture");
    const button = page.getByRole("button", { name: "5 Import changes", exact: true });
    await button.click();

    // When the reader closes the stanza
    await button.click();

    // Then the changed business statement remains readable
    await expect(page.locator('[data-line-type="change-addition"]').filter({ hasText: "const body = 2;" })).toBeVisible();
  });

  test("change navigation never moves back into folded imports", async () => {
    // Given the initial cursor on the first business change
    await page.goto("/workspaces/fixture");
    await page.getByRole("button", { name: "5 Import changes", exact: true }).waitFor();

    // When the preceding change is requested
    await page.keyboard.press("p");

    // Then the cursor stays outside the folded import edits
    await expect(page.locator("[data-biff-focused]")).toHaveText("const body = 2;");
  });

  test("line navigation skips folded import rows", async () => {
    // Given the cursor below a collapsed import stanza
    await page.goto("/workspaces/fixture");
    await page.getByRole("button", { name: "5 Import changes", exact: true }).waitFor();

    // When upward navigation reaches the separating blank line and skips Imports
    await page.keyboard.press("k");
    await page.keyboard.press("k");
    await page.keyboard.press("j");

    // Then the next selected readable line is the business addition
    await expect(page.locator("[data-biff-focused]")).toHaveText("const body = 2;");
  });

  test("Enter expands a keyboard-focused import summary", async () => {
    // Given keyboard focus on the Imports button
    await page.goto("/workspaces/fixture");
    const summary = page.getByRole("button", { name: "5 Import changes", exact: true });
    await summary.focus();

    // When it is expanded with Enter
    await summary.press("Enter");

    // Then its underlying imports are available for normal reading
    await expect(summary).toHaveAttribute("aria-expanded", "true");
  });

  test("full source folds a specifier-only hunk with its native leading context", async () => {
    // Given an import whose opening line is outside the patch
    patch = 'diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n@@ -2,2 +2,2 @@\n-  Before,\n+  After,\n } from "module";\n';
    oldContents = 'import {\n  Before,\n} from "module";\n';
    newContents = 'import {\n  After,\n} from "module";\n';

    // When the background source lookup confirms the declaration
    await page.goto("/workspaces/fixture");
    await page.getByRole("button", { name: "2 Import changes", exact: true }).waitFor();

    // Then its separate unchanged-context header is folded into Imports too
    await expect(page.locator("[data-content] > [data-separator-first] [data-unmodified-lines]")).not.toBeVisible();
  });

  test("separate hunks join across proven unchanged imports and expand together", async () => {
    // Given two import hunks separated by eight unchanged imports
    patch = 'diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-import A from "a";\n+import A2 from "a";\n@@ -10 +10 @@\n-import B from "b";\n+import B2 from "b";\n';
    const middle = Array.from({ length: 8 }, (_, index) => `import I${index} from "i${index}";`).join("\n");
    oldContents = `import A from "a";\n${middle}\nimport B from "b";`;
    newContents = `import A2 from "a";\n${middle}\nimport B2 from "b";`;

    // When the shared summary is expanded
    await page.goto("/workspaces/fixture");
    await page.getByRole("button", { name: "4 Import changes", exact: true }).click();

    // Then both imported additions become readable in the same expanded stanza
    await expect(page.locator('[data-content] > [data-line-type="change-addition"]')).toHaveText(['import A2 from "a";', 'import B2 from "b";']);
  });

  test("reload holds the code pane until import classification has finished", async () => {
    // Given the review has loaded once
    await page.goto("/workspaces/fixture");
    await page.getByRole("button", { name: "5 Import changes", exact: true }).waitFor();
    // And full-source lookup is delayed on reload
    const held = Promise.withResolvers<void>();
    await page.route("**/contents", async (route) => { await held.promise; await route.fallback(); });

    try {
      // When source classification is still pending
      const requested = page.waitForRequest((request) => request.url().endsWith("/contents"));
      await page.reload();
      await requested;
      // Then the renderer has not been mounted with unclassified content
      await expect(page.locator("diffs-container")).toHaveCount(0);
    } finally { held.resolve(); }
    await page.getByRole("button", { name: "5 Import changes", exact: true }).waitFor();
  });

  test("the import summary matches the native Unmodified bar width", async () => {
    // Given an import edit after an unchanged non-import line
    patch = 'diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n@@ -2,2 +2,2 @@\n-import A from "a";\n+import B from "b";\n const body = 1;\n';
    oldContents = 'const header = 1;\nimport A from "a";\nconst body = 1;\n';
    newContents = 'const header = 1;\nimport B from "b";\nconst body = 1;\n';

    // When both the native Unmodified bar and import summary are rendered
    await page.goto("/workspaces/fixture");
    await page.getByRole("button", { name: "2 Import changes", exact: true }).waitFor();
    const widthDifference = await page.locator("diffs-container").evaluate((container) => {
      const root = container.shadowRoot!;
      const native = root.querySelector<HTMLElement>("[data-gutter] > [data-separator-first] [data-separator-wrapper]")!;
      const style = getComputedStyle(native);
      const nativeWidth = native.getBoundingClientRect().width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      const fold = root.querySelector<HTMLElement>("[data-gutter] > [data-host-fold] [data-separator-wrapper]")!;
      const foldStyle = getComputedStyle(fold);
      const foldWidth = fold.getBoundingClientRect().width - parseFloat(foldStyle.paddingLeft) - parseFloat(foldStyle.paddingRight);
      return Math.abs(foldWidth - nativeWidth);
    });

    // Then the summary fills the same bar width, including its gutter area
    expect(widthDifference).toBeLessThan(1);
  });

  test("deletions following folded imports retain their own reveal control", async () => {
    // Given imports and business code deleted in one continuous block
    patch = 'diff --git a/file.ts b/file.ts\ndeleted file mode 100644\n--- a/file.ts\n+++ /dev/null\n@@ -1,3 +0,0 @@\n-import Old from "old";\n-\n-const body = true;\n';
    oldContents = 'import Old from "old";\n\nconst body = true;\n';
    newContents = "";

    // When nearby deleted lines are revealed while Imports stays folded
    await page.goto("/workspaces/fixture");
    await page.getByRole("button", { name: "1 Import change", exact: true }).waitFor();
    await page.keyboard.press("d");

    // Then the unrelated deleted statement is still accessible independently
    await expect(page.locator("[data-content] > [data-line]").filter({ hasText: "const body = true;" })).toBeVisible();
  });

  test("the initial selection starts at the first non-import change", async () => {
    // Given a file with several import changes before a business change
    // When the review first loads
    await page.goto("/workspaces/fixture");

    // Then initial automatic selection skips all folded imports
    await expect(page.locator("[data-biff-focused]")).toHaveText("const body = 2;");
  });

  test("initial selection finds business code inside an edit that also changes imports", async () => {
    // Given imports and business code replaced in the same change block
    patch = 'diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n@@ -1,2 +1,2 @@\n-import Old from "old";\n-const body = 1;\n+import New from "new";\n+const body = 2;\n';
    oldContents = 'import Old from "old";\nconst body = 1;\n';
    newContents = 'import New from "new";\nconst body = 2;\n';

    // When the review opens
    await page.goto("/workspaces/fixture");

    // Then the initial cursor still selects the actual business addition
    await expect(page.locator("[data-biff-focused]")).toHaveText("const body = 2;");
  });

  test("change navigation retains business edits inside partially folded change blocks", async () => {
    // Given a later change block contains both imports and business code
    patch = 'diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n@@ -1,4 +1,4 @@\n-const first = 1;\n+const first = 2;\n \n-import Old from "old";\n-const second = 1;\n+import New from "new";\n+const second = 2;\n';
    oldContents = 'const first = 1;\n\nimport Old from "old";\nconst second = 1;\n';
    newContents = 'const first = 2;\n\nimport New from "new";\nconst second = 2;\n';
    await page.goto("/workspaces/fixture");
    await page.locator("[data-biff-focused]").waitFor();

    // When the reader advances to that change
    await page.keyboard.press("n");

    // Then its business code is selected rather than skipping the entire block
    await expect(page.locator("[data-biff-focused]")).toHaveText("const second = 2;");
  });

  test("native context hydration preserves import folding and later expansion", async () => {
    // Given a partial multiline import with its opening outside the patch
    patch = 'diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n@@ -2,2 +2,2 @@\n-  Before,\n+  After,\n } from "module";\n';
    oldContents = 'import {\n  Before,\n} from "module";\nconst body = true;\n';
    newContents = 'import {\n  After,\n} from "module";\nconst body = true;\n';
    await page.goto("/workspaces/fixture");
    await page.getByRole("button", { name: "2 Import changes", exact: true }).waitFor();

    // When native context loading replaces the metadata and the fold is then expanded
    await page.keyboard.press("u");
    await page.locator("[data-content] > [data-line]").filter({ hasText: "const body = true;" }).waitFor();
    await page.getByRole("button", { name: "2 Import changes", exact: true }).click();

    // Then the complete declaration is rendered with its original syntax
    await expect(page.locator("[data-content] > [data-host-fold-expanded]")).toHaveText(["import {", "  Before,", "  After,", '} from "module";']);
  });

  test("other files are prefetched and navigation reuses their source", async () => {
    // Given a review with import changes in two files
    patch = stanzaPatch + stanzaPatch.replaceAll("file.ts", "next.ts");
    let requests = 0;
    await page.route("**/contents", async (route) => {
      requests++;
      await route.fallback();
    });
    const prefetched = page.waitForResponse((response) => response.url().endsWith("/contents") && response.request().postDataJSON().path === "next.ts");

    // When the review opens, the next file finishes loading before it is selected
    await page.goto("/workspaces/fixture");
    await (await prefetched).finished();
    await page.getByRole("button", { name: "5 Import changes", exact: true }).waitFor();
    await page.keyboard.press("l");
    await expect(page.getByLabel("Current file")).toHaveText("next.ts");
    await page.getByRole("button", { name: "5 Import changes", exact: true }).waitFor();

    // Then each file's full source was fetched only once
    expect(requests).toBe(2);
  });

  test("source prefetch limits background concurrency", async () => {
    // Given many files and source responses held in flight
    patch = Array.from({ length: 8 }, (_, index) => stanzaPatch.replaceAll("file.ts", `file${index}.ts`)).join("");
    const held = Promise.withResolvers<void>();
    let requests = 0;
    await page.route("**/contents", async (route) => {
      requests++;
      await held.promise;
      await route.fallback();
    });

    try {
      // When the review starts fetching source
      await page.goto("/workspaces/fixture");

      // Then one foreground request and three background requests start, not all eight
      await expect.poll(() => requests).toBe(4);
    } finally { held.resolve(); }
  });

  test("failed speculative source loading is retried when the file is selected", async () => {
    // Given the next file's first background fetch fails
    patch = stanzaPatch + stanzaPatch.replaceAll("file.ts", "next.ts");
    let attempts = 0;
    await page.route("**/contents", async (route) => {
      if (route.request().postDataJSON().path === "next.ts" && ++attempts === 1) {
        await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Temporary failure" }) });
      } else await route.fallback();
    });
    const failed = page.waitForResponse((response) => response.status() === 503);
    await page.goto("/workspaces/fixture");
    await failed;
    await page.getByRole("button", { name: "5 Import changes", exact: true }).waitFor();

    // When the reader selects that file
    await page.keyboard.press("l");
    await expect(page.getByLabel("Current file")).toHaveText("next.ts");
    await page.getByRole("button", { name: "5 Import changes", exact: true }).waitFor();

    // Then the failed speculative request did not poison the source cache
    expect(attempts).toBe(2);
  });
});
