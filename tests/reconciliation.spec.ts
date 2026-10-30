import { chromium, expect, test, type Browser, type Page } from "@playwright/test";
import type { ReconciliationStatus } from "../shared/reconciliation";
import type { ViewedFiles } from "../shared/types";

test.describe("Review reconciliation", () => {
  const head = "a".repeat(40);
  const base = "b".repeat(40);
  let status: ReconciliationStatus;
  let polls: number;
  let viewed: ViewedFiles;
  let browser: Browser;
  let page: Page;

  test.beforeAll(async () => { browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium" }); });
  test.afterAll(async () => { await browser.close(); });
  test.afterEach(async () => { await page.close(); });
  test.beforeEach(async () => {
    page = await browser.newPage({ baseURL: "http://127.0.0.1:5173" });
    polls = 0;
    viewed = { files: {}, syncErrors: [] };
    status = { head, base, state: "running", files: { "first.txt": "ready", "second.txt": "running" } };
    const patch = ["first.txt", "second.txt"].map((path) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n`).join("");
    await page.route("**/api/**", async (route) => {
      const url = new URL(route.request().url());
      const path = url.pathname;
      if (path.endsWith("/reconciliation")) {
        polls++;
        if (route.request().method() === "POST") status = { ...status, state: "ready", files: { "first.txt": "ready", "second.txt": "ready" }, error: undefined };
        return route.fulfill({ json: status });
      }
      if (path.endsWith("/review")) return route.fulfill({ json: path.includes("/github/") ? {
        reconciliation: true, commit: "all", commits: [], patch,
        pr: { number: 1, title: "Progressive fixture", body: "", state: "open", user: { login: "author" }, head: { sha: head, ref: "feature" }, base: { sha: base, ref: "main" } },
      } : { reconciliation: true, workspace: { id: "fixture", name: "fixture" }, selected: { commit_id: head, change_id: "qwerty", description: "Fixture" }, base: { commit_id: base }, revisions: [], patch, progressScope: "review" } });
      if (path.endsWith("/contents")) return route.fulfill({ json: { oldFile: { name: route.request().postDataJSON().path, contents: "old\n" }, newFile: { name: route.request().postDataJSON().path, contents: "new\n" } } });
      if (path.endsWith("/review-draft")) return route.fulfill({ json: { commitId: head, body: "", comments: [], version: 0 } });
      if (path.endsWith("/conversation")) return route.fulfill({ json: { viewer: "me", comments: [], reviews: [], inline: [] } });
      if (path.endsWith("/discussion")) {
        if (url.searchParams.has("events")) return route.fulfill({ contentType: "text/event-stream", body: "" });
        return route.fulfill({ json: { identity: { id: "review" }, threads: [], version: 0 } });
      }
      if (path.endsWith("/viewed")) return route.fulfill({ json: viewed });
      if (path.endsWith("/stack") || path.endsWith("/identity") || path.endsWith("/status")) return route.fulfill({ json: null });
      return route.fulfill({ json: [] });
    });
  });

  for (const route of ["/workspaces/fixture", "/pr/example/repo/1"]) {
    test(`${route} renders ready files, waits on the selected file, and stops at completion`, async () => {
      // Given one ready file and another still reconciling
      await page.goto(route);
      await expect(page.locator("[data-line]").first()).toBeVisible();

      // When navigating to the unfinished file
      await page.getByRole("button", { name: "Open second.txt", exact: true }).click();
      await expect(page.getByLabel("File reviewed", { exact: true })).toBeDisabled();
      await expect(page.locator("[data-line]")).toHaveCount(0);
      status = { ...status, state: "ready", files: { "first.txt": "ready", "second.txt": "ready" } };
      await expect(page.locator("[data-line]").first()).toBeVisible();
      const completedPolls = polls;
      await page.waitForTimeout(2300);

      // Then the selected diff is usable and no further reconciliation polling occurs
      await expect(page.getByLabel("File reviewed", { exact: true })).toBeEnabled();
      expect(polls).toEqual(completedPolls);
    });
  }

  test("failed files retry without reopening the review", async () => {
    // Given a failed current file
    status = { ...status, state: "failed", error: "Source unavailable", files: { "first.txt": "failed", "second.txt": "ready" } };
    await page.goto("/workspaces/fixture");

    // When the reader retries reconciliation
    await page.getByRole("button", { name: "Retry reconciliation" }).click();

    // Then the current diff becomes visible in the same viewer
    await expect(page.locator("[data-line]").first()).toBeVisible();
  });

  test("a different comparison cannot unlock the displayed file", async () => {
    // Given a status response for a newer head
    status = { ...status, head: "c".repeat(40), state: "ready" };

    // When the older displayed comparison polls its PR
    await page.goto("/workspaces/fixture");

    // Then the viewer asks for a refresh instead of treating the stale diff as ready
    await expect(page.getByRole("alert")).toHaveText("This review comparison changed. Refresh the page to load the latest diff. Retry reconciliation");
    await expect(page.locator("[data-line]")).toHaveCount(0);
  });

  test("many Viewed failures occupy one collapsed notice instead of burying the diff", async () => {
    // Given forty files with failed remote Viewed writes
    viewed = { files: {}, syncErrors: Array.from({ length: 40 }, (_, index) => ({ path: `file${index}.ts`, error: "GitHub unavailable" })) };

    // When the PR is opened
    await page.goto("/pr/example/repo/1");

    // Then one compact notice retains details and the diff stays visible
    await expect(page.getByRole("alert")).toHaveCount(1);
    await expect(page.getByText("GitHub Viewed sync needs attention for 40 files", { exact: true })).toBeVisible();
    await expect(page.getByText("file0.ts: GitHub unavailable", { exact: true })).not.toBeVisible();
    await expect(page.locator("[data-line]").first()).toBeInViewport();
  });

  test("a comparison being refreshed shows quiet progress rather than an error", async () => {
    // Given a newer PR comparison discovered during synchronization
    viewed = { files: {}, syncing: true, syncErrors: [] };

    // When the background worker is preparing its new comparison
    await page.goto("/pr/example/repo/1");
    await expect(page.getByText("Updating GitHub Viewed status…", { exact: true })).toBeVisible();

    // Then ordinary synchronization does not appear as a failure
    await expect(page.getByRole("alert")).toHaveCount(0);
  });
});
