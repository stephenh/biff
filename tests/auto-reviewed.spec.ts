import { chromium, expect, test, type Browser, type Page } from "@playwright/test";
import type { ChangeIdentity } from "../shared/progress";

test.describe("Automatically reviewed files", () => {
  let browser: Browser;
  let page: Page;
  let patch: string;

  test.beforeAll(async () => { browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium" }); });
  test.afterAll(async () => { await browser.close(); });
  test.afterEach(async () => { await page.close(); });
  test.beforeEach(async () => {
    page = await browser.newPage({ baseURL: "http://127.0.0.1:5173" });
    const workspace = { id: "fixture", name: "fixture", path: "/fixture" };
    const revision = { commit_id: "a".repeat(40), change_id: "qwerty", description: "Generated files" };
    patch = [".history.json", "src/.history.json", "schema.graphql", "yarn.lock", "src/schema.graphql"].map((path) =>
      `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old value\n+new value\n`,
    ).join("");
    await page.route("**/api/**", (route) => route.fulfill({ json:
      route.request().url().includes("/review?") ? { workspace, selected: revision, revisions: [revision], patch } : [],
    }));
    await page.goto("/workspaces/fixture");
    await expect(page.getByRole("progressbar", { name: "Change review progress" })).toHaveAttribute("aria-valuetext", "0 of 1 changes reviewed");
  });

  test("generated files count toward file completion", async () => {
    // Given root schema/lock files, root and nested history files, and one ordinary file
    // When progress loads without saved review marks
    // Then all four generated files are already complete
    await expect(page.getByRole("img", { name: "4 of 5 files reviewed" })).toBeVisible();
  });

  test("all hunks in the lockfile are reviewed automatically", async () => {
    // Given the viewer has skipped to the ordinary file
    // When the reader goes back to the lockfile
    await page.keyboard.press("ArrowLeft");

    // Then its changed hunk is already reviewed
    await expect(page.getByRole("progressbar", { name: "Change review progress" })).toHaveAttribute("aria-valuetext", "1 of 1 changes reviewed");
  });

  test("nested schema files still require review", async () => {
    // Given generated root files precede a nested schema file
    // When the viewer chooses the first unreviewed change
    // Then it skips the root files but keeps the nested file in the review
    await expect(page.getByLabel("Current file")).toHaveAttribute("title", "src/schema.graphql");
  });

  test("nested history hunks are reviewed automatically", async () => {
    // Given the viewer has skipped to the ordinary file
    // When the reader navigates back to the nested history file
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");

    // Then its changed hunk is already reviewed
    await expect(page.getByRole("progressbar", { name: "Change review progress" })).toHaveAttribute("aria-valuetext", "1 of 1 changes reviewed");
  });

  test("overall working-copy progress advances when the remaining file is reviewed", async () => {
    // Given four automatically reviewed hunks and one unreviewed hunk
    await expect(page.getByRole("progressbar", { name: "Overall review progress" })).toHaveAttribute("aria-valuetext", "4 of 5 hunks reviewed");
    await page.route("**/progress", (route) => {
      const body = route.request().postDataJSON() as ChangeIdentity & { blocks: ChangeIdentity[] };
      return route.fulfill({ json: [body, ...body.blocks] });
    });

    // When the reader marks the remaining file reviewed
    await page.getByLabel("File reviewed", { exact: true }).click();

    // Then the shared toolbar reports all hunks complete
    await expect(page.locator(".source-toolbar").getByRole("progressbar", { name: "Overall review progress" })).toHaveAttribute("aria-valuetext", "5 of 5 hunks reviewed");
  });

  test("the PR toolbar shows the same overall hunk counts", async () => {
    // Given the same diff in a PR with no saved review marks
    await page.route("**/api/github/pr/**", (route) => {
      const path = new URL(route.request().url()).pathname;
      let json: unknown = [];
      if (path.endsWith("/review")) json = { pr: { title: "Generated files", head: { sha: "a".repeat(40) }, base: { sha: "b".repeat(40) } }, commit: "all", commits: [], patch };
      else if (path.endsWith("/conversation")) json = { comments: [], inline: [], reviews: [] };
      else if (path.endsWith("/discussion")) json = { identity: { id: "fixture" }, threads: [], version: 0 };
      else if (path.endsWith("/viewed")) json = route.request().method() === "POST" ? { state: "VIEWED" } : { files: {} };
      else if (path.endsWith("/identity") || path.endsWith("/stack")) json = null;
      return route.fulfill({ json });
    });

    // When the PR opens
    await page.goto("/pr/example/repo/1");

    // Then its toolbar uses the same automatically reviewed hunk totals
    await expect(page.locator(".source-toolbar").getByRole("progressbar", { name: "Overall review progress" })).toHaveAttribute("aria-valuetext", "4 of 5 hunks reviewed");
  });
});
