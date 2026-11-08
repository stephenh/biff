import { chromium, expect, test, type Browser, type Page } from "@playwright/test";

test.describe("Review range selector", () => {
  let browser: Browser;
  let page: Page;
  const head = "a".repeat(40);
  const base = "b".repeat(40);
  const change = "k".repeat(32);

  test.beforeAll(async () => { browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium" }); });
  test.afterAll(async () => { await browser.close(); });
  test.afterEach(async () => { await page.close(); });
  test.beforeEach(async () => {
    page = await browser.newPage({ baseURL: "http://127.0.0.1:5173" });
    await page.route("**/api/**", async (route) => {
      const url = new URL(route.request().url());
      const path = url.pathname;
      if (path.endsWith("/review") && path.startsWith("/api/github")) return route.fulfill({ json: {
        pr: { number: 1, title: "Keep the review toolbar quiet", body: "", html_url: "https://github.com/example/repo/pull/1", state: "open", user: { login: "author" }, head: { sha: head, ref: "feature" }, base: { sha: base, ref: "main" } },
        commit: url.searchParams.get("commit") ?? "all", commits: [{ sha: head, commit: { message: "A deliberately long commit description that should not widen the inactive All changes control" } }], patch: "",
      } });
      if (path.endsWith("/review")) {
        const revision = { commit_id: head, change_id: change, description: "A deliberately long local commit description" };
        return route.fulfill({ json: { workspace: { id: "fixture", name: "Local fixture", path: "/fixture", vcs: "git" }, selected: revision, revisions: [revision], tip: revision, base: { commit_id: base }, baseLabel: "trunk", bookmark: "feature", bookmarks: ["feature"], changes: url.searchParams.get("changes") ?? "all", patch: "" } });
      }
      if (path.endsWith("/review-draft")) return route.fulfill({ json: { commitId: head, currentHead: head, currentBase: base, body: "", comments: [], version: 0 } });
      if (path.endsWith("/discussion")) return route.fulfill({ json: { identity: { id: "fixture", closed: false }, threads: [], version: 0 } });
      if (path.endsWith("/conversation")) return route.fulfill({ json: { viewer: "me", comments: [], reviews: [], inline: [] } });
      if (path.endsWith("/identity") || path.endsWith("/stack")) return route.fulfill({ json: null });
      if (path.endsWith("/status")) return route.fulfill({ json: { checks: "Passing" } });
      return route.fulfill({ json: [] });
    });
  });

  test("the inactive PR selector looks like compact text instead of a dropdown", async () => {
    // Given a PR with an individual commit available
    await page.goto("/pr/example/repo/1");
    // When the toolbar is displayed without interacting with its range
    const picker = page.getByRole("combobox", { name: "PR commit", exact: true });
    // Then the native dropdown arrow is hidden
    await expect(picker).toHaveCSS("appearance", "none");
    await page.screenshot({ path: "/tmp/opencode/biff-compact-review-range.png" });
  });

  test("long commit options do not reserve toolbar space while All changes is selected", async () => {
    // Given a PR with a long commit description
    await page.goto("/pr/example/repo/1");
    // When the inactive All changes control is measured
    const picker = page.getByRole("combobox", { name: "PR commit", exact: true });
    // Then the visible selection determines its compact width, not the longest option
    expect(await picker.evaluate((select) => select.getBoundingClientRect().width < 100)).toBe(true);
  });

  test("clicking the PR range reveals the normal native dropdown", async () => {
    // Given the compact range label
    await page.goto("/pr/example/repo/1");
    const picker = page.getByRole("combobox", { name: "PR commit", exact: true });
    // When it is clicked
    await picker.click();
    // Then the native dropdown treatment appears for choosing a commit
    await expect(picker).toHaveCSS("appearance", "auto");
    await page.keyboard.press("Escape");
  });

  test("choosing a PR commit returns the selector to compact text", async () => {
    // Given the focused native dropdown
    await page.goto("/pr/example/repo/1");
    const picker = page.getByRole("combobox", { name: "PR commit", exact: true });
    await picker.focus();
    // When an individual commit is chosen
    await picker.selectOption(head);
    await expect(page).toHaveURL(`http://127.0.0.1:5173/pr/example/repo/1?commit=${head}`);
    // Then the selected revision is presented as compact text again
    await expect(picker).toHaveCSS("appearance", "none");
  });

  test("keyboard focus exposes the native commit control", async () => {
    // Given a compact PR range label
    await page.goto("/pr/example/repo/1");
    const picker = page.getByRole("combobox", { name: "PR commit", exact: true });
    // When keyboard focus reaches it
    await picker.focus();
    // Then keyboard users receive the same native dropdown affordance
    await expect(picker).toHaveCSS("appearance", "auto");
  });

  test("the local All changes selector also starts compact", async () => {
    // Given a local branch review
    await page.goto("/workspaces/fixture");
    // When its range selector is idle
    const picker = page.getByRole("combobox", { name: "Changes", exact: true });
    // Then it uses the same text-link treatment as a PR
    await expect(picker).toHaveCSS("appearance", "none");
  });

  test("choosing a local revision preserves the range and returns to compact text", async () => {
    // Given a local branch review with its range control focused
    await page.goto("/workspaces/fixture");
    const picker = page.getByRole("combobox", { name: "Changes", exact: true });
    await picker.focus();
    // When a local revision is chosen
    await picker.selectOption(change);
    await expect(page).toHaveURL(`http://127.0.0.1:5173/workspaces/fixture?bookmark=feature&changes=${change}`);
    // Then the local selector collapses without trapping keyboard focus
    await expect(picker).toHaveCSS("appearance", "none");
  });

  test("the compact range still fits on a narrow screen", async () => {
    // Given a narrow viewport
    await page.setViewportSize({ width: 540, height: 900 });
    // When the PR toolbar loads
    await page.goto("/pr/example/repo/1");
    const picker = page.getByRole("combobox", { name: "PR commit", exact: true });
    // Then its text control remains reachable without opening another menu
    await expect(picker).toBeInViewport();
    await page.screenshot({ path: "/tmp/opencode/biff-compact-review-range-narrow.png" });
  });

  test("the PR range appears immediately after the repository and PR link", async () => {
    // Given a PR review
    await page.goto("/pr/example/repo/1");
    // When its metadata row is displayed
    const picker = page.locator(".review-metadata > .pr-github-link + .review-range-select");
    // Then All changes follows the PR link rather than occupying the action toolbar
    await expect(picker).toHaveAccessibleName("PR commit");
  });

  test("the local range appears immediately after the working-copy name", async () => {
    // Given a local branch review
    await page.goto("/workspaces/fixture");
    // When its metadata row is displayed
    const picker = page.locator(".review-metadata > .muted + .review-range-select");
    // Then All changes follows the working-copy name
    await expect(picker).toHaveAccessibleName("Changes");
  });

  test("the local base follows All changes in the metadata row", async () => {
    // Given a working-copy review based on trunk
    await page.goto("/workspaces/fixture");
    // When its metadata row is displayed
    const baseLabel = page.locator(".review-metadata > .review-range-select + span");
    // Then the base sits immediately after the range selector
    await expect(baseLabel).toHaveText("Base: trunk");
    await page.screenshot({ path: "/tmp/opencode/biff-local-review-metadata.png" });
  });

  test("the local commit follows the base in the metadata row", async () => {
    // Given a working-copy review at a known commit
    await page.goto("/workspaces/fixture");
    // When its metadata row is displayed
    const commitLabel = page.locator(".review-metadata > .review-range-select + span + span");
    // Then the abbreviated commit stays beside the base rather than in the action toolbar
    await expect(commitLabel).toHaveText(head.slice(0, 8));
  });

  test("local metadata wraps within a narrow toolbar", async () => {
    // Given a narrow screen
    await page.setViewportSize({ width: 540, height: 900 });
    // When a working-copy review displays its range, base, and commit
    await page.goto("/workspaces/fixture");
    await page.getByRole("combobox", { name: "Changes", exact: true }).waitFor();
    // Then the toolbar fits without horizontal overflow
    expect(await page.locator(".source-toolbar").evaluate((toolbar) => toolbar.scrollWidth <= toolbar.clientWidth)).toBe(true);
    await page.screenshot({ path: "/tmp/opencode/biff-local-review-metadata-narrow.png" });
  });
});
