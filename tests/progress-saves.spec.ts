import { chromium, expect, test, type Browser, type Page } from "@playwright/test";
import { matchesChange, type ChangeIdentity, type ReviewedChange } from "../shared/progress";

test.describe("Progress saves", () => {
  let records: ReviewedChange[];
  let hold: Promise<void> | undefined;
  let fail: boolean;
  let patch: string;
  let browser: Browser;
  let page: Page;
  const head = "a".repeat(40);

  test.beforeAll(async () => { browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium" }); });
  test.afterAll(async () => { await browser.close(); });
  test.afterEach(async () => { await page.close(); });
  test.beforeEach(async () => {
    page = await browser.newPage({ baseURL: "http://127.0.0.1:5173" });
    records = [];
    hold = undefined;
    fail = false;
    const workspace = { id: "fixture", name: "fixture", path: "/fixture" };
    const revision = { commit_id: head, change_id: "qwerty", description: "Progress fixture" };
    patch = ["first.ts", "second.ts"].map((path) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n`).join("");
    await page.route("**/api/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith("/progress")) {
        if (route.request().method() === "POST") {
          const body = route.request().postDataJSON() as { changes: { identity: ChangeIdentity; reviewed: boolean }[] };
          if (body.changes.some((change) => change.identity.path === "first.ts")) await hold;
          if (fail) return route.fulfill({ status: 503, json: { error: "Progress unavailable" } });
          for (const change of body.changes) {
            records = records.filter((record) => !matchesChange(record, change.identity));
            if (change.reviewed) records.push({ ...change.identity, head, reviewedAt: "now" });
          }
        }
        return route.fulfill({ json: records });
      }
      if (url.pathname.endsWith("/review")) return route.fulfill({ json: { workspace, selected: revision, revisions: [revision], patch } });
      return route.fulfill({ json: [] });
    });
    await page.goto("/workspaces/fixture");
    await expect(page.getByLabel("File reviewed", { exact: true })).toBeEnabled();
  });

  test("Space advances to the next file while its approval is held", async () => {
    // Given a save held by the server
    const latch = Promise.withResolvers<void>();
    hold = latch.promise;

    // When the reader completes the first file's only hunk
    await page.keyboard.press("Space");

    // Then navigation has already advanced before the save finishes
    await expect(page.getByLabel("Current file")).toHaveAttribute("title", "second.ts");
    latch.resolve();
  });

  test("file completion is checked before the save finishes", async () => {
    // Given a held file approval
    const latch = Promise.withResolvers<void>();
    hold = latch.promise;

    // When marking the file reviewed
    await page.getByLabel("File reviewed", { exact: true }).check();

    // Then its derived checkbox immediately reflects the pending hunk approvals
    await expect(page.getByLabel("File reviewed", { exact: true })).toBeChecked();
    latch.resolve();
  });

  test("a rapid reversal saves after the held approval", async () => {
    // Given the initial file approval is held
    const latch = Promise.withResolvers<void>();
    hold = latch.promise;
    await page.getByLabel("File reviewed", { exact: true }).check();

    // When it is cleared before that request completes
    await page.getByLabel("File reviewed", { exact: true }).uncheck();
    latch.resolve();
    await expect(page.getByRole("button", { name: "Activity: Saved", exact: true })).toBeVisible();

    // Then the final durable state has no approvals
    expect(records).toEqual([]);
  });

  test("another file can save while the first file is held", async () => {
    // Given a held save on the first file
    const latch = Promise.withResolvers<void>();
    hold = latch.promise;
    await page.keyboard.press("Space");
    await expect(page.getByLabel("Current file")).toHaveAttribute("title", "second.ts");

    // When the next file is completed
    await page.keyboard.press("Space");

    // Then its approval is durable independently of the first file
    await expect.poll(() => records.map((record) => record.path)).toEqual(["second.ts"]);
    latch.resolve();
  });

  test("failure rolls back the checkbox and Retry replays the approval", async () => {
    // Given a rejected save
    fail = true;
    await page.getByLabel("File reviewed", { exact: true }).click();
    await page.getByRole("button", { name: "Activity: 1 operation needs attention", exact: true }).click();
    await expect(page.getByText("Progress unavailable", { exact: false })).toBeVisible();
    await expect(page.getByLabel("File reviewed", { exact: true })).not.toBeChecked();
    // And the server recovers
    fail = false;

    // When the reader retries the saved intent
    await page.getByRole("button", { name: "Retry", exact: true }).click();

    // Then the original hunk approval is durably saved
    await expect.poll(() => records.map((record) => record.path)).toEqual(["first.ts"]);
  });

  test("pending progress and Retry survive leaving the review", async () => {
    // Given a held save followed by SPA navigation away from the viewer
    const latch = Promise.withResolvers<void>();
    hold = latch.promise;
    await page.getByLabel("File reviewed", { exact: true }).check();
    await page.getByRole("link", { name: "Working Copies", exact: true }).click();
    // And the save fails after the viewer unmounts
    fail = true;
    latch.resolve();
    await page.getByRole("button", { name: "Activity: 1 operation needs attention", exact: true }).click();
    await page.getByRole("button", { name: "Retry", exact: true }).waitFor();
    fail = false;

    // When Retry is used from global feedback
    await page.getByRole("button", { name: "Retry", exact: true }).click();

    // Then it still saves the original review's approval
    await expect.poll(() => records.map((record) => record.path)).toEqual(["first.ts"]);
  });
  test("a hunk approval follows an overlapping file clear without restoring other hunks", async () => {
    // Given a two-hunk file whose approvals are durable
    patch = "diff --git a/first.ts b/first.ts\n--- a/first.ts\n+++ b/first.ts\n@@ -1 +1 @@\n-old\n+new\n@@ -20 +20 @@\n-before\n+after\n";
    await page.reload();
    await page.getByLabel("File reviewed", { exact: true }).check();
    await expect.poll(() => records.length).toBe(2);
    // And a whole-file clear held by the server
    const latch = Promise.withResolvers<void>();
    hold = latch.promise;
    await page.getByLabel("File reviewed", { exact: true }).uncheck();

    // When just the first hunk is marked reviewed while the clear is pending
    await page.getByRole("main", { name: "Diff reading surface", exact: true }).focus();
    await page.keyboard.press("Space");
    latch.resolve();
    await expect(page.getByRole("button", { name: "Activity: Saved", exact: true })).toBeVisible();

    // Then only the first hunk remains approved
    expect(records.map((record) => record.oldLine)).toEqual([1]);
  });
  test("file navigation aliases work while Reviewed retains focus", async () => {
    // Given keyboard focus remains on the optimistic checkbox
    await page.getByLabel("File reviewed", { exact: true }).check();

    // When the reader uses the next-file alias
    await page.keyboard.press("ArrowRight");

    // Then navigation advances without requiring a click on the diff
    await expect(page.getByLabel("Current file")).toHaveAttribute("title", "second.ts");
  });

  test("shifted file completion works from the checkbox", async () => {
    // Given an unreviewed file with its checkbox focused
    await page.getByLabel("File reviewed", { exact: true }).focus();

    // When the reader marks the file and advances with Shift+L
    await page.keyboard.press("Shift+L");

    // Then the next file opens immediately
    await expect(page.getByLabel("Current file")).toHaveAttribute("title", "second.ts");
  });

  test("Space on Reviewed preserves the native checkbox toggle", async () => {
    // Given keyboard focus on the file checkbox
    await page.getByLabel("File reviewed", { exact: true }).focus();

    // When Space activates the checkbox
    await page.keyboard.press("Space");
    await expect(page.getByLabel("File reviewed", { exact: true })).toBeChecked();

    // Then hunk completion has not stolen Space and advanced to another file
    await expect(page.getByLabel("Current file")).toHaveAttribute("title", "first.ts");
  });

  test("navigation letters remain text in an editing control", async () => {
    // Given a text input inside the reading surface, including a shadow boundary
    await page.getByRole("main", { name: "Diff reading surface", exact: true }).evaluate((surface) => {
      const host = document.createElement("div");
      surface.append(host);
      const input = document.createElement("input");
      input.setAttribute("aria-label", "Shortcut typing fixture");
      host.attachShadow({ mode: "open" }).append(input);
      input.focus();
    });

    // When typing a file-navigation key
    await page.keyboard.press("l");
    await expect(page.getByLabel("Shortcut typing fixture")).toHaveValue("l");

    // Then the viewer has not navigated through the shadow-root input
    await expect(page.getByLabel("Current file")).toHaveAttribute("title", "first.ts");
  });

  test("Shift+Space saves exact matches only within the current file", async () => {
    // Given repeated edits, a whitespace variant, and the same edit in another file
    patch = repeatedPatch();
    await page.reload();
    await expect(page.getByLabel("File reviewed", { exact: true })).toBeEnabled();

    // When approving all matches of the first logical hunk
    await page.keyboard.press("Shift+Space");

    // Then only the two exact matches in this file are saved
    await expect.poll(() => records.map((record) => `${record.path}:${record.oldLine}`)).toEqual(["first.ts:2", "first.ts:20"]);
  });

  test("Shift+Space advances past matching hunks while the batch is held", async () => {
    // Given a repeated edit whose save is held
    patch = repeatedPatch();
    await page.reload();
    await expect(page.getByLabel("File reviewed", { exact: true })).toBeEnabled();
    const latch = Promise.withResolvers<void>();
    hold = latch.promise;

    // When approving matching hunks and then the next distinct edit
    await page.keyboard.press("Shift+Space");
    await page.keyboard.press("Space");

    // Then navigation reaches the next file before persistence completes
    await expect(page.getByLabel("Current file")).toHaveAttribute("title", "second.ts");
    latch.resolve();
  });

  test("failed matching approvals can be retried after navigating away", async () => {
    // Given a rejected bulk approval
    patch = repeatedPatch();
    await page.reload();
    await expect(page.getByLabel("File reviewed", { exact: true })).toBeEnabled();
    fail = true;
    await page.keyboard.press("Shift+Space");
    await page.keyboard.press("l");
    await page.getByRole("button", { name: "Activity: 1 operation needs attention", exact: true }).click();
    await page.getByRole("button", { name: "Retry", exact: true }).waitFor();
    // And the server recovers
    fail = false;

    // When retrying the retained batch
    await page.getByRole("button", { name: "Retry", exact: true }).click();

    // Then both matching approvals are durable
    await expect.poll(() => records.map((record) => `${record.path}:${record.oldLine}`)).toEqual(["first.ts:2", "first.ts:20"]);
  });
});

/** Different context and coordinates must not split identical logical edits. */
function repeatedPatch(): string {
  return "diff --git a/first.ts b/first.ts\n--- a/first.ts\n+++ b/first.ts\n@@ -1,3 +1,3 @@\n test one\n-old\n+new\n end one\n@@ -19,3 +19,3 @@\n test two\n-old\n+new\n end two\n@@ -40 +40 @@\n-old\n+ new\ndiff --git a/second.ts b/second.ts\n--- a/second.ts\n+++ b/second.ts\n@@ -1 +1 @@\n-old\n+new\n";
}
