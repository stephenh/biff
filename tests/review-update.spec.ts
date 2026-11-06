import { chromium, expect, test, type Browser, type Page } from "@playwright/test";
import type { ReviewDraft } from "../shared/types";

test.describe("Review update notice", () => {
  let browser: Browser;
  let page: Page;
  let loads: number;
  let head: string;
  let base: string;
  let patch: string;
  let draft: ReviewDraft;
  let saveGate: Promise<void> | undefined;
  const originalHead = "a".repeat(40);
  const originalBase = "b".repeat(40);
  const indicator = "Activity: PR updated: Reload review";

  test.beforeAll(async () => { browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium" }); });
  test.afterAll(async () => { await browser.close(); });
  test.afterEach(async () => { await page.close(); });
  test.beforeEach(async () => {
    page = await browser.newPage({ baseURL: "http://127.0.0.1:5173", reducedMotion: "reduce" });
    loads = 0;
    head = "c".repeat(40);
    base = originalBase;
    patch = "";
    saveGate = undefined;
    draft = { commitId: originalHead, body: "Saved summary", version: 1, comments: [
      { id: "11111111-1111-4111-8111-111111111111", path: "file.ts", side: "RIGHT", line: 1, body: "Saved review comment", commitId: originalHead, baseCommitId: originalBase },
    ] };
    await page.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      let json: unknown = [];
      if (path.endsWith("/review")) {
        loads++;
        json = { pr: { number: 1, title: loads === 1 ? "Original review" : "Updated review", body: "PR description", user: { login: "me" }, state: "open",
          head: { sha: loads === 1 ? originalHead : head, ref: "feature" }, base: { sha: loads === 1 ? originalBase : base, ref: "main" } }, commit: "all", commits: [], patch };
      } else if (path.endsWith("/review-draft")) {
        if (route.request().method() === "POST") {
          const incoming = route.request().postDataJSON() as ReviewDraft;
          await saveGate;
          draft = { ...incoming, version: (draft.version ?? 0) + 1 };
        }
        json = { ...draft, currentHead: head, currentBase: base };
      } else if (path.endsWith("/status")) json = { reviewDecision: "REVIEW_REQUIRED", checks: "Passing" };
      else if (path.endsWith("/conversation")) json = { comments: [], inline: [], reviews: [], viewer: "me" };
      else if (path.endsWith("/discussion")) json = { identity: { id: "fixture" }, version: 0, threads: [] };
      else if (path.endsWith("/viewed")) json = { files: {} };
      else if (path.endsWith("/identity") || path.endsWith("/stack")) json = null;
      await route.fulfill({ json });
    });
  });

  test("a newer head marks the top-nav cloud instead of adding a notice above the diff", async () => {
    // Given a review whose saved draft has observed a newer head
    await page.goto("/pr/example/repo/1");
    // When the comparison mismatch is discovered
    await page.getByRole("button", { name: indicator, exact: true }).waitFor();
    // Then the existing top-nav indicator exposes an update state
    await expect(page.locator(".shell-nav > .activity-slot")).toHaveAttribute("data-activity-state", "notice");
  });

  test("the stale comparison placeholder is removed from the reading surface", async () => {
    // Given a stale comparison
    await page.goto("/pr/example/repo/1");
    // When the cloud has registered the update
    await page.getByRole("button", { name: indicator, exact: true }).waitFor();
    // Then no standalone comparison-changed paragraph interrupts the review
    await expect(page.getByText("This PR comparison changed. Your saved comments are kept; refresh before choosing a new anchor.", { exact: true })).toHaveCount(0);
  });

  test("a base-only update also marks the cloud", async () => {
    // Given the head is unchanged but the comparison base has moved
    head = originalHead;
    base = "d".repeat(40);
    // When the review loads
    await page.goto("/pr/example/repo/1");
    // Then the same update action is available
    await expect(page.getByRole("button", { name: indicator, exact: true })).toBeVisible();
  });

  test("the cloud offers an actionable reload and clears after loading the latest comparison", async () => {
    // Given the update notice in the top navigation
    await page.goto("/pr/example/repo/1");
    await page.getByRole("button", { name: indicator, exact: true }).click();
    // When the reader reloads from Activity
    await page.getByRole("button", { name: "Reload review", exact: true }).click();
    await page.locator(".pr-review-heading strong").filter({ hasText: "Updated review" }).waitFor();
    // Then the obsolete notice is gone
    await expect(page.getByRole("button", { name: indicator, exact: true })).toHaveCount(0);
  });

  test("saved review comments survive the reload action", async () => {
    // Given a saved review comment and a newer comparison
    await page.goto("/pr/example/repo/1");
    await page.getByRole("button", { name: indicator, exact: true }).click();
    // When the reader reloads and reopens their review
    await page.getByRole("button", { name: "Reload review", exact: true }).click();
    await page.locator(".pr-review-heading strong").filter({ hasText: "Updated review" }).waitFor();
    await page.getByRole("button", { name: "PR overview", exact: true }).click();
    // Then the saved comment text remains available
    await expect(page.getByRole("combobox", { name: "Draft comment 1", exact: true })).toHaveValue("Saved review comment");
  });

  test("pending saves disable reload rather than discard the write", async () => {
    // Given a review draft save held in flight
    const held = Promise.withResolvers<void>();
    saveGate = held.promise;
    await page.goto("/pr/example/repo/1");
    await page.getByRole("button", { name: "PR overview", exact: true }).click();
    await page.getByRole("combobox", { name: "Review summary", exact: true }).fill("New unsaved summary");
    await page.getByRole("button", { name: "Close PR overview", exact: true }).click();
    try {
      // When the reader opens the update action before the save finishes
      await page.getByRole("button", { name: indicator, exact: true }).click();
      // Then reload is unavailable while the write is pending
      await expect(page.getByRole("button", { name: "Reload review", exact: true })).toBeDisabled();
    } finally { held.resolve(); }
  });

  test("reload becomes available after the pending draft is acknowledged", async () => {
    // Given a held review draft save
    const held = Promise.withResolvers<void>();
    saveGate = held.promise;
    await page.goto("/pr/example/repo/1");
    await page.getByRole("button", { name: "PR overview", exact: true }).click();
    await page.getByRole("combobox", { name: "Review summary", exact: true }).fill("New saved summary");
    await page.getByRole("button", { name: "Close PR overview", exact: true }).click();
    await page.getByRole("button", { name: indicator, exact: true }).click();
    // When the server acknowledges the write
    held.resolve();
    // Then the update action becomes available without reopening Activity
    await expect(page.getByRole("button", { name: "Reload review", exact: true })).toBeEnabled();
  });

  test("browser-only line-comment text also blocks reload", async () => {
    // Given a line comment that has not been admitted to the saved review draft
    patch = "diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-const value = 1;\n+const value = 2;\n";
    draft.comments = [];
    await page.goto("/pr/example/repo/1");
    await page.locator("[data-biff-focused]").waitFor();
    await page.keyboard.press("c");
    await page.getByRole("combobox", { name: "Inline comment", exact: true }).fill("Keep this unsaved line comment");
    await page.keyboard.press("Escape");
    // When the reader opens the reload action
    await page.getByRole("button", { name: indicator, exact: true }).click();
    // Then reloading cannot silently discard that browser-only text
    await expect(page.getByRole("button", { name: "Reload review", exact: true })).toBeDisabled();
  });
});
