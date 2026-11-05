import { chromium, expect, test, type Browser, type Page } from "@playwright/test";
import { parsePatchFiles } from "@pierre/diffs";
import { identifyChanges } from "../shared/changeProgress";
import type { SinceReview } from "../shared/sinceReview";
import { captureHunkTexts } from "../shared/hunkText";
import { matchesChange } from "../shared/progress";
import type { HunkObservation } from "../shared/hunkHistory";

test.describe("Historical diff", () => {
  let browser: Browser;
  let page: Page;
  let history: SinceReview;
  let held: Promise<void> | undefined;
  let currentPatch: string;
  let previousPatch: string;
  let earlierVersions: HunkObservation[];
  const head = "b".repeat(40);
  const base = "c".repeat(40);
  const patch = filePatch("example.ts", "current") + filePatch("second.ts", "second");
  const oldPatch = filePatch("example.ts", "previous") + filePatch("removed.ts", "removed");

  test.beforeAll(async () => { browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium" }); });
  test.afterAll(async () => { await browser.close(); });
  test.afterEach(async () => { await page.close(); });
  test.beforeEach(async () => {
    page = await browser.newPage({ baseURL: "http://127.0.0.1:5173", viewport: { width: 1600, height: 1000 }, reducedMotion: "reduce" });
    held = undefined;
    currentPatch = patch;
    previousPatch = oldPatch;
    earlierVersions = [];
    const units = await identifyChanges(parsePatchFiles(patch).flatMap((entry) => entry.files));
    const oldUnits = await identifyChanges(parsePatchFiles(oldPatch).flatMap((entry) => entry.files));
    history = { review: { id: 1, head: "a".repeat(40), base, submittedAt: "2026-11-04" }, head, base,
      hunks: [...units.map((unit) => ({ ...unit, sinceReview: "new" as const, present: true })), ...oldUnits.map((unit) => ({ ...unit, sinceReview: "existing" as const, present: false }))] };
    await page.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith("/review")) return route.fulfill({ json: { pr: { number: 1, title: "History", body: "", html_url: "https://github.com/example/repo/pull/1", state: "open", user: { login: "author" }, head: { sha: head, ref: "feature" }, base: { sha: base, ref: "main" } }, commit: "all", commits: [], patch: currentPatch } });
      if (path.endsWith("/since-review")) return route.fulfill({ json: history });
      if (path.endsWith("/historical")) {
        await held;
        const file = new URL(route.request().url()).searchParams.get("path");
        const observations = history.review ? [...await retainedHunks(previousPatch, history), ...earlierVersions].filter((unit) => unit.path === file) : [];
        return route.fulfill({ json: { ...history, observations, missing: 0 } });
      }
      if (path.endsWith("/conversation")) return route.fulfill({ json: { viewer: "me", comments: [], reviews: [], inline: [] } });
      if (path.endsWith("/review-draft")) return route.fulfill({ json: { commitId: head, body: "", comments: [], version: 0 } });
      if (path.endsWith("/discussion")) return route.fulfill({ json: { threads: [], version: 0 } });
      if (path.endsWith("/identity")) return route.fulfill({ json: null });
      if (path.endsWith("/stack")) return route.fulfill({ json: null });
      if (path.endsWith("/viewed")) return route.fulfill({ json: { files: {} } });
      if (path.endsWith("/progress") && route.request().method() === "POST") {
        const body = route.request().postDataJSON();
        return route.fulfill({ json: body.changes.filter((entry: { reviewed: boolean }) => entry.reviewed).map((entry: { identity: object }) => ({ ...entry.identity, head, reviewedAt: "now" })) });
      }
      return route.fulfill({ json: [] });
    });
    await page.goto("/pr/example/repo/1");
    await expect(page.locator("[data-biff-focused]")).toHaveText("current");
  });

  test("Historical opens the old file hunks", async () => {
    // Given a current hunk introduced after my review
    // When I open Historical
    await page.getByRole("button", { name: "Historical (1)", exact: true }).click();
    // Then the reference shows the old comparison's code
    await expect(page.getByRole("complementary", { name: "Historical hunks", exact: true }).locator('[data-line-type="change-addition"][data-line]')).toHaveText("previous");
  });

  test("closing Historical preserves the current cursor", async () => {
    // Given old hunks open beside the current diff
    await page.getByRole("button", { name: "Historical (1)", exact: true }).click();
    await page.getByRole("complementary", { name: "Historical hunks", exact: true }).waitFor();
    // When the reference is closed
    await page.getByRole("button", { name: "Close historical diff", exact: true }).click();
    // Then the main cursor remains on current code
    await expect(page.locator("[data-biff-focused]")).toHaveText("current");
  });

  test("a held history load does not block file navigation", async () => {
    // Given a history request held by the server
    const latch = Promise.withResolvers<void>();
    held = latch.promise;
    await page.getByRole("button", { name: "Historical (1)", exact: true }).click();
    // When I navigate in the current diff
    await page.keyboard.press("l");
    // Then the next file is usable before history finishes
    await expect(page.locator("[data-biff-focused]")).toHaveText("second");
    latch.resolve();
  });

  test("historical hunks stay pinned while the main pane changes files", async () => {
    // Given historical hunks open for example.ts
    await page.getByRole("button", { name: "Historical (1)", exact: true }).click();
    await page.getByRole("complementary", { name: "Historical hunks", exact: true }).waitFor();
    // When the main pane moves to second.ts
    await page.keyboard.press("l");
    await page.getByLabel("Current file").filter({ hasText: "second.ts" }).waitFor();
    // Then the reference still shows example.ts's historical code
    await expect(page.getByRole("complementary", { name: "Historical hunks", exact: true }).locator('[data-line-type="change-addition"][data-line]')).toHaveText("previous");
  });

  test("checking a new hunk preserves its gutter accent", async () => {
    // Given an accented current hunk
    const gutter = page.getByRole("main", { name: "Diff reading surface", exact: true }).locator('[data-column-number="1"][data-line-type="change-addition"]');
    await expect(gutter).toHaveCSS("box-shadow", "rgb(197, 153, 232) 3px 0px 0px 0px inset");
    // When I mark the file reviewed
    await page.getByLabel("File reviewed", { exact: true }).click();
    // Then historical information remains independent of progress
    await expect(gutter).toHaveCSS("box-shadow", "rgb(197, 153, 232) 3px 0px 0px 0px inset");
  });

  test("missing review evidence is explained instead of inventing old code", async () => {
    // Given a review without historical evidence
    history = { head, base, hunks: [] };
    // When Historical is opened
    await page.getByRole("button", { name: "Historical (1)", exact: true }).click();
    // Then the pane explains the missing comparison
    await expect(page.getByText("History unavailable: your latest submitted review has no retained comparison evidence.", { exact: true })).toBeVisible();
  });

  test("an empty current diff has no file-specific Historical action", async () => {
    // Given all changes disappeared from the current comparison
    currentPatch = "";
    // When the empty comparison is opened
    await page.reload();
    await page.getByRole("heading", { name: "No changes", exact: true }).waitFor();
    // Then there is no Historical action without a current file
    await expect(page.getByRole("button", { name: /^Historical/ })).toHaveCount(0);
  });

  test("retained historical text renders after the base changes", async () => {
    // Given the submitted comparison used a different base
    history.review!.base = "d".repeat(40);
    // When Historical is opened
    await page.getByRole("button", { name: "Historical (1)", exact: true }).click();
    // Then the retained source is still available
    await expect(page.getByRole("complementary", { name: "Historical hunks", exact: true }).locator('[data-line-type="change-addition"][data-line]')).toHaveText("previous");
  });

  test("Escape closes Historical while reading the current diff", async () => {
    // Given old hunks open while focus remains in the current diff
    await page.getByRole("button", { name: "Historical (1)", exact: true }).click();
    await page.getByRole("complementary", { name: "Historical hunks", exact: true }).waitFor();
    // When I dismiss the reference with the keyboard
    await page.keyboard.press("Escape");
    // Then the historical split closes
    await expect(page.getByRole("complementary", { name: "Historical diff", exact: true })).toBeHidden();
  });

  test("Escape closes Historical while reading the historical hunks", async () => {
    // Given keyboard focus inside the historical reference
    await page.getByRole("button", { name: "Historical (1)", exact: true }).click();
    await page.getByRole("complementary", { name: "Historical hunks", exact: true }).locator('[data-line-type="change-addition"][data-line]').click();
    // When I dismiss the reference with the keyboard
    await page.keyboard.press("Escape");
    // Then the historical split closes without needing focus in the current diff
    await expect(page.getByRole("complementary", { name: "Historical diff", exact: true })).toBeHidden();
  });
  test("a just-submitted comparison hides the Historical button", async () => {
    // Given every submitted hunk is still current
    history.hunks = history.hunks.filter((unit) => unit.present).map((unit) => ({ ...unit, sinceReview: "existing" }));
    // When the current comparison is reopened
    await page.reload();
    // Then no Historical action is offered for current hunks
    await expect(page.getByRole("button", { name: /^Historical/ })).toHaveCount(0);
  });

  test("a just-submitted comparison does not duplicate current code in Historical", async () => {
    // Given every submitted hunk is still current
    history.hunks = history.hunks.filter((unit) => unit.present).map((unit) => ({ ...unit, sinceReview: "existing" }));
    // When the reference is opened
    await page.getByRole("button", { name: "Historical (1)", exact: true }).click();
    // Then the empty history is explained instead of displaying current hunks
    await expect(page.getByText("No historical hunks: the hunks from your submitted review are still current, or this file was not in that review.", { exact: true })).toBeVisible();
  });
  test("opening Historical selects the old hunk nearest the current line", async () => {
    // Given current and old changes at widely separated source lines
    await distantHunks();
    await page.keyboard.press("n");
    await page.locator('[data-biff-focused]').filter({ hasText: "currentFar" }).waitFor();
    // When opening history from the distant current hunk
    await page.getByRole("button", { name: "Historical (2)", exact: true }).click();
    // Then the reference opens at the nearest old hunk
    await expect(page.locator("[data-biff-pinned]")).toHaveText("previousFar");
  });

  test("clicking an old hunk selects the nearest current hunk", async () => {
    // Given history opened from the first current hunk
    await distantHunks();
    await page.getByRole("button", { name: "Historical (2)", exact: true }).click();
    // When the distant old hunk is clicked
    await page.getByRole("complementary", { name: "Historical hunks", exact: true }).locator('[data-line-type="change-addition"][data-line]').filter({ hasText: "previousFar" }).click();
    // Then the main pane selects the nearby current hunk
    await expect(page.locator("[data-biff-focused]")).toHaveText("currentFar");
  });

  test("clicking pinned history returns to its file after main-pane navigation", async () => {
    // Given pinned history for example.ts while the main pane is on second.ts
    await page.getByRole("button", { name: "Historical (1)", exact: true }).click();
    await page.getByRole("complementary", { name: "Historical hunks", exact: true }).waitFor();
    await page.keyboard.press("l");
    await page.locator('[data-biff-focused]').filter({ hasText: "second" }).waitFor();
    // When the old example.ts hunk is clicked
    await page.getByRole("complementary", { name: "Historical hunks", exact: true }).locator('[data-line-type="change-addition"][data-line]').click();
    // Then the main pane returns to example.ts's nearest current hunk
    await expect(page.locator("[data-biff-focused]")).toHaveText("current");
  });

  test("H opens the current file's historical hunks", async () => {
    // Given a current file with historical hunks
    await page.getByRole("button", { name: "Historical (1)", exact: true }).waitFor();
    // When Shift+H is pressed
    await page.keyboard.press("Shift+H");
    // Then history opens instead of marking the file reviewed and navigating backward
    await expect(page.getByRole("complementary", { name: "Historical hunks", exact: true }).locator('[data-line-type="change-addition"][data-line]')).toHaveText("previous");
  });

  test("overlapping hunk versions can be paged backward", async () => {
    // Given an earlier observed edit in the same source range
    earlierVersions = [{ id: 100, hunkId: "older", path: "example.ts", kind: "", head: "e".repeat(40), base, observedAt: "2026-11-03", oldLine: 1, newLine: 1, diffText: "-before\n+older\n" }];
    await page.getByRole("button", { name: "Historical (1)", exact: true }).click();
    // When paging to the previous observed version
    await page.getByRole("button", { name: "Previous historical version", exact: true }).click();
    // Then the same group's earlier hunk is displayed
    await expect(page.getByRole("complementary", { name: "Historical hunks", exact: true }).locator('[data-line-type="change-addition"][data-line]')).toHaveText("older");
  });

  test("version arrows return to the latest historical edit", async () => {
    // Given a group with two observed versions, displaying the older one
    earlierVersions = [{ id: 100, hunkId: "older", path: "example.ts", kind: "", head: "e".repeat(40), base, observedAt: "2026-11-03", oldLine: 1, newLine: 1, diffText: "-before\n+older\n" }];
    await page.getByRole("button", { name: "Historical (1)", exact: true }).click();
    await page.getByRole("button", { name: "Previous historical version", exact: true }).click();
    // When paging forward
    await page.getByRole("button", { name: "Next historical version", exact: true }).click();
    // Then the newest historical edit is restored
    await expect(page.getByRole("complementary", { name: "Historical hunks", exact: true }).locator('[data-line-type="change-addition"][data-line]')).toHaveText("previous");
  });

  test("all historical groups render in source-line order", async () => {
    // Given two historical regions far apart in the file
    await distantHunks();
    // When opening the historical pane
    await page.getByRole("button", { name: "Historical (2)", exact: true }).click();
    // Then both regions appear together in source order
    await expect(page.getByRole("complementary", { name: "Historical hunks", exact: true }).locator('[data-line-type="change-addition"][data-line]')).toHaveText(["previous", "previousFar"]);
  });

  test("paging one group preserves the other group's version", async () => {
    // Given two historical regions with independent older versions
    await distantHunks();
    earlierVersions = [
      { id: 100, hunkId: "older", path: "example.ts", kind: "", head: "e".repeat(40), base, observedAt: "2026-11-03", oldLine: 1, newLine: 1, diffText: "-before\n+older\n" },
      { id: 101, hunkId: "olderFar", path: "example.ts", kind: "", head: "e".repeat(40), base, observedAt: "2026-11-03", oldLine: 980, newLine: 980, diffText: "-beforeFar\n+olderFar\n" },
    ];
    await page.getByRole("button", { name: "Historical (2)", exact: true }).click();
    await page.getByRole("region", { name: "Group 2", exact: true }).getByRole("button", { name: "Previous historical version", exact: true }).click();
    // When paging the first group backward and forward
    const first = page.getByRole("region", { name: "Group 1", exact: true });
    await first.getByRole("button", { name: "Previous historical version", exact: true }).click();
    await first.getByRole("button", { name: "Next historical version", exact: true }).click();
    // Then the second group keeps its selected older version
    await expect(page.getByRole("complementary", { name: "Historical hunks", exact: true }).locator('[data-line-type="change-addition"][data-line]')).toHaveText(["previous", "olderFar"]);
  });

  /** Keep source coordinates far apart so choosing the first hunk cannot pass by accident. */
  async function distantHunks() {
    currentPatch = filePatch("example.ts", "current") + "@@ -1000 +1000 @@\n-beforeFar\n+currentFar\n";
    previousPatch = filePatch("example.ts", "previous") + "@@ -980 +980 @@\n-beforeFar\n+previousFar\n";
    const units = await identifyChanges(parsePatchFiles(previousPatch).flatMap((entry) => entry.files));
    history.hunks = units.map((unit) => ({ ...unit, sinceReview: "existing", present: false }));
    await page.reload();
    await page.locator('[data-biff-focused]').filter({ hasText: "current" }).waitFor();
  }
});

/** Tiny real patches keep source rendering and identity matching in the test. */
function filePatch(path: string, contents: string): string {
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-before\n+${contents}\n`;
}

/** Model the endpoint's retained per-file observations using real hunk identities. */
async function retainedHunks(patch: string, history: SinceReview): Promise<HunkObservation[]> {
  const files = parsePatchFiles(patch).flatMap((entry) => entry.files);
  const blocks = await identifyChanges(files);
  const texts = captureHunkTexts(files, blocks);
  return blocks.filter((block) => history.hunks.some((unit) => unit.sinceReview === "existing" && !unit.present && matchesChange(unit, block)))
    .map((block, index) => ({ ...texts.get(block)!, id: index + 1, hunkId: block.hash, path: block.path, kind: "", head: history.review!.head, base: history.review!.base, observedAt: history.review!.submittedAt }));
}
