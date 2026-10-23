import { chromium, expect, test, type Browser, type Page } from "@playwright/test";
import type { Conversation } from "../shared/types";
import { inboxPR } from "./inbox-fixture";

test.describe("Unread comment inbox", () => {
  let browser: Browser;
  let page: Page;
  test.beforeAll(async () => { browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium" }); });
  test.afterAll(async () => { await browser.close(); });
  test.afterEach(async () => { await page.close(); });
  test.beforeEach(async () => {
    page = await browser.newPage({ baseURL: "http://127.0.0.1:5173" });
    let keys: string[] = [];
    const pr = { title: "My change", body: "Description belongs in overview", user: { login: "me" }, head: { sha: "a".repeat(40), ref: "feature" }, base: { sha: "b".repeat(40), ref: "main" } };
    const conversation: Conversation = {
      viewer: "me", comments: [{ id: 3, user: { login: "alice" }, body: "Please update the description", html_url: "" }],
      reviews: [{ id: 4, user: { login: "alice" }, body: "One more concern", state: "COMMENTED", html_url: "" }],
      inline: [{ id: 1, path: "file.ts", line: 1, side: "RIGHT", user: { login: "alice" }, body: "Check this constant", html_url: "", reviewThread: { id: "T1", resolved: false, canResolve: true, canReopen: true } }],
    };
    await page.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith("/comment-reads")) {
        if (route.request().method() === "POST") keys = [...new Set([...keys, ...route.request().postDataJSON().keys])];
        return route.fulfill({ json: keys });
      }
      if (path === "/api/inbox") return route.fulfill({ json: { updatedAt: Date.now(), items: [{ ...inboxPR(1, "My change"), repository: { nameWithOwner: "example/repo" }, author: { login: "me" }, unreadThreads: ["github:1", "general:3", "review:4"].filter((key) => !keys.includes(key)).length }] } });
      if (path.endsWith("/metadata")) return route.fulfill({ json: pr });
      if (path.endsWith("/review")) return route.fulfill({ json: { pr, commit: "all", commits: [], patch: "diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new\n" } });
      if (path.endsWith("/conversation")) return route.fulfill({ json: conversation });
      if (path.endsWith("/thread")) conversation.inline[0].reviewThread!.resolved = route.request().postDataJSON().resolved;
      if (path.endsWith("/discussion")) return route.fulfill({ json: { identity: { id: "fixture" }, threads: [], version: 0 } });
      if (path.endsWith("/identity") || path.endsWith("/stack")) return route.fulfill({ json: null });
      if (path.endsWith("/viewed")) return route.fulfill({ json: { files: {} } });
      return route.fulfill({ json: [] });
    });
  });

  test("dashboard badges use the file-comment browser for all kinds of feedback", async () => {
    // Given a PR with general, review-summary, and inline feedback
    await page.goto("/prs");

    // When its unread badge is opened
    await page.getByRole("button", { name: "3 unread threads on PR 1", exact: true }).click();

    // Then the shared browser presents three thread previews, with no overview content
    await expect(page.getByRole("dialog", { name: "Review comments", exact: true }).locator(".file-comment-thread")).toHaveCount(3);
    await expect(page.getByText("Description belongs in overview", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("combobox", { name: "Review summary", exact: true })).toHaveCount(0);
  });

  test("acknowledging general discussion updates the dashboard after dismissal", async () => {
    // Given the PR-wide comment browser over the inbox
    await openInboxComments(page);
    await openThread(page, "Please update the description");

    // When the general conversation is acknowledged and the modal closed
    await page.getByRole("button", { name: "Mark read", exact: true }).click();
    await page.getByRole("button", { name: "Close review comments", exact: true }).click();

    // Then only the other two conversations remain unread
    await expect(page.getByRole("button", { name: "2 unread threads on PR 1", exact: true })).toBeVisible();
  });

  test("opening a thread does not acknowledge it", async () => {
    // Given an unread inline discussion
    await openInboxComments(page);
    await openThread(page, "Check this constant");

    // When the reader returns through Back and then dismisses the list
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Close review comments", exact: true }).click();

    // Then all conversations still need acknowledgement
    await expect(page.getByRole("button", { name: "3 unread threads on PR 1", exact: true })).toBeVisible();
  });

  test("review author tabs summarize unread conversations", async () => {
    // Given a review author's PR has three conversations to read
    await page.goto("/needs-review");

    // When the author tabs load
    const author = page.getByRole("navigation", { name: "Review authors" }).getByRole("link", { name: /^me / });

    // Then its badge carries the conversation count
    await expect(author.locator(".unread-thread-badge")).toHaveText("3");
  });

  test("an inbox badge opens comments without navigating or loading the diff", async () => {
    // Given a filtered list with diff requests recorded
    const diffRequests: string[] = [];
    page.on("request", (request) => { if (new URL(request.url()).pathname.endsWith("/review")) diffRequests.push(request.url()); });
    await page.goto("/needs-review?author=me");
    await page.getByRole("textbox", { name: "Filter PRs" }).fill("My change");

    // When its unread badge opens the conversation list
    await page.getByRole("button", { name: "3 unread threads on PR 1", exact: true }).click();
    await page.locator(".file-comment-thread").first().waitFor();

    // Then the list remains the underlying route and no diff was requested
    await expect(page).toHaveURL("http://127.0.0.1:5173/needs-review?author=me");
    expect(diffRequests).toEqual([]);
  });

  test("Escape returns focus to the badge and preserves the list filter", async () => {
    // Given comments opened over a filtered inbox
    await page.goto("/prs");
    await page.getByRole("textbox", { name: "Filter PRs" }).fill("My change");
    const badge = page.getByRole("button", { name: "3 unread threads on PR 1", exact: true });
    await badge.click();
    await expect(page.locator(".file-comment-thread").first()).toBeFocused();

    // When the reader dismisses with Escape
    await page.keyboard.press("Escape");

    // Then the prior list position remains ready for keyboard navigation
    await expect(badge).toBeFocused();
    await expect(page.getByRole("textbox", { name: "Filter PRs" })).toHaveValue("My change");
  });

  test("closing and reopening a thread retains its unsent reply", async () => {
    // Given a reply draft in a selected thread
    await openInboxComments(page);
    await openThread(page, "Check this constant");
    await page.getByRole("combobox", { name: "Thread reply", exact: true }).fill("Keep this reply");

    // When the modal closes and the same thread reopens
    await page.getByRole("button", { name: "Close review comments", exact: true }).click();
    await page.getByRole("button", { name: "3 unread threads on PR 1", exact: true }).click();
    await openThread(page, "Check this constant");

    // Then the original reply text remains available
    await expect(page.getByRole("combobox", { name: "Thread reply", exact: true })).toHaveValue("Keep this reply");
  });

  test("a failed background reply can retry after the comment browser closes", async () => {
    // Given a reply request held by the server
    const pending = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const submissions: { body: string; replyTo: number; id: string | undefined }[] = [];
    let fail = true;
    await page.route("**/comment", async (route) => {
      submissions.push({ ...route.request().postDataJSON(), id: route.request().headers()["idempotency-key"] });
      started.resolve();
      await pending.promise;
      await route.fulfill({ status: fail ? 500 : 200, json: fail ? { error: "Reply unavailable" } : { id: 5 } });
    });
    await openInboxComments(page);
    await openThread(page, "Check this constant");
    await page.getByRole("combobox", { name: "Thread reply", exact: true }).fill("My reply");

    // When publishing closes the modal before the failed response arrives
    await page.getByRole("button", { name: "Save as Comment", exact: true }).click();
    await started.promise;
    await expect(page.getByRole("dialog")).toHaveCount(0);
    pending.resolve();
    await page.getByRole("button", { name: "Retry", exact: true }).waitFor();
    fail = false;
    await page.getByRole("button", { name: "Retry", exact: true }).click();

    // Then Retry republishes the same immutable submission, not a second comment
    await expect.poll(() => submissions.length).toEqual(2);
    expect(submissions[1]).toEqual(submissions[0]);
    expect(submissions[0].replyTo).toEqual(1);
  });

  test("reading the final thread returns focus to the PR title when its badge disappears", async () => {
    // Given three unread conversations
    await openInboxComments(page);

    // When each thread is acknowledged and the modal closed
    for (const body of ["Please update the description", "One more concern", "Check this constant"]) {
      await openThread(page, body);
      await page.getByRole("button", { name: "Mark read", exact: true }).click();
      await page.getByRole("button", { name: "Back to review comments", exact: true }).click();
    }
    await expect(page.locator(".unread-thread-trigger")).toHaveCount(0);
    await page.getByRole("button", { name: "Close review comments", exact: true }).click();

    // Then focus returns to the retained PR row rather than the document body
    await expect(page.getByRole("link", { name: "My change", exact: true })).toBeFocused();
  });

  test("the row menu opens all comments after every thread is read", async () => {
    // Given read receipts covering every conversation
    await page.route("**/comment-reads", (route) => route.fulfill({ json: ["github:1", "general:3", "review:4"] }));
    await page.goto("/prs");

    // When Review comments is opened through the row actions
    await page.getByLabel("Actions for PR 1", { exact: true }).click();
    await page.getByRole("button", { name: "Review comments", exact: true }).click();

    // Then read conversations remain available in the same browser
    await expect(page.locator(".file-comment-thread")).toHaveCount(3);
  });

  test("the list retains its scroll position while comments are open", async () => {
    // Given a PR below the fold in a long inbox
    const items = Array.from({ length: 30 }, (_, index) => ({ ...inboxPR(index + 1, `Change ${index + 1}`), repository: { nameWithOwner: "example/repo" }, author: { login: "me" }, unreadThreads: 3 }));
    await page.route("**/api/inbox?**", (route) => route.fulfill({ json: { updatedAt: Date.now(), items } }));
    await page.goto("/prs");
    const badge = page.getByRole("button", { name: "3 unread threads on PR 20", exact: true });
    await badge.scrollIntoViewIfNeeded();
    const scroll = await page.evaluate(() => window.scrollY);

    // When the reader scrolls over the modal backdrop before dismissing
    await badge.click();
    await page.locator(".file-comment-thread").first().waitFor();
    await page.mouse.move(5, 5);
    await page.mouse.wheel(0, 600);
    await page.getByRole("button", { name: "Close review comments", exact: true }).click();

    // Then the list is still at the same PR
    await expect.poll(() => page.evaluate(() => window.scrollY)).toEqual(scroll);
    await expect(badge).toBeFocused();
  });

  test("PR overview contains metadata and review submission without fetching comments", async () => {
    // Given the inbox with comment requests recorded
    const requests: string[] = [];
    page.on("request", (request) => { if (new URL(request.url()).pathname.endsWith("/conversation")) requests.push(request.url()); });
    await page.goto("/prs");

    // When PR overview is opened from the row menu
    await page.getByLabel("Actions for PR 1", { exact: true }).click();
    await page.getByRole("button", { name: "PR overview", exact: true }).click();

    // Then metadata and submission are separate from the comment browser
    await expect(page.getByRole("dialog", { name: "PR overview" }).getByText("Description belongs in overview", { exact: true })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Review summary", exact: true })).toBeVisible();
    expect(requests).toEqual([]);
  });

  test("j, Enter, and Escape navigate the same mounted list and embedded thread", async () => {
    // Given the first thread selected in the review-wide browser
    await openInboxComments(page);
    await expect(page.locator(".file-comment-thread").first()).toBeFocused();

    // When the reader opens the next thread and returns with Escape
    await page.keyboard.press("j");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: "Mark read", exact: true })).toBeFocused();
    await page.keyboard.press("Escape");

    // Then the same second thread is selected in the original modal
    await expect(page.locator(".file-comment-thread").nth(1)).toBeFocused();
    await expect(page.getByRole("dialog")).toHaveCount(1);
  });

  test("the per-file Entire review scope includes PR discussion and review summaries", async () => {
    // Given the same PR open in the diff viewer
    await page.goto("/pr/example/repo/1");
    await page.getByRole("button", { name: /^Comments \(/ }).click();

    // When the file browser switches to the entire review and opens general discussion
    await page.getByRole("button", { name: /^Entire review/ }).click();
    await expect(page.locator(".file-comment-thread")).toHaveCount(3);
    await openThread(page, "Please update the description");

    // Then it uses the same embedded PR conversation and explicit read control
    await expect(page.getByRole("button", { name: "Back to review comments", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Mark read", exact: true })).toBeFocused();
    await expect(page.getByRole("dialog")).toHaveCount(1);
  });

  test("resolution is optimistic and failures remain retryable after dismissal", async () => {
    // Given a resolution request held by the server
    const pending = Promise.withResolvers<void>();
    let fail = true;
    await page.route("**/thread", async (route) => {
      await pending.promise;
      if (fail) return route.fulfill({ status: 500, json: { error: "Resolution unavailable" } });
      return route.fallback();
    });
    await openInboxComments(page);
    const inline = page.locator(".file-comment-thread").filter({ hasText: "Check this constant" });
    await inline.focus();

    // When resolving updates immediately, then fails after closing
    await page.keyboard.press("r");
    await expect(inline).toHaveAttribute("data-resolved", "");
    await page.getByRole("button", { name: "Close review comments", exact: true }).click();
    pending.resolve();
    await page.getByRole("button", { name: "Retry", exact: true }).waitFor();
    fail = false;
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await page.getByRole("button", { name: "3 unread threads on PR 1", exact: true }).click();

    // Then the retried resolution is retained in the reopened browser
    await expect(page.locator(".file-comment-thread").filter({ hasText: "Check this constant" })).toHaveAttribute("data-resolved", "");
  });

  test("opening the full diff sends no PR-level read acknowledgement", async () => {
    // Given a PR with requests to its personal-state endpoint recorded
    const writes: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "POST" && new URL(request.url()).pathname.endsWith("/inbox")) writes.push(request.postData() ?? "");
    });

    // When the visible full diff loads and a thread is opened
    await page.goto("/pr/example/repo/1");
    await page.getByRole("button", { name: /^Comments \(/ }).click();
    await openThread(page, "Check this constant");
    await expect(page.getByRole("button", { name: "Mark read", exact: true })).toBeVisible();

    // Then navigation has not acknowledged PR activity
    expect(writes).toEqual([]);
  });
});

/** Open the inbox's unread-only review browser without navigating away. */
async function openInboxComments(page: Page) {
  await page.goto("/prs");
  await page.getByRole("button", { name: "3 unread threads on PR 1", exact: true }).click();
  await page.locator(".file-comment-thread").first().waitFor();
}

/** Use the same preview entry point as mouse and keyboard users of file comments. */
async function openThread(page: Page, body: string) {
  await page.locator(".file-comment-thread").filter({ hasText: body }).click();
  await page.locator(".comment-detail").waitFor();
}
