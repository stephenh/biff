import { chromium, expect, test, type Browser, type Page } from "@playwright/test";

test.describe("Navigation shortcuts", () => {
  let browser: Browser;
  let page: Page;

  test.beforeAll(async () => { browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium" }); });
  test.afterAll(async () => { await browser.close(); });
  test.afterEach(async () => { await page.close(); });
  test.beforeEach(async () => {
    page = await browser.newPage({ baseURL: "http://127.0.0.1:5173" });
    await page.route("**/api/**", (route) => route.fulfill({ json: [] }));
  });

  test("g r opens the PR dashboard", async () => {
    // Given the working copies dashboard
    await page.goto("/workspaces");
    await page.getByRole("heading", { name: "Working Copies" }).waitFor();

    // When the go-to-PRs sequence is pressed
    await page.keyboard.press("g");
    await page.keyboard.press("r");

    // Then the PR dashboard opens
    await expect(page).toHaveURL("/prs");
  });

  test("g w opens working copies", async () => {
    // Given the PR dashboard
    await page.goto("/prs");
    await page.getByRole("heading", { name: "Pull Requests" }).waitFor();

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
  test("l switches to needs my review and focuses its first PR", async () => {
    // Given the authored PR queue
    await mockPullRequests(page);
    await page.route("**/api/github/prs?view=requested", (route) => route.fulfill({ json: [{
      title: "Requested PR", number: 3, url: "https://github.com/example/repo/pull/3",
      repository: { nameWithOwner: "example/repo" }, author: { login: "teammate" },
      updatedAt: "2026-10-18T00:00:00Z", isDraft: false,
    }] }));
    await page.goto("/prs");
    await page.getByRole("link", { name: "First PR", exact: true }).waitFor();

    // When the reader switches right
    await page.keyboard.press("l");

    // Then the requested queue's first PR receives focus
    await expect(page.getByRole("link", { name: "Requested PR", exact: true })).toBeFocused();
  });

  test("h switches back to my open PRs", async () => {
    // Given the requested PR queue
    await mockPullRequests(page);
    await page.goto("/prs?view=requested");
    await page.getByRole("link", { name: "First PR", exact: true }).waitFor();

    // When the reader switches left
    await page.keyboard.press("h");

    // Then the authored queue opens
    await expect(page).toHaveURL("/prs");
  });
  test("g opens the focused PR on GitHub", async () => {
    // Given the second PR is focused
    await mockPullRequests(page);
    await page.context().route("https://github.com/**", (route) => route.fulfill({ body: "GitHub PR" }));
    await page.goto("/prs");
    await page.getByRole("link", { name: "First PR", exact: true }).waitFor();
    await page.keyboard.press("j");

    // When the reader opens GitHub
    const opened = page.context().waitForEvent("page");
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
    await review.close();
  });
});

/** Supply a stable queue without requiring GitHub credentials. */
async function mockPullRequests(page: Page) {
  await page.route("**/api/github/pr/**", (route) => route.fulfill({ status: 503, json: { error: "Review unavailable in queue fixture" } }));
  await page.route("**/api/github/prs?*", (route) => route.fulfill({ json: ["First PR", "Second PR"].map((title, index) => ({
    title, number: index + 1, url: `https://github.com/example/repo/pull/${index + 1}`,
    repository: { nameWithOwner: "example/repo" }, author: { login: "reviewer" },
    updatedAt: "2026-10-18T00:00:00Z", isDraft: false,
  })) }));
}
