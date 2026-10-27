import { chromium, expect, test, type Browser, type Page } from "@playwright/test";
import type { PullRequestStatus } from "../shared/types";

test.describe("PR header status", () => {
  let browser: Browser;
  let page: Page;
  let status: PullRequestStatus;
  let failedCheckRequests: number;
  const draft = { commitId: "a".repeat(40), body: "", comments: [], version: 0 };

  test.beforeAll(async () => { browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium" }); });
  test.afterAll(async () => { await browser.close(); });
  test.afterEach(async () => { await page.close(); });
  test.beforeEach(async () => {
    page = await browser.newPage({ baseURL: "http://127.0.0.1:5173" });
    status = { reviewDecision: "REVIEW_REQUIRED", approvers: [], viewerHasApproved: false, checks: "Passing" };
    failedCheckRequests = 0;
    await page.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith("/status")) return route.fulfill({ json: status });
      if (path.endsWith("/failed-checks")) {
        failedCheckRequests++;
        return route.fulfill({ json: [
          { name: "CircleCI / tests", url: "https://app.circleci.com/pipelines/github/example/repo/42/workflows/workflow/jobs/123" },
          { name: "Lint", url: "https://ci.example/lint" },
        ] });
      }
      if (path.endsWith("/review")) return route.fulfill({ json: {
        pr: { number: 22, title: "Expose the review API", body: "", state: "open", user: { login: "author" }, head: { sha: draft.commitId, ref: "feature" }, base: { sha: "b".repeat(40), ref: "main" } },
        commit: "all", commits: [], patch: "",
      } });
      if (path.endsWith("/review-draft")) return route.fulfill({ json: draft });
      if (path.endsWith("/conversation")) return route.fulfill({ json: { viewer: "me", comments: [], reviews: [], inline: [] } });
      if (path.endsWith("/discussion")) return route.fulfill({ json: { threads: [], version: 0 } });
      return route.fulfill({ json: null });
    });
  });

  test("my approval appears beside the title while other required reviews are pending", async () => {
    // Given my approval has not yet satisfied all required reviews
    status = { ...status, approvers: ["me"], viewerHasApproved: true };

    // When the PR is opened directly
    await page.goto("/pr/example/repo/22");

    // Then the header uses the list's green check mark
    await expect(page.locator(".pr-review-heading").getByRole("img", { name: "You approved this PR", exact: true })).toHaveText("✓");
  });

  test("another reviewer's approval uses a light-green check", async () => {
    // Given the PR is approved by someone else
    status = { ...status, reviewDecision: "APPROVED", approvers: ["other"] };
    const loaded = page.waitForResponse("**/status");

    // When its header status finishes loading
    await page.goto("/pr/example/repo/22");
    await loaded;

    // Then the header distinguishes their approval from mine
    await expect(page.locator(".pr-review-heading").getByRole("img", { name: "Approved by someone else", exact: true })).toHaveCSS("color", "rgb(167, 216, 181)");
  });

  test("failing CI appears beside the title", async () => {
    // Given a failing head check
    status = { ...status, checks: "Failing" };

    // When the PR is opened
    await page.goto("/pr/example/repo/22");

    // Then the header uses the list's red cross
    await expect(page.locator(".pr-review-heading").getByRole("button", { name: "CI failing", exact: true })).toHaveText("×");
  });

  test("passing CI has no failure indicator", async () => {
    // Given successful checks
    const loaded = page.waitForResponse("**/status");
    await page.goto("/pr/example/repo/22");

    // When the status response arrives
    await loaded;

    // Then no failure is shown
    await expect(page.locator(".pr-review-heading .pr-ci-failing")).toHaveCount(0);
  });

  test("a published approval updates the header without a page refresh", async () => {
    // Given a review submission held until GitHub acknowledges it
    const release = Promise.withResolvers<void>();
    const submitted = Promise.withResolvers<void>();
    await page.route("**/review", async (route) => {
      submitted.resolve();
      await release.promise;
      status = { ...status, approvers: ["me"], viewerHasApproved: true };
      await route.fulfill({ json: { id: 42, user: { login: "me" }, state: "APPROVED", body: "", biffDraft: draft } });
    });
    await page.goto("/pr/example/repo/22");
    await page.getByRole("button", { name: "PR overview", exact: true }).click();

    // When approval finishes in the background after the overview closes
    await page.getByRole("button", { name: "Approve", exact: true }).click();
    await submitted.promise;
    release.resolve();

    // Then the title reflects the acknowledged approval
    await expect(page.locator(".pr-review-heading").getByRole("img", { name: "You approved this PR", exact: true })).toBeVisible();
  });

  test("an unavailable status does not block the PR review", async () => {
    // Given GitHub status is unavailable
    await page.route("**/status", (route) => route.fulfill({ status: 500, json: { error: "Status unavailable" } }));

    // When the PR is opened
    await page.goto("/pr/example/repo/22");

    // Then the review still loads independently
    await expect(page.getByRole("heading", { name: "No changes", exact: true })).toBeVisible();
  });

  test("an unacknowledged approval does not display a check mark", async () => {
    // Given GitHub has not yet acknowledged the review submission
    const release = Promise.withResolvers<void>();
    const submitted = Promise.withResolvers<void>();
    await page.route("**/review", async (route) => {
      submitted.resolve();
      await release.promise;
      await route.fulfill({ json: { id: 42, user: { login: "me" }, state: "APPROVED", body: "", biffDraft: draft } });
    });
    await page.goto("/pr/example/repo/22");
    await page.getByRole("button", { name: "PR overview", exact: true }).click();

    // When the overview closes while publication is pending
    await page.getByRole("button", { name: "Approve", exact: true }).click();
    await submitted.promise;

    // Then the header does not claim approval before it is durable
    try { await expect(page.locator(".pr-review-heading .pr-approved-check")).toHaveCount(0); }
    finally { release.resolve(); }
  });

  test("my approval takes precedence when other reviewers also approved", async () => {
    // Given both my approval and another reviewer's approval
    status = { ...status, approvers: ["me", "other"], viewerHasApproved: true };

    // When the PR is opened
    await page.goto("/pr/example/repo/22");

    // Then one full-green check represents my completed review
    await expect(page.locator(".pr-review-heading .pr-approved-check")).toHaveCSS("color", "rgb(54, 208, 120)");
  });

  test("another approval is visible even while required reviews are pending", async () => {
    // Given another reviewer approved but required reviews remain
    status = { ...status, approvers: ["other"] };

    // When the PR is opened
    await page.goto("/pr/example/repo/22");

    // Then the light-green check names the approver without claiming all reviews are complete
    await expect(page.locator(".pr-review-heading .pr-approved-check")).toHaveAttribute("title", "Approved by someone else · Awaiting review · Approved by @other");
  });

  test("CI failure details are not fetched until requested", async () => {
    // Given a failing CI summary
    status = { ...status, checks: "Failing" };
    await page.goto("/pr/example/repo/22");

    // When the header finishes rendering without opening failures
    await page.getByRole("button", { name: "CI failing", exact: true }).waitFor();

    // Then loading the PR does not fetch CI job details
    expect(failedCheckRequests).toEqual(0);
  });

  test("clicking the CI cross lists failed jobs", async () => {
    // Given a PR with multiple failing checks
    status = { ...status, checks: "Failing" };
    await page.goto("/pr/example/repo/22");

    // When the red cross is clicked
    await page.getByRole("button", { name: "CI failing", exact: true }).click();

    // Then each failing job is available without another dropdown
    await expect(page.locator(".failed-checks-list a")).toHaveText(["CircleCI / tests↗", "Lint↗"]);
  });

  test("the CI chooser links directly to the provider's failed job", async () => {
    // Given a failing CircleCI check
    status = { ...status, checks: "Failing" };
    await page.goto("/pr/example/repo/22");

    // When the failure chooser opens
    await page.getByRole("button", { name: "CI failing", exact: true }).click();

    // Then the job link points to CircleCI instead of the generic PR page
    await expect(page.getByRole("link", { name: "CircleCI / tests", exact: true })).toHaveAttribute("href", "https://app.circleci.com/pipelines/github/example/repo/42/workflows/workflow/jobs/123");
  });

  test("Escape returns focus to the CI cross", async () => {
    // Given an open CI chooser with focus on a check
    status = { ...status, checks: "Failing" };
    await page.goto("/pr/example/repo/22");
    const trigger = page.getByRole("button", { name: "CI failing", exact: true });
    await trigger.click();
    await page.getByRole("link", { name: "Lint", exact: true }).focus();

    // When the chooser is dismissed
    await page.keyboard.press("Escape");

    // Then review navigation resumes at the cross
    await expect(trigger).toBeFocused();
  });

  test("failed CI lookups can be retried", async () => {
    // Given the first details request fails
    status = { ...status, checks: "Failing" };
    let attempts = 0;
    await page.route("**/failed-checks", (route) => route.fulfill(++attempts === 1
      ? { status: 500, json: { error: "CI unavailable" } }
      : { json: [{ name: "Tests", url: "https://ci.example/tests" }] }));
    await page.goto("/pr/example/repo/22");
    await page.getByRole("button", { name: "CI failing", exact: true }).click();

    // When the reader retries
    await page.getByRole("button", { name: "Retry", exact: true }).click();

    // Then the failed check becomes actionable
    await expect(page.getByRole("link", { name: "Tests", exact: true })).toHaveAttribute("href", "https://ci.example/tests");
  });

  test("a changed CI result offers the full GitHub check list", async () => {
    // Given the previously failing check has since passed
    status = { ...status, checks: "Failing" };
    await page.route("**/failed-checks", (route) => route.fulfill({ json: [] }));
    await page.goto("/pr/example/repo/22");

    // When the stale summary's failure chooser opens
    await page.getByRole("button", { name: "CI failing", exact: true }).click();

    // Then GitHub's complete checks remain available
    await expect(page.getByRole("link", { name: "All checks on GitHub ↗", exact: true })).toHaveAttribute("href", "https://github.com/example/repo/pull/22/checks");
  });
});
