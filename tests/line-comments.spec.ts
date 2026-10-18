import { readFile } from "node:fs/promises";
import { chromium, expect, test, type Browser, type Page } from "@playwright/test";
import type { ReviewThread } from "../shared/localReview";

test.describe("Line comments", () => {
  let browser: Browser;
  let page: Page;
  let threads: ReviewThread[];
  let readKeys: string[];

  test.beforeAll(async () => { browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium" }); });
  test.afterEach(async () => { await page.close(); });
  test.afterAll(async () => { await browser.close(); });
  test.beforeEach(async () => {
    page = await browser.newPage({ baseURL: "http://127.0.0.1:5173", viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
    const patch = await readFile(new URL("../fixtures/demo.diff", import.meta.url), "utf8");
    const workspace = { id: "fixture", name: "fixture", path: "/fixture" };
    const revision = { commit_id: "a".repeat(40), change_id: "qwerty", description: "Comment fixture" };
    readKeys = [];
    threads = [{ id: "thread", anchor: { path: "src/reviews.ts", line: 3, endLine: 3, side: "RIGHT", commitId: revision.commit_id, excerpt: "" }, resolved: false, humanSequence: 0, messages: [
      { id: "first", sequence: 1, author: "agent", body: "Can we use a named constant here?", createdAt: "2026-10-17T12:00:00Z" },
    ] }];
    await page.route("**/api/**", (route) => {
      const url = route.request().url();
      if (url.endsWith("/comment-reads")) {
        if (route.request().method() === "POST") readKeys = [...new Set([...readKeys, ...route.request().postDataJSON().keys])];
        return route.fulfill({ json: readKeys });
      }
      const data = url.includes("/review?")
        ? { workspace, selected: revision, revisions: [revision], patch, identity: { id: "fixture" } }
        : url.includes("/discussion") ? { identity: { id: "fixture" }, threads, version: 0 } : [];
      return route.fulfill({ json: data });
    });
    await page.goto("/workspaces/fixture");
    await page.locator("[data-biff-focused]").waitFor();
  });

  test("selecting and hovering lines never shows an add-comment button", async () => {
    // Given a selected code line
    const row = page.locator('[data-content] > [data-line-index="4,3"]');
    await row.click();

    // When the pointer moves over another line
    await page.locator('[data-content] > [data-line-index="5,4"]').hover();

    // Then adding comments remains a keyboard-only action
    await expect(page.getByRole("button", { name: /^Add comment on line/ })).toHaveCount(0);
  });

  test("the unread gutter count opens its thread", async () => {
    // Given an unread comment on line three
    const badge = page.getByRole("button", { name: "1 unread comment on line 3", exact: true });

    // When its gutter count is clicked
    await badge.click();

    // Then the comment composer opens
    await expect(page.getByRole("dialog")).toBeVisible();
  });

  test("c opens a comment on the selected line", async () => {
    // Given a selected code line without a thread
    await page.locator('[data-content] > [data-line-index="4,3"]').click();

    // When the comment shortcut is pressed
    await page.keyboard.press("c");

    // Then the comment composer opens
    await expect(page.getByRole("dialog")).toBeVisible();
  });

  test("opened comments stay read after reload", async () => {
    // Given an unread thread
    await page.getByRole("button", { name: "1 unread comment on line 3", exact: true }).click();
    await page.getByRole("button", { name: "1 comment on line 3", exact: true }).waitFor();

    // When the review is reloaded
    await page.reload();

    // Then its gutter displays the total instead of an unread count
    await expect(page.getByRole("button", { name: "1 comment on line 3", exact: true })).toHaveCount(1);
  });

  test("new replies count as unread without recounting older messages", async () => {
    // Given a thread whose original message has been read
    await page.getByRole("button", { name: "1 unread comment on line 3", exact: true }).click();
    await page.getByRole("button", { name: "1 comment on line 3", exact: true }).waitFor();

    // And an agent adds a reply
    threads[0].messages.push({ id: "reply", sequence: 2, author: "agent", body: "Updated the constant.", createdAt: "2026-10-17T12:01:00Z" });

    // When the review loads the reply
    await page.reload();

    // Then only the new reply is counted as unread
    await expect(page.getByRole("button", { name: "1 unread comment on line 3", exact: true })).toHaveAttribute("title", "1 unread · 2 comments");
  });

  test("c opens the selected line's existing thread", async () => {
    // Given a selected line with an unread thread
    await page.getByRole("button", { name: "1 unread comment on line 3", exact: true }).waitFor();
    await page.locator('[data-content] > [data-line-index="3,2"]').click();

    // When the comment shortcut is pressed
    await page.keyboard.press("c");

    // Then the existing comment is shown instead of a new-thread composer
    await expect(page.getByRole("dialog").getByText("Can we use a named constant here?", { exact: true })).toBeVisible();
  });
});
