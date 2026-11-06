import { chromium, expect, test, type Browser, type Page } from "@playwright/test";
import type { Conversation } from "../shared/types";

test.describe("Cached PR reads", () => {
  let browser: Browser;
  let page: Page;
  let snapshot: Conversation;
  let ready: boolean;
  let error: string | undefined;
  let polls: number;
  let retries: number;

  test.beforeAll(async () => { browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium" }); });
  test.afterAll(async () => { await browser.close(); });
  test.afterEach(async () => { await page.close(); });
  test.beforeEach(async () => {
    page = await browser.newPage({ baseURL: "http://127.0.0.1:5173", reducedMotion: "reduce" });
    snapshot = { version: 1, viewer: "me", comments: [{ id: 1, body: "Previously saved feedback", user: { login: "reviewer" }, html_url: "" }], inline: [], reviews: [], commentReads: [] };
    ready = true;
    error = undefined;
    polls = 0;
    retries = 0;
    await page.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      let json: unknown = [];
      if (path.endsWith("/review")) json = { pr: { title: "Cached PR", user: { login: "me" }, head: { sha: "a".repeat(40) }, base: { sha: "b".repeat(40) } }, commit: "all", commits: [], patch: "" };
      else if (path.endsWith("/review-draft")) json = { commitId: "a".repeat(40), body: "", comments: [], version: 0 };
      else if (path.endsWith("/conversation")) {
        polls++;
        if (route.request().method() === "POST") { retries++; error = undefined; ready = true; }
        const sync = { updatedAt: ready ? Date.now() - 600_000 : null, refreshing: !ready && !error, error };
        return route.fulfill({ status: ready ? 200 : 202, json: { ...(ready ? snapshot : {}), sync } });
      }
      else if (path.endsWith("/discussion")) json = { identity: { id: "fixture" }, threads: [], version: 0 };
      else if (path.endsWith("/viewed")) json = { files: {} };
      else if (path.endsWith("/identity") || path.endsWith("/stack")) json = null;
      return route.fulfill({ json });
    });
  });

  test("cached comments stay visible when background revalidation fails", async () => {
    // Given saved feedback and an unsuccessful GitHub refresh
    error = "GitHub offline";
    await page.goto("/pr/example/repo/1?comments=unread");
    await page.getByText("Previously saved feedback", { exact: true }).waitFor();
    // When the reader inspects the failed-refresh status
    await page.getByRole("button", { name: "Activity: 1 operation needs attention", exact: true }).click();
    // Then the existing activity feedback explains the failure without removing cached text
    await expect(page.getByText(/GitHub refresh failed: GitHub offline/)).toBeVisible();
  });

  test("cold preparation is not rendered as an empty conversation", async () => {
    // Given no complete snapshot yet
    ready = false;
    await page.goto("/pr/example/repo/1?comments=unread");
    // When the backend reports initial preparation
    // Then the dialog shows loading rather than claiming there are no comments
    await expect(page.getByRole("dialog").getByText("Loading comments…", { exact: true })).toBeVisible();
  });

  test("local polling installs a completed cold snapshot", async () => {
    // Given a pending initial snapshot
    ready = false;
    await page.goto("/pr/example/repo/1?comments=unread");
    await expect.poll(() => polls).toBeGreaterThan(0);
    // When the background fetch completes
    ready = true;
    // Then the reader sees saved feedback without reopening the view
    await expect(page.getByText("Previously saved feedback", { exact: true })).toBeVisible();
  });

  test("Retry explicitly requests backend revalidation", async () => {
    // Given cached feedback with a failed refresh
    error = "GitHub offline";
    await page.goto("/pr/example/repo/1?comments=unread");
    await page.getByText("Previously saved feedback", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Activity: 1 operation needs attention", exact: true }).click();
    // When the reader retries from the existing activity panel
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    // Then the shared refresh is requested once, instead of merely rereading the failed cache
    await expect.poll(() => retries).toEqual(1);
  });

  test("a newer local snapshot refreshes an open conversation", async () => {
    // Given visible saved feedback
    await page.goto("/pr/example/repo/1?comments=unread");
    await page.getByText("Previously saved feedback", { exact: true }).waitFor();
    // When another background import commits newer text
    snapshot = { ...snapshot, version: 2, comments: [{ ...snapshot.comments[0]!, body: "Updated feedback" }] };
    // Then the existing dialog updates through local polling
    await expect(page.getByText("Updated feedback", { exact: true })).toBeVisible();
  });

  test("an older read cannot replace a newer displayed conversation", async () => {
    // Given a displayed acknowledged version
    snapshot.version = 2;
    await page.goto("/pr/example/repo/1?comments=unread");
    await page.getByText("Previously saved feedback", { exact: true }).waitFor();
    // And an earlier read arrives after that acknowledgment
    const previousPolls = polls;
    snapshot = { ...snapshot, version: 1, comments: [{ ...snapshot.comments[0]!, body: "Obsolete feedback" }] };
    // When local polling receives the obsolete result
    await expect.poll(() => polls).toBeGreaterThan(previousPolls);
    // Then the newer displayed state remains intact
    await expect(page.getByText("Previously saved feedback", { exact: true })).toBeVisible();
  });
});
