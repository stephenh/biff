import { chromium, expect, test, type Browser, type Page } from "@playwright/test";
import { inboxPR, inboxQueue } from "./inbox-fixture";

test.describe("Navigation shortcuts", () => {
  let browser: Browser;
  let page: Page;

  test.beforeAll(async () => { browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium" }); });
  test.afterAll(async () => { await browser.close(); });
  test.afterEach(async () => { await page.close(); });
  test.beforeEach(async () => {
    page = await browser.newPage({ baseURL: "http://127.0.0.1:5173" });
    await page.route("**/api/**", (route) => route.fulfill({ json: [] }));
    await page.route("**/api/inbox?*", (route) => route.fulfill({ json: inboxQueue([]) }));
  });

  test("g m opens My PRs", async () => {
    // Given the working copies dashboard
    await page.goto("/workspaces");
    await page.getByRole("heading", { name: "Working Copies" }).waitFor();

    // When the go-to-PRs sequence is pressed
    await page.keyboard.press("g");
    await page.keyboard.press("m");

    // Then the PR dashboard opens
    await expect(page).toHaveURL("/prs");
  });

  test("g w opens working copies", async () => {
    // Given the PR dashboard
    await page.goto("/prs");
    await page.getByRole("heading", { name: "My PRs" }).waitFor();

    // When the go-to-working-copies sequence is pressed
    await page.keyboard.press("g");
    await page.keyboard.press("w");

    // Then the working copies dashboard opens
    await expect(page).toHaveURL("/workspaces");
  });

  test("typing a sequence does not navigate", async () => {
    // Given focus in the working copy path field
    await page.goto("/workspaces");
    await page.getByRole("textbox", { name: "Working copy path" }).focus();

    // When the reader types a shortcut sequence
    await page.keyboard.type("gr");

    // Then the dashboard stays open
    await expect(page).toHaveURL("/workspaces");
  });
  test("the PR queue initially focuses the first PR", async () => {
    // Given a queue with two PRs
    await mockPullRequests(page);

    // When the queue opens
    await page.goto("/prs");

    // Then the first PR link has keyboard focus
    await expect(page.getByRole("link", { name: "First PR", exact: true })).toBeFocused();
  });

  test("j and k select a PR that Enter opens", async () => {
    // Given a queue focused on its first PR
    await mockPullRequests(page);
    await page.goto("/prs");
    await page.getByRole("link", { name: "First PR", exact: true }).waitFor();

    // When the reader moves down, up, then down and opens the focused PR
    await page.keyboard.press("j");
    await page.keyboard.press("k");
    await page.keyboard.press("j");
    await page.keyboard.press("Enter");

    // Then the second PR opens
    await expect(page).toHaveURL("/pr/example/repo/2");
  });
  test("g n switches to Needs Review with a PR focused", async () => {
    // Given the authored PR queue
    await mockPullRequests(page);
    await page.route("**/api/inbox?view=requested", (route) => route.fulfill({ json: inboxQueue([inboxPR(3, "Requested PR")]) }));
    await page.goto("/prs");
    await page.getByRole("link", { name: "First PR", exact: true }).waitFor();

    // When the reader uses the go-to sequence from a populated queue
    await page.keyboard.press("g");
    await page.keyboard.press("n");

    // Then the requested queue's first PR receives focus
    await expect(page.getByRole("link", { name: "Requested PR", exact: true })).toBeFocused();
  });

  test("g m switches back to My PRs with a PR focused", async () => {
    // Given the requested PR queue
    await mockPullRequests(page);
    await page.goto("/prs?view=requested");
    await page.getByRole("link", { name: "First PR", exact: true }).waitFor();

    // When the reader uses the go-to sequence
    await page.keyboard.press("g");
    await page.keyboard.press("m");

    // Then the authored queue opens
    await expect(page).toHaveURL("/prs");
  });
  test("g g opens the focused PR on GitHub", async () => {
    // Given the second PR is focused
    await mockPullRequests(page);
    await page.context().route("https://github.com/**", (route) => route.fulfill({ body: "GitHub PR" }));
    await page.goto("/prs");
    await page.getByRole("link", { name: "First PR", exact: true }).waitFor();
    await page.keyboard.press("j");

    // When the reader opens GitHub
    const opened = page.context().waitForEvent("page");
    await page.keyboard.press("g");
    await page.keyboard.press("g");
    const github = await opened;

    // Then the focused PR opens in a new tab
    await expect(github).toHaveURL("https://github.com/example/repo/pull/2");
    await github.close();
  });
  test("Shift+Enter opens the focused PR in a new Biff tab", async () => {
    // Given the second PR is focused
    await mockPullRequests(page);
    await page.context().route("**/api/github/pr/**", (route) => route.fulfill({ status: 503, json: { error: "Review unavailable in queue fixture" } }));
    await page.goto("/prs");
    await page.getByRole("link", { name: "First PR", exact: true }).waitFor();
    await page.keyboard.press("j");

    // When the reader opens the focused PR in a new tab
    const opened = page.context().waitForEvent("page");
    await page.keyboard.press("Shift+Enter");
    const review = await opened;

    // Then the new tab opens the second PR in Biff
    await expect(review).toHaveURL("http://127.0.0.1:5173/pr/example/repo/2");
    const originalSession = await page.context().newCDPSession(page);
    const reviewSession = await page.context().newCDPSession(review);
    const originalWindow = await originalSession.send("Browser.getWindowForTarget");
    const reviewWindow = await reviewSession.send("Browser.getWindowForTarget");
    expect(reviewWindow.windowId).toEqual(originalWindow.windowId);
    await review.close();
  });
  test("author tabs show counts and creation ages, including bots", async () => {
    // Given human requests with different creation dates and a separate bot discovery queue
    await mockAuthors(page);

    // When Needs Review opens
    await page.goto("/needs-review");

    // Then every author has a tab with count and youngest-to-oldest ages
    await expect(page.getByRole("navigation", { name: "Review authors" }).getByRole("link")).toHaveText(["All", "apatterson (2 2m - 9d)", "dependabot (1 1h - 1h)"]);
  });

  test("h and l filter review authors while preserving unread status", async () => {
    // Given unread human and bot reviews
    await mockAuthors(page);
    await page.goto("/needs-review?filter=unread");
    await page.getByRole("link", { name: "Old human PR", exact: true }).waitFor();

    // When the reader moves through the author tabs and back
    await page.keyboard.press("l");
    await page.keyboard.press("l");
    await page.keyboard.press("h");

    // Then only the selected author's unread review is visible
    await expect(page.locator(".pr-list .card-title")).toHaveText(["Old human PR"]);
  });

  test("the bot author tab filters the merged review queue", async () => {
    // Given human and bot review requests
    await mockAuthors(page);
    await page.goto("/needs-review");

    // When the bot author tab is selected
    await page.getByRole("link", { name: "dependabot (1 1h - 1h)", exact: true }).click();

    // Then only the bot review is listed
    await expect(page.locator(".pr-list .card-title")).toHaveText(["Bot PR"]);
  });
  test("go-to hints group destinations under one letter", async () => {
    // Given the working copies dashboard
    await page.goto("/workspaces");

    // When the reader hovers over g
    await page.getByRole("button", { name: "Keyboard shortcuts", exact: true }).click();
    await page.locator(".page-shortcuts .shortcut-key").hover();

    // Then the grouped hint lists the available destinations
    await expect(page.getByRole("tooltip")).toHaveText("g wGo to Working Copiesg mGo to My PRs (also g r)g nGo to Needs Review");
  });

  test("page shortcut registrations are removed after navigation", async () => {
    // Given a PR inbox with row shortcuts
    await mockPullRequests(page);
    await page.goto("/prs");
    await page.keyboard.press("?");
    await page.getByRole("button", { name: "j shortcut", exact: true }).waitFor();

    // When the reader leaves the inbox
    await page.keyboard.press("g");
    await page.keyboard.press("w");

    // Then only the dashboard's go-to key remains
    await expect(page.locator(".page-shortcuts .shortcut-key")).toHaveText(["g"]);
  });
});

/** Use fixed ages to verify creation dates rather than recent activity dates. */
async function mockAuthors(page: Page) {
  const now = new Date("2026-10-23T12:00:00Z");
  await page.clock.setFixedTime(now);
  const old = { ...inboxPR(1, "Old human PR"), author: { login: "apatterson" }, createdAt: new Date(now.getTime() - 9 * 86_400_000).toISOString(), unread: true };
  const recent = { ...inboxPR(2, "New human PR"), author: { login: "apatterson" }, createdAt: new Date(now.getTime() - 120_000).toISOString() };
  const bot = { ...inboxPR(3, "Bot PR"), author: { login: "dependabot" }, createdAt: new Date(now.getTime() - 3_600_000).toISOString(), unread: true };
  await page.route("**/api/inbox?view=requested", (route) => route.fulfill({ json: inboxQueue([old, recent, bot]) }));
}

/** Supply a stable queue without requiring GitHub credentials. */
async function mockPullRequests(page: Page) {
  await page.route("**/api/github/pr/**", (route) => route.fulfill({ status: 503, json: { error: "Review unavailable in queue fixture" } }));
  await page.route("**/api/inbox?*", (route) => route.fulfill({ json: inboxQueue([inboxPR(1, "First PR"), inboxPR(2, "Second PR")]) }));
}
