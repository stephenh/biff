import { chromium, expect, test, type Browser, type Page } from "@playwright/test";
import type { ReviewDraft } from "../shared/types";

test.describe("Staged review comment deletion", () => {
  let browser: Browser;
  let page: Page;
  let draft: ReviewDraft;
  let held: ReturnType<typeof Promise.withResolvers<void>>;
  let fail: boolean;
  const head = "a".repeat(40);
  const base = "b".repeat(40);

  test.beforeAll(async () => { browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium" }); });
  test.afterAll(async () => { await browser.close(); });
  test.beforeEach(async () => {
    page = await browser.newPage({ baseURL: "http://127.0.0.1:5173", viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
    held = Promise.withResolvers<void>();
    fail = false;
    draft = { commitId: head, body: "Keep the review summary", version: 1, comments: [
      { id: "first", path: "file.ts", line: 1, side: "RIGHT", body: "Delete this staged comment", commitId: head, baseCommitId: base },
      { id: "second", path: "file.ts", line: 2, side: "RIGHT", body: "Keep this staged comment", commitId: head, baseCommitId: base },
    ] };
    await page.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      let json: unknown = [];
      if (path.endsWith("/review")) json = { pr: { number: 1, title: "Staged comments", user: { login: "author" }, head: { sha: head, ref: "feature" }, base: { sha: base, ref: "main" } }, commit: "all", commits: [],
        patch: "diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n@@ -1,3 +1,3 @@\n-old\n+new\n context\n untouched\n" };
      else if (path.endsWith("/review-draft")) {
        if (route.request().method() === "POST") {
          const incoming = route.request().postDataJSON() as ReviewDraft;
          await held.promise;
          if (fail) return route.fulfill({ status: 503, json: { error: "Draft save unavailable" } });
          draft = { ...incoming, version: (draft.version ?? 0) + 1 };
        }
        json = draft;
      } else if (path.endsWith("/conversation")) json = { viewer: "me", comments: [], reviews: [], inline: [] };
      else if (path.endsWith("/discussion")) json = { identity: { id: "fixture" }, threads: [], version: 0 };
      else if (path.endsWith("/viewed")) json = { files: {} };
      else if (path.endsWith("/identity") || path.endsWith("/stack")) json = null;
      await route.fulfill({ json });
    });
    await page.goto("/pr/example/repo/1");
    await page.locator("[data-biff-focused]").waitFor();
  });

  test.afterEach(async () => { held.resolve(); await page.close(); });

  test("deletion closes the modal and updates the list before the save completes", async () => {
    // Given a saved review comment opened from the review-wide list
    await openDraft(page);
    await page.screenshot({ path: "/tmp/opencode/biff-review-comment-delete-desktop.png" });
    // When its staged text is deleted with the save held
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByRole("button", { name: "Review comments", exact: true }).click();
    // Then unrelated comments remain usable without waiting for persistence
    await expect(page.locator(".file-comment-thread .markdown-text")).toHaveText("Keep this staged comment");
  });

  test("deletion persists without removing the summary or other staged comments", async () => {
    // Given an open saved review comment
    await openDraft(page);
    // When deletion is acknowledged and the page reloads
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    held.resolve();
    await page.getByRole("button", { name: "Activity: Saved", exact: true }).waitFor();
    await page.reload();
    await page.getByRole("button", { name: "PR overview", exact: true }).click();
    // Then only the selected comment was removed from the saved draft
    expect(draft).toEqual({ commitId: head, body: "Keep the review summary", version: 2, comments: [
      { id: "second", path: "file.ts", line: 2, side: "RIGHT", body: "Keep this staged comment", commitId: head, baseCommitId: base },
    ] });
  });

  test("failed deletion restores the comment after the modal closes", async () => {
    // Given a staged deletion rejected by the server
    await openDraft(page);
    fail = true;
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    held.resolve();
    await page.getByRole("button", { name: /Activity: .*attention/ }).waitFor();
    // When the comments browser opens again
    await page.getByRole("button", { name: "Review comments", exact: true }).click();
    // Then the acknowledged comment is restored rather than silently lost
    await expect(page.locator(".file-comment-thread .markdown-text")).toHaveText(["Delete this staged comment", "Keep this staged comment"]);
  });

  test("Retry completes a failed deletion after leaving the review", async () => {
    // Given a failed deletion whose modal has closed
    await openDraft(page);
    fail = true;
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    held.resolve();
    await page.getByRole("button", { name: /Activity: .*attention/ }).waitFor();
    // And the reader navigates away from the review
    await page.getByRole("button", { name: "Biff menu", exact: true }).click();
    await page.getByRole("link", { name: "Working Copies", exact: true }).click();
    // When persistence recovers and the retained operation is retried
    fail = false;
    await page.getByRole("button", { name: /Activity: .*attention/ }).click();
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await page.getByRole("button", { name: "Activity: Saved", exact: true }).waitFor();
    await page.goBack();
    await page.getByRole("button", { name: "Review comments", exact: true }).click();
    // Then the deleted comment is absent after remounting
    await expect(page.locator(".file-comment-thread .markdown-text")).toHaveText("Keep this staged comment");
  });

  test("a new unsaved comment does not expose a staged deletion action", async () => {
    // Given a fresh composer rather than a saved review comment
    await page.keyboard.press("j");
    await page.keyboard.press("j");
    await page.keyboard.press("c");
    // When its actions are shown
    await page.getByRole("combobox", { name: "Inline comment", exact: true }).waitFor();
    // Then no staged comment can be deleted
    await expect(page.getByRole("button", { name: "Delete", exact: true })).toHaveCount(0);
  });

  test("the saved-comment Delete CTA fits a narrow modal", async () => {
    // Given a saved review comment on a narrow screen
    await page.setViewportSize({ width: 540, height: 900 });
    await openDraft(page);
    // When the modal actions are laid out
    await page.screenshot({ path: "/tmp/opencode/biff-review-comment-delete-narrow.png" });
    // Then the Delete CTA stays within the modal
    expect(await page.locator(".comment-overlay").evaluate((dialog) => dialog.scrollWidth <= dialog.clientWidth)).toBe(true);
  });

  test("two quick deletions save in order without restoring another comment", async () => {
    // Given the first staged comment is deleted while its save is held
    await openDraft(page);
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    // When the remaining comment is deleted before the first save completes
    await page.getByRole("button", { name: "Review comments", exact: true }).click();
    await page.locator(".file-comment-thread").filter({ hasText: "Keep this staged comment" }).click();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    held.resolve();
    await page.getByRole("button", { name: "Activity: Saved", exact: true }).waitFor();
    // Then both deletion intents reached the saved draft
    expect(draft.comments).toEqual([]);
  });

  test("a failed removal preserves text edited while the save was pending", async () => {
    // Given a staged deletion waiting on persistence
    await openDraft(page);
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    // And a newer summary edit made while that request is pending
    await page.getByRole("button", { name: "PR overview", exact: true }).click();
    await page.getByRole("combobox", { name: "Review summary", exact: true }).fill("Keep my newer summary");
    // When the queued saves fail
    fail = true;
    held.resolve();
    await page.getByRole("button", { name: /Activity: .*attention/ }).waitFor();
    // Then rollback does not erase the newer summary draft
    await expect(page.getByRole("combobox", { name: "Review summary", exact: true })).toHaveValue("Keep my newer summary");
  });
});

/** Open a staged comment through the same path as the PR-wide comments browser. */
async function openDraft(page: Page) {
  await page.getByRole("button", { name: "Review comments", exact: true }).click();
  await page.locator(".file-comment-thread").filter({ hasText: "Delete this staged comment" }).click();
  await page.getByRole("dialog", { name: "Review comment", exact: true }).waitFor();
}
