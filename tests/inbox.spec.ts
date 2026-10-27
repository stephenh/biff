import { chromium, expect, test, type Browser, type Page } from "@playwright/test";
import type { InboxPR, PersonalState } from "../shared/inbox";
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
    const receipts = new Map<string, PersonalState>();
    await page.route("**/api/inbox?*", (route) => route.fulfill({ json: { ...inboxQueue(items), error: refreshError } }));
    await page.route("**/api/github/pr/*/*/*/inbox", async (route) => {
      const number = Number(route.request().url().split("/").at(-2));
      const pr = items.find((entry) => entry.number === number)!;
      const body = route.request().postDataJSON();
      const previous = structuredClone(pr.personal);
      const token = crypto.randomUUID();
      if (body.action === "set") { pr.personal = body.personal; receipts.set(token, previous); }
      if (body.action === "undo") pr.personal = receipts.get(body.token)!;
      await route.fulfill({ json: { item: pr, undo: token, previous } });
    });
  });

  test("Archive hides a PR until the Archived filter is selected", async () => {
    // Given the first PR's action menu
    await page.goto("/prs");
    await page.getByLabel("Actions for PR 1", { exact: true }).click();

    // When the reader archives it and selects Archived
    await page.getByRole("button", { name: "Archive", exact: true }).click();
    await page.getByRole("link", { name: "First PR", exact: true }).waitFor({ state: "hidden" });
    await page.getByRole("link", { name: "Archived 1", exact: true }).click();

    // Then only the archived PR is listed
    await expect(page.locator(".pr-list .card-title")).toHaveText(["First PR"]);
  });

  test("undo restores an archived PR", async () => {
    // Given an archived PR
    await page.goto("/prs");
    await page.getByLabel("Actions for PR 1", { exact: true }).click();
    await page.getByRole("button", { name: "Archive", exact: true }).click();
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

  test("u no longer marks the focused PR unread", async () => {
    // Given an outstanding review without unread replies
    await page.goto("/prs");
    await page.getByRole("link", { name: "First PR", exact: true }).waitFor();

    // When the reader presses the removed shortcut
    await page.keyboard.press("u");

    // Then message unread state is unaffected
    await expect(page.getByRole("link", { name: "Unread 0", exact: true })).toBeVisible();
  });

  test("refreshes update badges without moving focused rows", async () => {
    // Given focus on the second PR
    await page.goto("/prs");
    await page.getByRole("link", { name: "First PR", exact: true }).waitFor();
    await page.keyboard.press("j");

    // When it receives new activity during local polling
    items[1]!.unread = true;
    items[1]!.unreadThreads = 2;
    items[1]!.updatedAt = "2026-10-19T00:00:00Z";
    await page.getByRole("button", { name: "2 unread threads on PR 2", exact: true }).waitFor();

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

  test("A archives the focused PR", async () => {
    // Given focus on the first active PR
    await page.goto("/prs");
    await expect(page.getByRole("link", { name: "First PR", exact: true })).toBeFocused();
    // When the reader archives it
    await page.keyboard.press("Shift+a");
    // Then it joins the archived queue
    await expect(page.getByRole("link", { name: "Archived 1", exact: true })).toBeVisible();
  });

  test("a restores the focused archived PR", async () => {
    // Given a focused archived PR
    items[0]!.personal.archived = true;
    await page.goto("/prs?filter=archived");
    await expect(page.getByRole("link", { name: "First PR", exact: true })).toBeFocused();
    // When the reader restores it
    await page.keyboard.press("a");
    // Then it leaves the archived queue
    await expect(page.getByRole("link", { name: "Archived 0", exact: true })).toBeVisible();
  });

  test("archived PRs are excluded from the active inbox", async () => {
    // Given one archived PR and one active PR
    items[0]!.archivedAt = Date.now();
    items[0]!.state = "MERGED";

    // When the default inbox opens
    await page.goto("/prs");

    // Then only active work is listed
    await expect(page.locator(".pr-list .card-title")).toHaveText(["Second PR"]);
  });

  test("archived history can be searched using the existing PR filter", async () => {
    // Given two archived reviews in the local snapshot
    for (const pr of items) { pr.archivedAt = Date.now(); pr.state = "MERGED"; }
    await page.goto("/prs");

    // When the reader opens Archived and searches by title
    await page.getByRole("link", { name: "Archived 2", exact: true }).click();
    await page.getByLabel("Filter PRs").fill("Second");

    // Then the matching historical review remains available
    await expect(page.locator(".pr-list .card-title")).toHaveText(["Second PR"]);
  });

  test("Enter in the filter focuses the first matching PR", async () => {
    // Given a review queue filtered to the second PR
    await page.goto("/prs?view=requested");
    await page.getByRole("link", { name: "First PR", exact: true }).waitFor();
    await page.getByLabel("Filter PRs").fill("Second");

    // When the reader presses Enter in the filter
    await page.getByLabel("Filter PRs").press("Enter");

    // Then focus moves to the first visible PR
    await expect(page.getByRole("link", { name: "Second PR", exact: true })).toBeFocused();
  });

  test("j continues row navigation after Enter in the filter", async () => {
    // Given a filtered review queue
    await page.goto("/prs?view=requested");
    await page.getByRole("link", { name: "First PR", exact: true }).waitFor();
    await page.getByLabel("Filter PRs").fill("PR");

    // When the reader enters the results and moves down
    await page.getByLabel("Filter PRs").press("Enter");
    await page.keyboard.press("j");

    // Then the next matching PR has focus
    await expect(page.getByRole("link", { name: "Second PR", exact: true })).toBeFocused();
  });

  test("Enter keeps focus in the filter when no PRs match", async () => {
    // Given a review queue with no filter matches
    await page.goto("/prs?view=requested");
    await page.getByRole("link", { name: "First PR", exact: true }).waitFor();
    await page.getByLabel("Filter PRs").fill("No matching PR");

    // When the reader presses Enter in the filter
    await page.getByLabel("Filter PRs").press("Enter");

    // Then the filter retains focus so the reader can change it
    await expect(page.getByLabel("Filter PRs")).toBeFocused();
  });

  test("All includes read history, snoozed PRs, and archives", async () => {
    // Given archived and snoozed PRs with no active Todo rows
    items[0].personal.archived = true;
    items[1].personal.snoozeUntil = Date.now() + 86_400_000;

    // When viewing All
    await page.goto("/prs?filter=all");

    // Then both saved PRs remain accessible
    await expect(page.locator(".pr-list .card-title")).toHaveText(["First PR", "Second PR"]);
  });

  test("status counts span all authors and switching status picks a matching author", async () => {
    // Given one unread author's PR and another author's flagged PR
    items[0].author.login = "alice";
    items[0].unread = true;
    items[1].author.login = "bob";
    items[1].followUpCount = 1;
    await page.goto("/needs-review?author=alice");
    await expect(page.getByRole("link", { name: "Todo 2", exact: true })).toBeVisible();

    // When the primary status is changed to follow-ups
    await page.getByRole("link", { name: "Follow-ups 1", exact: true }).click();

    // Then the secondary author list contains only the matching author
    await expect(page.getByRole("navigation", { name: "Review authors" }).getByRole("link")).toHaveText(["All", /^bob /]);
  });

  test("an archive saves in the background while another PR remains usable", async () => {
    // Given an archive request held by the server
    const held = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    await page.route("**/api/github/pr/example/repo/1/inbox", async (route) => { started.resolve(); await held.promise; await route.fallback(); });
    await page.goto("/prs");
    await page.getByRole("link", { name: "First PR", exact: true }).focus();

    // When archiving before the response arrives
    await page.keyboard.press("a");
    await started.promise;

    // Then the next PR is immediately ready for triage
    await expect(page.getByRole("link", { name: "Second PR", exact: true })).toBeFocused();
    held.resolve();
  });

  test("failed archive restores the row and retries from a different filter", async () => {
    // Given an archive request that will fail after navigation
    const held = Promise.withResolvers<void>();
    let fail = true;
    await page.route("**/api/github/pr/example/repo/1/inbox", async (route) => {
      await held.promise;
      if (fail) return route.fulfill({ status: 500, json: { error: "Archive unavailable" } });
      return route.fallback();
    });
    await page.goto("/prs");
    await page.getByRole("link", { name: "First PR", exact: true }).focus();

    // When archive fails while viewing All, then Retry succeeds
    await page.keyboard.press("a");
    await page.getByRole("link", { name: "All 2", exact: true }).click();
    held.resolve();
    await page.getByRole("button", { name: "Retry", exact: true }).waitFor();
    await expect(page.getByRole("link", { name: "Todo 2", exact: true })).toBeVisible();
    fail = false;
    await page.getByRole("button", { name: "Retry", exact: true }).click();

    // Then the archive is retained after retry
    await expect(page.getByRole("link", { name: "Archived 1", exact: true })).toBeVisible();
  });

  test("archive then restore sends writes in order and retains the latest intent", async () => {
    // Given a held archive and an All view where the row remains accessible
    const held = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const writes: boolean[] = [];
    await page.route("**/api/github/pr/example/repo/1/inbox", async (route) => {
      writes.push(route.request().postDataJSON().personal.archived);
      started.resolve();
      if (writes.length === 1) await held.promise;
      await route.fallback();
    });
    await page.goto("/prs?filter=all");
    await page.getByRole("link", { name: "First PR", exact: true }).focus();

    // When reversing the archive before its response
    await page.keyboard.press("a");
    await started.promise;
    await page.keyboard.press("a");
    await expect(page.getByRole("link", { name: "Archived 0", exact: true })).toBeVisible();
    held.resolve();

    // Then the server receives the archive followed by the latest restore
    await expect.poll(() => writes).toEqual([true, false]);
  });
  test("the archive toast disappears after five seconds", async () => {
    // Given an acknowledged archive action
    await page.clock.install();
    await page.goto("/prs");
    await page.getByLabel("Actions for PR 1", { exact: true }).click();
    await page.getByRole("button", { name: "Archive", exact: true }).click();
    await page.getByRole("button", { name: "Undo", exact: true }).waitFor();

    // When the toast's five-second lifetime passes
    await page.clock.fastForward(5_000);

    // Then the notification disappears
    await expect(page.locator(".inbox-notice")).toHaveCount(0);
  });
  test("recent activity determines order even when an older PR has follow-ups", async () => {
    // Given an older unread PR with follow-ups and a newer PR
    items[0].followUpCount = 1;
    items[0].unread = true;
    items[1].updatedAt = "2026-10-19T00:00:00Z";

    // When the inbox opens
    await page.goto("/prs");

    // Then recent activity is the only ordering priority
    await expect(page.locator(".pr-list .card-title")).toHaveText(["Second PR", "First PR"]);
  });
  test("j keeps the complete final PR row in view", async () => {
    // Given a list longer than the viewport
    items = Array.from({ length: 12 }, (_, index) => inboxPR(index + 1, `PR ${index + 1}`));
    await page.setViewportSize({ width: 1200, height: 600 });
    await page.goto("/prs");
    await page.locator(".pr-list .card-title").first().focus();

    // When moving to the last PR with j
    for (let index = 1; index < items.length; index++) await page.keyboard.press("j");

    // Then the entire selected row is visible
    await expect(page.locator(".pr-card").last()).toBeInViewport({ ratio: 1 });
  });
  test("Needs Review remembers its filter, author, and search on return", async () => {
    // Given a selected author, status filter, and search
    items[0].author.login = "alice";
    items[1].author.login = "bob";
    await page.goto("/needs-review?filter=all&author=bob");
    await page.getByLabel("Filter PRs").fill("PR");
    await expect(page.locator(".pr-list .card-title")).toHaveText(["Second PR"]);

    // When visiting another queue and returning without URL filters
    await page.goto("/prs");
    await page.getByLabel("Filter PRs").fill("First");
    await page.goto("/needs-review");

    // Then the Needs Review selection is restored independently of My PRs
    await expect(page.getByLabel("Filter PRs")).toHaveValue("PR");
    await expect(page.locator('.inbox-filters .active')).toHaveText("All 2");
    await expect(page.locator(".pr-list .card-title")).toHaveText(["Second PR"]);
  });

  test("explicit URL selections override remembered inbox filters", async () => {
    // Given a remembered All filter for Bob
    items[0].author.login = "alice";
    items[1].author.login = "bob";
    await page.goto("/needs-review?filter=all&author=bob");
    await expect(page.locator(".pr-list .card-title")).toHaveText(["Second PR"]);

    // When opening an explicit Todo link for Alice and then returning
    await page.goto("/needs-review?filter=todo&author=alice");
    await expect(page.locator(".pr-list .card-title")).toHaveText(["First PR"]);
    await page.goto("/needs-review");

    // Then the explicit selection becomes the remembered selection
    await expect(page.locator('.inbox-filters .active')).toHaveText("Todo 2");
    await expect(page.locator(".pr-list .card-title")).toHaveText(["First PR"]);
  });
});
