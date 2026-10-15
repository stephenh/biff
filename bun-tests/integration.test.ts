import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { chromium, expect as browserExpect, type Browser, type BrowserContext, type Page, type Route } from "@playwright/test";
import type { ReviewSubmission } from "../shared/types";

const head = "a".repeat(40);
const previous = "b".repeat(40);
interface FixtureState { patch: string; writes: ReviewSubmission[]; rejectReview: boolean; empty: boolean }

describe("integration", () => {
  let server: ReturnType<typeof Bun.spawn>;
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let state: FixtureState;
  const url = "http://127.0.0.1:5175";

  beforeAll(async () => {
    server = Bun.spawn(["bun", "node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "5175", "--strictPort"], { cwd: new URL("..", import.meta.url).pathname, stdout: "ignore", stderr: "inherit" });
    for (let attempt = 0; attempt < 100; attempt++) {
      if (server.exitCode !== null) throw new Error("Integration test server exited");
      try { if ((await fetch(url)).ok) break; } catch { /* Server is starting. */ }
      await Bun.sleep(50);
    }
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium" });
  });
  beforeEach(async () => {
    state = { patch: await Bun.file(new URL("../fixtures/demo.diff", import.meta.url)).text(), writes: [], rejectReview: false, empty: false };
    context = await browser.newContext({ viewport: { width: 1600, height: 1100 }, reducedMotion: "reduce" });
    await context.route("**/api/**", (route) => fixtureResponse(route, state));
    page = await context.newPage();
  });
  afterEach(async () => { await context.close(); });
  afterAll(async () => { await browser?.close(); server?.kill(); await server?.exited; });

  test("working-copy routes retain the revision and support browser history", async () => {
    // Given the working-copy dashboard
    await page.goto(url);
    await page.getByRole("link", { name: "project", exact: true }).click();

    // When the previous revision is selected
    await page.getByLabel("JJ revision").selectOption("@-");

    // Then the selected revision has its own URL and rendered diff
    await browserExpect(page).toHaveURL(`${url}/workspaces/project?rev=%40-`);
    await browserExpect(page.locator("[data-biff-focused]")).toBeVisible();
    await page.goBack();
    await browserExpect(page.getByLabel("JJ revision")).toHaveValue("@");
  });

  test("working copies can open in an independent browser tab", async () => {
    // Given a dashboard entry
    await page.goto(`${url}/workspaces`);

    // When its new-tab link is clicked
    const opened = context.waitForEvent("page");
    await page.getByRole("link", { name: "New tab ↗", exact: true }).click();
    const tab = await opened;

    // Then the new tab loads the same working copy directly
    await browserExpect(tab.getByLabel("Working copy", { exact: true })).toHaveValue("project");
    expect(new URL(page.url()).pathname).toBe("/workspaces");
  });

  test("empty JJ revisions show a normal no-changes state", async () => {
    // Given a working commit without a diff
    state.empty = true;

    // When its direct URL is opened
    await page.goto(`${url}/workspaces/project?rev=@`);

    // Then the revision selector stays usable alongside the empty state
    await browserExpect(page.getByRole("heading", { name: "No changes" })).toBeVisible();
    await browserExpect(page.getByLabel("JJ revision")).toBeEnabled();
  });

  test("PR routes can select an existing commit", async () => {
    // Given a PR opened from the dashboard
    await page.goto(`${url}/prs`);
    await page.getByRole("link", { name: "Improve the viewer", exact: true }).click();

    // When a commit is selected
    await page.getByLabel("PR commit").selectOption(previous);

    // Then the URL and viewer follow that commit
    await browserExpect(page).toHaveURL(`${url}/pr/example/project/12?commit=${previous}`);
    await browserExpect(page.locator("[data-biff-focused]")).toBeVisible();
  });

  test("a review submits the selected new-file line and summary", async () => {
    // Given the first added line in a PR's full diff
    await page.goto(`${url}/pr/example/project/12`);
    await page.locator("[data-biff-focused]").waitFor();
    await page.getByRole("button", { name: "Discussion & review", exact: true }).click();

    // When the reader adds an inline comment and submits a review
    await page.getByLabel("Inline comment", { exact: true }).fill("Please explain this constant.");
    await page.getByRole("button", { name: "Add to review" }).click();
    await page.getByLabel("Review summary").fill("One question.");
    await page.getByRole("button", { name: "Submit review (1 inline)", exact: true }).click();
    await page.getByText("Review submitted to GitHub.", { exact: true }).waitFor();

    // Then the API receives the reviewed SHA and exact line coordinate
    expect(state.writes).toEqual([{ commitId: head, body: "One question.", event: "COMMENT", comments: [{ path: "src/reviews.ts", line: 3, side: "RIGHT", body: "Please explain this constant." }] }]);
  });

  test("a failed GitHub write keeps the draft available for correction", async () => {
    // Given a PR whose review submission will fail
    state.rejectReview = true;
    await page.goto(`${url}/pr/example/project/12`);
    await page.getByRole("button", { name: "Discussion & review", exact: true }).click();
    await page.getByLabel("Review summary").fill("Keep this draft.");

    // When submission fails
    await page.getByRole("button", { name: "Submit review", exact: true }).click();

    // Then the error is shown without clearing the draft
    await browserExpect(page.getByRole("alert")).toHaveText("GitHub rejected this review");
    await browserExpect(page.getByLabel("Review summary")).toHaveValue("Keep this draft.");
  });
});

/** Serve deterministic API responses; browser tests never post to a real PR. */
async function fixtureResponse(route: Route, state: FixtureState) {
  const url = new URL(route.request().url());
  const workspace = { id: "project", name: "project", path: "/repositories/project" };
  const revision = { commit_id: head, change_id: "qwertyui", description: "Update project", author: { name: "Reviewer", email: "reviewer@example.com", timestamp: "2026-10-15T00:00:00Z" } };
  let body: unknown;
  let status = 200;
  if (url.pathname === "/api/workspaces") body = [workspace];
  else if (url.pathname === "/api/workspaces/project/review") body = { workspace, revisions: [revision], selected: revision, patch: state.empty ? "" : state.patch };
  else if (url.pathname === "/api/github/prs") body = [{ number: 12, title: "Improve the viewer", url: "https://github.com/example/project/pull/12", repository: { nameWithOwner: "example/project" }, author: { login: "reviewer" }, isDraft: false, updatedAt: "2026-10-15T00:00:00Z" }];
  else if (url.pathname.endsWith("/conversation")) body = { comments: [], inline: [], reviews: [] };
  else if (url.pathname.endsWith("/review") && route.request().method() === "POST") {
    if (state.rejectReview) { status = 400; body = { error: "GitHub rejected this review" }; }
    else { state.writes.push(route.request().postDataJSON()); body = { id: 42 }; }
  } else if (url.pathname.endsWith("/review")) body = {
    pr: { number: 12, title: "Improve the viewer", body: "A useful change.", html_url: "https://github.com/example/project/pull/12", state: "open", draft: false, user: { login: "reviewer" }, head: { sha: head, ref: "feature" }, base: { sha: previous, ref: "main" } },
    commits: [{ sha: previous, commit: { message: "First commit", author: { name: "Reviewer", date: "2026-10-15" } } }, { sha: head, commit: { message: "Second commit", author: { name: "Reviewer", date: "2026-10-15" } } }],
    patch: state.patch, commit: url.searchParams.get("commit") || "all",
  };
  else { status = 404; body = { error: "Unknown fixture route" }; }
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}
