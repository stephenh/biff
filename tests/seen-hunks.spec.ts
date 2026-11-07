import { chromium, expect, test, type Browser, type Page } from "@playwright/test";
import { parsePatchFiles } from "@pierre/diffs";
import { identifyChanges } from "../shared/changeProgress";
import { captureHunkTexts } from "../shared/hunkText";
import { matchesChange, type ChangeIdentity } from "../shared/progress";
import type { HunkObservation, SeenHunk } from "../shared/hunkHistory";

test.describe("Seen hunks", () => {
  let browser: Browser;
  let page: Page;
  let head: string;
  let patch: string;
  let seen: SeenHunk[];
  let observations: HunkObservation[];
  let held: Promise<void> | undefined;
  let reject: boolean;
  const base = "b".repeat(40);
  const scope = "d".repeat(64);

  test.beforeAll(async () => { browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium" }); });
  test.afterAll(async () => { await browser.close(); });
  test.afterEach(async () => { await page.close(); });
  test.beforeEach(async () => {
    page = await browser.newPage({ baseURL: "http://127.0.0.1:5173", viewport: { width: 1600, height: 1000 }, reducedMotion: "reduce" });
    head = "a".repeat(40);
    patch = filePatch("first.ts", "first", "second") + filePatch("second.ts", "other file");
    seen = [];
    observations = [];
    held = undefined;
    reject = false;
    await page.route("**/api/**", async (route) => {
      const url = new URL(route.request().url());
      const path = url.pathname;
      if (path.endsWith("/seen")) {
        const body = route.request().postDataJSON() as { identity: ChangeIdentity; head: string; base: string };
        const files = parsePatchFiles(patch).flatMap((entry) => entry.files);
        const blocks = await identifyChanges(files);
        const texts = captureHunkTexts(files, blocks);
        const block = blocks.find((block) => matchesChange(block, body.identity))!;
        const text = texts.get(block)!;
        if (body.identity.path === "first.ts") await held;
        if (reject) return route.fulfill({ status: 503, json: { error: "History save unavailable" } });
        const seenAt = "2026-11-07T12:00:00Z";
        if (!seen.some((unit) => matchesChange(unit, body.identity))) {
          seen.push({ ...body.identity, seenAt, present: true });
          observations.push({ ...text, path: block.path, kind: "", id: observations.length + 1, hunkId: block.hash, head: body.head, base: body.base, observedAt: seenAt });
        }
        return route.fulfill({ json: { seenAt } });
      }
      if (path.endsWith("/history") || path.endsWith("/historical")) {
        const units = await identifyChanges(parsePatchFiles(patch).flatMap((entry) => entry.files));
        const hunks = seen.map((unit) => ({ ...unit, present: units.some((current) => matchesChange(unit, current)) }));
        if (path.endsWith("/history")) return route.fulfill({ json: { head, base, hunks } });
        return route.fulfill({ json: { observations: observations.filter((old) => old.path === url.searchParams.get("path") && hunks.some((unit) => unit.hash === old.hunkId && !unit.present)), missing: 0 } });
      }
      if (path.endsWith("/since-review")) return route.fulfill({ json: { head, base, hunks: [] } });
      if (path.endsWith("/review") && path.startsWith("/api/github")) return route.fulfill({ json: {
        pr: { number: 1, title: "Encounter history", body: "", html_url: "https://github.com/example/repo/pull/1", state: "open", user: { login: "author" }, head: { sha: head, ref: "feature" }, base: { sha: base, ref: "main" } }, commit: "all", commits: [], patch,
      } });
      if (path.endsWith("/review")) {
        const selected = { commit_id: head, change_id: "k".repeat(32), description: "Local changes" };
        return route.fulfill({ json: { workspace: { id: "fixture", name: "Local fixture", path: "/fixture", vcs: "git" }, selected, revisions: [selected], tip: selected, base: { commit_id: base }, bookmark: "", changes: "all", identity: { id: scope, closed: false }, progressScope: scope, patch } });
      }
      if (path.endsWith("/discussion")) return route.fulfill({ json: { identity: { id: scope, closed: false }, threads: [], version: 0 } });
      if (path.endsWith("/conversation")) return route.fulfill({ json: { viewer: "me", comments: [], reviews: [], inline: [] } });
      if (path.endsWith("/review-draft")) return route.fulfill({ json: { commitId: head, body: "", comments: [], version: 0 } });
      if (path.endsWith("/identity") || path.endsWith("/stack")) return route.fulfill({ json: null });
      if (path.endsWith("/viewed")) return route.fulfill({ json: { files: {} } });
      return route.fulfill({ json: [] });
    });
  });

  test("opening a PR retains only the focused hunk", async () => {
    // Given a PR with several unseen hunks
    // When its initial hunk is focused
    await open("pr");
    // Then loading the comparison does not mark every hunk seen
    await expect.poll(() => seen.map((unit) => [unit.path, unit.newLine])).toEqual([["first.ts", 1]]);
  });

  test("j/k retain an entered hunk without marking it reviewed", async () => {
    // Given a local review focused on the first change
    await open("local");
    // When keyboard reading reaches the second change
    await page.keyboard.press("j");
    await page.keyboard.press("j");
    await expect.poll(() => seen.map((unit) => unit.newLine)).toEqual([1, 3]);
    // Then explicit review completion remains unchanged
    await expect(page.getByLabel("File reviewed", { exact: true })).toHaveAttribute("aria-pressed", "false");
  });

  test("held encounter saves do not block reading or saves in another file", async () => {
    // Given a local review and a held encounter save
    await open("local");
    await expect.poll(() => seen.length).toBe(1);
    const latch = Promise.withResolvers<void>();
    held = latch.promise;
    await page.keyboard.press("j");
    await page.keyboard.press("j");
    // When the reader changes files before that save finishes
    await page.keyboard.press("l");
    // Then the other file can independently retain its focused hunk
    await expect.poll(() => seen.map((unit) => unit.path)).toEqual(["first.ts", "second.ts"]);
    latch.resolve();
  });

  test("PR history works before submitting any review", async () => {
    // Given an encountered hunk and no submitted review
    await open("pr");
    await expect.poll(() => seen.length).toBe(1);
    // When another iteration replaces the edits
    await iterate();
    await page.getByRole("button", { name: "Historical (1)", exact: true }).click();
    // Then only the previously encountered content is shown
    await expect(historicalAdditions()).toHaveText("first");
  });

  test("local history works across iterations without a submitted review", async () => {
    // Given a locally encountered hunk
    await open("local");
    await expect.poll(() => seen.length).toBe(1);
    // When local work changes and its review is reopened
    await iterate();
    await page.getByRole("button", { name: "Historical (1)", exact: true }).click();
    // Then the local reference pane displays the retained old text
    await expect(historicalAdditions()).toHaveText("first");
    await page.screenshot({ path: "/tmp/opencode/biff-seen-history.png" });
  });

  test("encountered hunks still present do not appear as historical", async () => {
    // Given an encountered current hunk
    await open("local");
    await expect.poll(() => seen.length).toBe(1);
    // When the same comparison is reopened
    await page.reload();
    await page.locator("[data-biff-focused]").waitFor();
    // Then Historical does not duplicate the current code
    await expect(page.getByRole("button", { name: /^Historical/ })).toHaveCount(0);
  });

  test("failed encounter saves remain retryable after leaving the review", async () => {
    // Given an encounter save held until after SPA navigation
    const latch = Promise.withResolvers<void>();
    held = latch.promise;
    await open("local");
    await page.getByRole("link", { name: "Working Copies", exact: true }).click();
    // And the save fails after its viewer unmounts
    reject = true;
    latch.resolve();
    await page.getByRole("button", { name: "Activity: 1 operation needs attention", exact: true }).click();
    await page.getByText("History save unavailable", { exact: true }).waitFor();
    reject = false;
    // When the retained save intent is retried from global feedback
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    // Then the original encountered hunk is retained without reopening its viewer
    await expect.poll(() => seen.map((unit) => unit.newLine)).toEqual([1]);
  });

  test("unchanged context does not mark the following hunk seen", async () => {
    // Given the first hunk is retained and the following hunk is unseen
    await open("local");
    await expect.poll(() => seen.length).toBe(1);
    // When the reader focuses only the intervening context line
    await page.keyboard.press("j");
    await page.locator("[data-biff-focused]").filter({ hasText: "middle" }).waitFor();
    // Then context navigation has not retained the next change
    expect(seen.map((unit) => unit.newLine)).toEqual([1]);
  });

  test("clicking a changed row retains its logical hunk", async () => {
    // Given a local review with an unseen second hunk
    await open("local");
    await expect.poll(() => seen.length).toBe(1);
    // When the reader clicks its changed source row
    await page.getByRole("main", { name: "Diff reading surface", exact: true }).locator('[data-line-type="change-addition"][data-line]').filter({ hasText: "second" }).click();
    // Then that hunk is kept just as it would be through keyboard navigation
    await expect.poll(() => seen.map((unit) => unit.newLine)).toEqual([1, 3]);
  });

  /** Both providers share the same Viewer and encounter mutation contract. */
  async function open(source: "local" | "pr") {
    await page.goto(source === "local" ? "/workspaces/fixture" : "/pr/example/repo/1");
    await expect(page.locator("[data-biff-focused]")).toHaveText("first");
  }

  /** Reload only the snapshot; the fixture retains server-side seen evidence across iterations. */
  async function iterate() {
    head = "c".repeat(40);
    patch = filePatch("first.ts", "replacement", "unseen replacement") + filePatch("second.ts", "other file");
    await page.reload();
    await expect(page.locator("[data-biff-focused]")).toHaveText("replacement");
  }

  /** Ignore deletion rows and navigation controls in the historical pane. */
  function historicalAdditions() {
    return page.getByRole("complementary", { name: "Historical hunks", exact: true }).locator('[data-line-type="change-addition"][data-line]');
  }
});

/** Context separates logical edits while keeping j/k navigation small and deterministic. */
function filePatch(path: string, first: string, second?: string): string {
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${second
    ? `@@ -1,3 +1,3 @@\n-before\n+${first}\n middle\n-before next\n+${second}\n`
    : `@@ -1 +1 @@\n-before\n+${first}\n`}`;
}
