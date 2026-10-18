import { chromium, expect, test, type Browser, type Page } from "@playwright/test";
import type { InboxPR } from "../shared/inbox";
import { inboxPR, inboxQueue } from "./inbox-fixture";

test.describe("Personal PR inbox", () => {
  let browser: Browser;
  let page: Page;
  let items: InboxPR[];
  let refreshError: string | undefined;

  test.beforeAll(async () => { browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium" }); });
  test.afterAll(async () => { await browser.close(); });
  test.afterEach(async () => { await page.close(); });
  test.beforeEach(async () => {
    page = await browser.newPage({ baseURL: "http://127.0.0.1:5173" });
    items = [inboxPR(1, "First PR"), inboxPR(2, "Second PR")];
    refreshError = undefined;
    await page.route("**/api/inbox?*", (route) => route.fulfill({ json: { ...inboxQueue(items), error: refreshError } }));
    await page.route("**/api/github/pr/*/*/*/inbox", async (route) => {
      const number = Number(route.request().url().split("/").at(-2));
      const pr = items.find((entry) => entry.number === number)!;
      const body = route.request().postDataJSON() as { action: string };
      if (body.action === "ignore") pr.personal.ignored = true;
      if (body.action === "restore" || body.action === "undo") pr.personal.ignored = false;
      if (body.action === "snooze") pr.personal.snoozeUntil = Date.now() + 86_400_000;
      if (body.action === "unsnooze") pr.personal.snoozeUntil = 0;
      if (body.action === "unread") pr.unread = pr.personal.unread = true;
      if (body.action === "read") pr.unread = pr.personal.unread = false;
      await route.fulfill({ json: { item: pr, undo: "receipt" } });
    });
  });

  test("Ignore hides a PR until the explicit ignored filter is selected", async () => {
    // Given the first PR's action menu
    await page.goto("/prs");
    await page.getByLabel("Actions for PR 1", { exact: true }).click();

    // When the reader ignores it and selects Ignored
    await page.getByRole("button", { name: "Ignore permanently", exact: true }).click();
    await page.getByRole("link", { name: "First PR", exact: true }).waitFor({ state: "hidden" });
    await page.getByRole("link", { name: "Ignored 1", exact: true }).click();

    // Then only the ignored PR is listed
    await expect(page.locator(".pr-list .card-title")).toHaveText(["First PR"]);
  });

  test("undo restores an ignored PR", async () => {
    // Given an ignored PR
    await page.goto("/prs");
    await page.getByLabel("Actions for PR 1", { exact: true }).click();
    await page.getByRole("button", { name: "Ignore permanently", exact: true }).click();
    await page.getByRole("link", { name: "First PR", exact: true }).waitFor({ state: "hidden" });

    // When the reader undoes that action
    await page.getByRole("button", { name: "Undo", exact: true }).click();

    // Then the PR is visible again
    await expect(page.getByRole("link", { name: "First PR", exact: true })).toBeVisible();
  });

  test("snoozing with s focuses the next PR", async () => {
    // Given focus on the first PR
    await page.goto("/prs");
    await page.getByRole("link", { name: "First PR", exact: true }).waitFor();

    // When the reader snoozes it
    await page.keyboard.press("s");

    // Then triage continues on the second PR
    await expect(page.getByRole("link", { name: "Second PR", exact: true })).toBeFocused();
  });

  test("u marks the focused PR unread", async () => {
    // Given a read PR
    await page.goto("/prs");
    await page.getByRole("link", { name: "First PR", exact: true }).waitFor();

    // When the reader toggles it unread
    await page.keyboard.press("u");

    // Then it contributes to the unread queue
    await expect(page.getByRole("link", { name: "Unread 1", exact: true })).toBeVisible();
  });

  test("refreshes update badges without moving focused rows", async () => {
    // Given focus on the second PR
    await page.goto("/prs");
    await page.getByRole("link", { name: "First PR", exact: true }).waitFor();
    await page.keyboard.press("j");

    // When it receives new activity during local polling
    items[1]!.unread = true;
    items[1]!.newReplies = 2;
    items[1]!.updatedAt = "2026-10-19T00:00:00Z";
    await page.getByText("2 new replies", { exact: true }).waitFor();

    // Then the rows retain their order during keyboard navigation
    await expect(page.locator(".pr-list .card-title")).toHaveText(["First PR", "Second PR"]);
  });

  test("a failed refresh leaves cached PRs usable", async () => {
    // Given cached PRs already on screen
    await page.goto("/prs");
    await page.getByRole("link", { name: "First PR", exact: true }).waitFor();

    // When a background refresh reports an outage
    refreshError = "GitHub unavailable";
    await page.getByRole("alert").waitFor();

    // Then the cached queue remains visible
    await expect(page.locator(".pr-list .card-title")).toHaveText(["First PR", "Second PR"]);
  });
  test("S unsnoozes the focused PR", async () => {
    // Given a focused snoozed PR
    items[0]!.personal.snoozeUntil = Date.now() + 86_400_000;
    await page.goto("/prs?filter=snoozed");
    await expect(page.getByRole("link", { name: "First PR", exact: true })).toBeFocused();
    // When the reader toggles snooze off
    await page.keyboard.press("Shift+s");
    // Then it leaves the snoozed queue
    await expect(page.getByRole("link", { name: "Snoozed 0", exact: true })).toBeVisible();
  });

  test("I ignores the focused PR", async () => {
    // Given focus on the first active PR
    await page.goto("/prs");
    await expect(page.getByRole("link", { name: "First PR", exact: true })).toBeFocused();
    // When the reader toggles ignore on
    await page.keyboard.press("Shift+i");
    // Then it joins the ignored queue
    await expect(page.getByRole("link", { name: "Ignored 1", exact: true })).toBeVisible();
  });

  test("i restores the focused ignored PR", async () => {
    // Given a focused ignored PR
    items[0]!.personal.ignored = true;
    await page.goto("/prs?filter=ignored");
    await expect(page.getByRole("link", { name: "First PR", exact: true })).toBeFocused();
    // When the reader toggles ignore off
    await page.keyboard.press("i");
    // Then it leaves the ignored queue
    await expect(page.getByRole("link", { name: "Ignored 0", exact: true })).toBeVisible();
  });
});
