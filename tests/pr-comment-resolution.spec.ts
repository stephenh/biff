import { chromium, expect, test, type Browser, type Page } from "@playwright/test";
import { inboxPR } from "./inbox-fixture";

test.describe("PR comment resolution", () => {
  let browser: Browser;
  let page: Page;
  let choices: Map<number, boolean>;
  let writes: boolean[];
  let hold: Promise<void> | undefined;
  let fail: boolean;

  test.beforeAll(async () => { browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium" }); });
  test.afterAll(async () => { await browser.close(); });
  test.afterEach(async () => { await page.close(); });
  test.beforeEach(async () => {
    page = await browser.newPage({ baseURL: "http://127.0.0.1:5173" });
    choices = new Map();
    writes = [];
    hold = undefined;
    fail = false;
    await page.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/inbox") return route.fulfill({ json: { updatedAt: Date.now(), items: [{ ...inboxPR(1, "My change"), repository: { nameWithOwner: "example/repo" }, author: { login: "me" }, unreadThreads: 1 }] } });
      if (path.endsWith("/metadata")) return route.fulfill({ json: { title: "My change", user: { login: "me" }, head: { sha: "a".repeat(40) }, base: { sha: "b".repeat(40) } } });
      if (path.endsWith("/review-draft")) return route.fulfill({ json: { commitId: "a".repeat(40), body: "", comments: [], version: 0 } });
      if (path.endsWith("/conversation")) return route.fulfill({ json: {
        viewer: "me", reviews: [], inline: [], comments: [
          { id: 1, body: "Linear issue", user: { login: "linear-code[bot]" }, html_url: "" },
          { id: 2, body: "Audit passed", user: { login: "homebound-team-bot" }, html_url: "" },
          { id: 3, body: "Preview deployed", user: { login: "homebound-team-bot" }, html_url: "" },
          { id: 4, body: "Human question", user: { login: "alice" }, html_url: "" },
        ].map((comment) => ({ ...comment, biffResolved: choices.get(comment.id) })),
      } });
      if (path.endsWith("/comment-resolution")) {
        const body = route.request().postDataJSON() as { id: number; resolved: boolean };
        await hold;
        if (fail) return route.fulfill({ status: 503, json: { error: "Resolution unavailable" } });
        choices.set(body.id, body.resolved);
        writes.push(body.resolved);
        return route.fulfill({ json: { resolved: body.resolved } });
      }
      if (path.endsWith("/discussion")) return route.fulfill({ json: { identity: { id: "fixture" }, threads: [], version: 0 } });
      return route.fulfill({ json: [] });
    });
    await page.goto("/prs");
    await page.getByRole("button", { name: "1 unread threads on PR 1", exact: true }).click();
    await page.locator(".file-comment-card").first().waitFor();
  });

  test("the three automated PR comments start collapsed", async () => {
    // Given bot and human PR comments without saved choices
    // When the comment list opens
    // Then only the automated messages are collapsed
    await expect(page.locator(".file-comment-collapsed-body")).toHaveText(["Linear issue", "Audit passed", "Preview deployed"]);
  });

  test("resolving collapses immediately while other comments remain usable", async () => {
    // Given a held resolution request
    const latch = Promise.withResolvers<void>();
    hold = latch.promise;

    // When resolving the human comment and opening another comment
    await page.getByRole("button", { name: "Resolve comment", exact: true }).click();
    await expect(page.locator(".file-comment-collapsed-body")).toHaveText(["Linear issue", "Audit passed", "Preview deployed", "Human question"]);
    await page.locator(".file-comment-thread").filter({ hasText: "Linear issue" }).click();

    // Then the other comment opens before the save completes
    await expect(page.getByRole("button", { name: "Reopen comment", exact: true })).toBeVisible();
    latch.resolve();
  });

  test("rapid resolve and reopen are saved in order", async () => {
    // Given a held initial resolution
    const latch = Promise.withResolvers<void>();
    hold = latch.promise;
    await page.getByRole("button", { name: "Resolve comment", exact: true }).click();
    await page.locator(".file-comment-thread").filter({ hasText: "Human question" }).click();

    // When reopening before the first save finishes
    await page.getByRole("button", { name: "Reopen comment", exact: true }).click();
    latch.resolve();

    // Then the newer reopen follows the earlier resolution
    await expect.poll(() => writes).toEqual([true, false]);
  });

  test("failed resolution rolls back and remains retryable after closing", async () => {
    // Given a rejected resolution
    fail = true;
    await page.getByRole("button", { name: "Resolve comment", exact: true }).click();
    await expect(page.getByRole("button", { name: "Activity: 1 operation needs attention", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Resolve comment", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Close review comments", exact: true }).click();
    // And the server recovers
    fail = false;

    // When retrying from global feedback after the modal unmounts
    await page.getByRole("button", { name: "Activity: 1 operation needs attention", exact: true }).click();
    await page.getByRole("button", { name: "Retry", exact: true }).click();

    // Then the retained intent is saved
    await expect.poll(() => choices.get(4)).toBe(true);
  });

  test("a reopened bot comment remains open after reload", async () => {
    // Given an automatically collapsed comment
    await page.locator(".file-comment-thread").filter({ hasText: "Linear issue" }).click();

    // When reopening it and loading the review again
    await page.getByRole("button", { name: "Reopen comment", exact: true }).click();
    await expect.poll(() => choices.get(1)).toBe(false);
    await page.reload();
    await page.getByRole("button", { name: "1 unread threads on PR 1", exact: true }).click();

    // Then its full body is visible rather than automatically collapsed again
    await expect(page.locator(".file-comment-card .markdown-text")).toHaveText(["Linear issue", "Human question"]);
  });
});
