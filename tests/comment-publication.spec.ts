import { chromium, expect, test, type Browser, type Page } from "@playwright/test";
import type { Conversation, DiscussionComment, ReviewDraft } from "../shared/types";

test.describe("Optimistic GitHub publication", () => {
  let browser: Browser;
  let page: Page;
  let held: ReturnType<typeof Promise.withResolvers<void>>;
  let fail: boolean;
  let includePublished: boolean;
  let published: DiscussionComment[];
  let attempts: { id?: string; body: unknown }[];
  const head = "a".repeat(40);

  test.beforeAll(async () => { browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium" }); });
  test.afterAll(async () => { await browser.close(); });
  test.afterEach(async () => { held.resolve(); await page.close(); });
  test.beforeEach(async () => {
    held = Promise.withResolvers<void>();
    fail = false;
    includePublished = false;
    published = [];
    attempts = [];
    let draft: ReviewDraft = { commitId: head, body: "", comments: [], version: 0 };
    const conversation: Conversation = { viewer: "me", comments: [], reviews: [], inline: [
      { id: 1, body: "Existing thread", user: { login: "alice" }, html_url: "", path: "file.ts", line: 2, side: "RIGHT", reviewThread: { id: "T1", resolved: false, canResolve: true, canReopen: true } },
    ] };
    page = await browser.newPage({ baseURL: "http://127.0.0.1:5173", reducedMotion: "reduce" });
    await page.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      let json: unknown = [];
      if (path.endsWith("/review")) json = { pr: { title: "Optimistic publication", user: { login: "author" }, head: { sha: head, ref: "feature" }, base: { sha: "b".repeat(40), ref: "main" } }, commit: "all", commits: [], patch: "diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n@@ -1,2 +1,2 @@\n-old\n+new\n context\n" };
      else if (path.endsWith("/review-draft")) {
        if (route.request().method() === "POST") draft = { ...route.request().postDataJSON(), version: (draft.version ?? 0) + 1 };
        json = draft;
      } else if (path.endsWith("/conversation")) json = { ...conversation, comments: includePublished ? published.filter((comment) => !comment.path && !comment.in_reply_to_id) : [], inline: [...conversation.inline, ...(includePublished ? published.filter((comment) => comment.path || comment.in_reply_to_id) : [])] };
      else if (path.endsWith("/inline-comment") || path.endsWith("/comment")) {
        const body = route.request().postDataJSON();
        attempts.push({ id: route.request().headers()["idempotency-key"], body });
        await held.promise;
        if (fail) return route.fulfill({ status: 503, json: { error: "GitHub unavailable" } });
        const comment: DiscussionComment = { ...(body.comment ?? {}), id: 99 + published.length, body: body.comment?.body ?? body.body, in_reply_to_id: body.replyTo, user: { login: "me" }, html_url: "https://github.com/example/repo/pull/1#comment-99" };
        published.push(comment);
        json = comment;
      } else if (path.endsWith("/discussion")) json = { identity: { id: "fixture" }, threads: [], version: 0 };
      else if (path.endsWith("/viewed")) json = { files: {} };
      else if (path.endsWith("/identity") || path.endsWith("/stack")) json = null;
      await route.fulfill({ json });
    });
    await page.goto("/pr/example/repo/1");
    await page.locator("[data-biff-focused]").waitFor();
  });

  test("a new inline comment appears in the list while its request is held", async () => {
    // Given a new inline submission waiting on GitHub
    await submitInline(page);
    // When file comments opens before acknowledgement
    await page.getByRole("button", { name: /^Comments \(/ }).click();
    // Then the submitted text is visible with pending feedback, not a duplicate review draft
    await expect(page.locator(".file-comment-thread").filter({ hasText: "Immediate inline comment" })).toHaveText(/Saving…Immediate inline comment/);
  });

  test("an open inline thread survives acknowledgement and a stale cached refresh", async () => {
    // Given the optimistic inline thread opened before acknowledgement
    await submitInline(page);
    await page.getByRole("button", { name: /^Comments \(/ }).click();
    await page.locator(".file-comment-thread").filter({ hasText: "Immediate inline comment" }).click();
    // When GitHub acknowledges but conversation reads still omit the published comment
    held.resolve();
    await page.getByRole("button", { name: "Activity: Saved", exact: true }).waitFor();
    // Then the same open thread still contains the acknowledged text
    await expect(page.locator(".overlay-thread .markdown-text")).toHaveText("Immediate inline comment");
  });

  test("a general PR comment appears before the publish response", async () => {
    // Given a PR-wide composer
    await page.getByRole("button", { name: "Review comments", exact: true }).click();
    await page.getByRole("button", { name: "New PR comment", exact: true }).click();
    await page.getByRole("combobox", { name: "Discussion comment", exact: true }).fill("Immediate PR comment");
    // When it is submitted with the request held
    await page.getByRole("button", { name: "Save as Comment", exact: true }).click();
    // Then the comment is already in the conversation list
    await expect(page.locator(".file-comment-thread").filter({ hasText: "Immediate PR comment" })).toBeVisible();
  });

  test("a reply is appended before the publish response", async () => {
    // Given a reply in an existing thread
    await submitReply(page);
    // When the reader returns to that thread while publication is held
    await page.locator(".file-comment-thread").filter({ hasText: "Existing thread" }).click();
    // Then the pending reply is visible after the existing root
    await expect(page.locator(".overlay-thread .markdown-text")).toHaveText(["Existing thread", "Immediate reply"]);
  });

  test("a pending comment survives SPA navigation to another page and back", async () => {
    // Given an inline comment still being published
    await submitInline(page);
    // When the reader navigates away and returns without reloading the app
    await page.getByRole("link", { name: "Working Copies", exact: true }).click();
    await page.goBack();
    await page.getByRole("button", { name: /^Comments \(/ }).click();
    // Then its optimistic text is still available
    await expect(page.locator(".file-comment-thread").filter({ hasText: "Immediate inline comment" })).toBeVisible();
  });

  test("failed publication keeps the submitted text visibly unpublished", async () => {
    // Given a pending reply
    await submitReply(page);
    // When GitHub rejects publication
    fail = true;
    held.resolve();
    await page.getByRole("button", { name: /Activity: .*attention/ }).waitFor();
    // Then the failed text stays visible with a recovery instruction
    await expect(page.locator(".file-comment-thread").filter({ hasText: "Existing thread" })).toHaveText(/Not published · Retry in ActivityImmediate reply/);
  });

  test("Retry publishes the retained immutable text with the same submission ID", async () => {
    // Given a failed reply retained in the list
    await submitReply(page);
    fail = true;
    held.resolve();
    await page.getByRole("button", { name: "Close review comments", exact: true }).click();
    await page.getByRole("button", { name: /Activity: .*attention/ }).click();
    await page.getByRole("button", { name: "Retry", exact: true }).waitFor();
    // When publication becomes available and the user retries
    fail = false;
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await page.getByRole("button", { name: "Activity: Saved", exact: true }).waitFor();
    // Then the exact append intent was retried
    expect(attempts).toEqual([{ id: expect.any(String), body: { body: "Immediate reply", replyTo: 1 } }, attempts[0]]);
  });

  test("a later cached copy replaces the optimistic receipt without duplication", async () => {
    // Given an inline comment acknowledged while the cache still omits it
    await submitInline(page);
    held.resolve();
    await page.getByRole("button", { name: "Activity: Saved", exact: true }).waitFor();
    // When the cache catches up and the reader remounts the review
    includePublished = true;
    await page.getByRole("link", { name: "Working Copies", exact: true }).click();
    await page.goBack();
    await page.getByRole("button", { name: /^Comments \(/ }).click();
    // Then exactly one preview contains the published text
    await expect(page.locator(".file-comment-thread").filter({ hasText: "Immediate inline comment" })).toHaveCount(1);
  });

  test("a general comment also remains visible through a stale post-save read", async () => {
    // Given a submitted PR comment whose cached conversation has not caught up
    await page.getByRole("button", { name: "Review comments", exact: true }).click();
    await page.getByRole("button", { name: "New PR comment", exact: true }).click();
    await page.getByRole("combobox", { name: "Discussion comment", exact: true }).fill("Retain this PR comment");
    await page.getByRole("button", { name: "Save as Comment", exact: true }).click();
    // When publication is acknowledged
    held.resolve();
    await page.getByRole("button", { name: "Activity: Saved", exact: true }).waitFor();
    // Then the acknowledged comment remains in the list
    await expect(page.locator(".file-comment-thread").filter({ hasText: "Retain this PR comment" })).toBeVisible();
  });

  test("two quick replies remain separate optimistic append intents", async () => {
    // Given a reply still waiting for GitHub
    await submitReply(page);
    // When another reply is submitted before the first acknowledgement
    await page.locator(".file-comment-thread").filter({ hasText: "Existing thread" }).click();
    await page.getByRole("combobox", { name: "Thread reply", exact: true }).fill("A second reply");
    await page.getByRole("button", { name: "Save as Comment", exact: true }).click();
    // Then neither append intent replaces the other
    await expect(page.locator(".file-comment-thread").filter({ hasText: "Existing thread" }).locator(".markdown-text")).toHaveText(["Existing thread", "Immediate reply", "A second reply"]);
  });

  test("pending inline comments cannot expose remote edit or delete controls", async () => {
    // Given an optimistic inline comment
    await submitInline(page);
    // When it is opened before acknowledgement
    await page.getByRole("button", { name: /^Comments \(/ }).click();
    await page.locator(".file-comment-thread").filter({ hasText: "Immediate inline comment" }).click();
    // Then publication-dependent edit controls are unavailable
    await expect(page.locator(".comment-edit-actions button")).toHaveCount(0);
  });

  test("deleting a newly acknowledged comment does not resurrect its receipt", async () => {
    // Given a published comment not yet present in cached reads
    await submitInline(page);
    held.resolve();
    await page.getByRole("button", { name: "Activity: Saved", exact: true }).waitFor();
    await page.getByRole("button", { name: /^Comments \(/ }).click();
    await page.locator(".file-comment-thread").filter({ hasText: "Immediate inline comment" }).click();
    // When its author deletes it
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    // Then the optimistic receipt no longer restores the deleted comment
    await expect(page.locator(".file-comment-thread").filter({ hasText: "Immediate inline comment" })).toHaveCount(0);
  });

  test("acknowledgement keeps keyboard focus on the selected pending reply", async () => {
    // Given a pending reply selected in its open thread
    await submitReply(page);
    await page.locator(".file-comment-thread").filter({ hasText: "Existing thread" }).click();
    const message = page.locator("[data-comment-message]").filter({ hasText: "Immediate reply" });
    await message.click();
    // When GitHub assigns the reply its durable ID
    held.resolve();
    await page.getByRole("button", { name: "Activity: Saved", exact: true }).waitFor();
    // Then the reader's focused message does not change
    await expect(message).toBeFocused();
  });

  test("failed publication can retry from the comment browser's own Activity indicator", async () => {
    // Given a failed reply in the still-open review comments browser
    await submitReply(page);
    fail = true;
    held.resolve();
    const dialog = page.getByRole("dialog", { name: "Review comments", exact: true });
    await dialog.getByRole("button", { name: /Activity: .*attention/ }).click();
    // When the user retries without dismissing the browser
    fail = false;
    await dialog.getByRole("button", { name: "Retry", exact: true }).click();
    // Then the same open browser receives the successful acknowledgement
    await expect(dialog.getByRole("button", { name: "Activity: Saved", exact: true })).toBeVisible();
  });
});

/** Submit on the first changed line, which has no existing thread. */
async function submitInline(page: Page) {
  await page.keyboard.press("c");
  await page.getByRole("combobox", { name: "Inline comment", exact: true }).fill("Immediate inline comment");
  await page.getByRole("button", { name: "Save as Comment", exact: true }).click();
}

/** Submit an immutable reply from the shared review-wide browser. */
async function submitReply(page: Page) {
  await page.getByRole("button", { name: "Review comments", exact: true }).click();
  await page.locator(".file-comment-thread").filter({ hasText: "Existing thread" }).click();
  await page.getByRole("combobox", { name: "Thread reply", exact: true }).fill("Immediate reply");
  await page.getByRole("button", { name: "Save as Comment", exact: true }).click();
}
