import { readFile } from "node:fs/promises";
import { chromium, expect, test, type Browser, type Page } from "@playwright/test";
import type { ReviewThread } from "../shared/localReview";

test.describe("Line comments", () => {
  let browser: Browser;
  let page: Page;
  let threads: ReviewThread[];
  let readKeys: string[];
  let discussionVersion: number;

  test.beforeAll(async () => { browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium" }); });
  test.afterEach(async () => { await page.close(); });
  test.afterAll(async () => { await browser.close(); });
  test.beforeEach(async () => {
    page = await browser.newPage({ baseURL: "http://127.0.0.1:5173", viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
    const patch = await readFile(new URL("../fixtures/demo.diff", import.meta.url), "utf8");
    const workspace = { id: "fixture", name: "fixture", path: "/fixture" };
    const revision = { commit_id: "a".repeat(40), change_id: "qwerty", description: "Comment fixture" };
    readKeys = [];
    discussionVersion = 0;
    threads = [{ id: "thread", anchor: { path: "src/reviews.ts", line: 3, endLine: 3, side: "RIGHT", commitId: revision.commit_id, excerpt: "" }, resolved: false, humanSequence: 0, messages: [
      { id: "first", sequence: 1, author: "agent", body: "Can we use a named constant here?", createdAt: "2026-10-17T12:00:00Z" },
    ] }];
    await page.route("**/api/**", (route) => {
      const url = route.request().url();
      if (url.endsWith("/comment-reads")) {
        if (route.request().method() === "POST") readKeys = [...new Set([...readKeys, ...route.request().postDataJSON().keys])];
        return route.fulfill({ json: readKeys });
      }
      if (url.endsWith("/discussion") && route.request().method() === "POST") {
        const body = route.request().postDataJSON();
        const target = threads.find((thread) => thread.id === body.threadId);
        if (body.action === "resolve" && target) target.resolved = body.resolved;
        discussionVersion++;
      }
      const data = url.includes("/review?")
        ? { workspace, selected: revision, revisions: [revision], patch, identity: { id: "fixture" } }
        : url.includes("/discussion") ? { identity: { id: "fixture" }, threads, version: discussionVersion } : [];
      return route.fulfill({ json: data });
    });
    await page.goto("/workspaces/fixture");
    await page.locator("[data-biff-focused]").waitFor();
  });

  test("selecting and hovering lines never shows an add-comment button", async () => {
    // Given a selected code line
    const row = page.locator('[data-content] > [data-line-index="4,3"]');
    await row.click();

    // When the pointer moves over another line
    await page.locator('[data-content] > [data-line-index="5,4"]').hover();

    // Then adding comments remains a keyboard-only action
    await expect(page.getByRole("button", { name: /^Add comment on line/ })).toHaveCount(0);
  });

  test("the unread gutter count opens its thread", async () => {
    // Given an unread comment on line three
    const badge = page.getByRole("button", { name: "1 unread comment on line 3", exact: true });

    // When its gutter count is clicked
    await badge.click();

    // Then the comment composer opens
    await expect(page.getByRole("dialog")).toBeVisible();
  });

  test("c opens a comment on the selected line", async () => {
    // Given a selected code line without a thread
    await page.locator('[data-content] > [data-line-index="4,3"]').click();

    // When the comment shortcut is pressed
    await page.keyboard.press("c");

    // Then the comment composer opens
    await expect(page.getByRole("dialog")).toBeVisible();
  });

  test("explicitly acknowledged comments stay read after reload", async () => {
    // Given an unread thread
    await page.getByRole("button", { name: "1 unread comment on line 3", exact: true }).click();
    await page.getByRole("button", { name: "Mark comment read", exact: true }).click();
    await page.getByRole("button", { name: "1 comment on line 3", exact: true }).waitFor();

    // When the review is reloaded
    await page.reload();

    // Then its gutter displays the total instead of an unread count
    await expect(page.getByRole("button", { name: "1 comment on line 3", exact: true })).toHaveCount(1);
  });

  test("new replies count as unread without recounting older messages", async () => {
    // Given a thread whose original message has been read
    await page.getByRole("button", { name: "1 unread comment on line 3", exact: true }).click();
    await page.getByRole("button", { name: "Mark comment read", exact: true }).click();
    await page.getByRole("button", { name: "1 comment on line 3", exact: true }).waitFor();

    // And an agent adds a reply
    threads[0].messages.push({ id: "reply", sequence: 2, author: "agent", body: "Updated the constant.", createdAt: "2026-10-17T12:01:00Z" });

    // When the review loads the reply
    await page.reload();

    // Then only the new reply is counted as unread
    await expect(page.getByRole("button", { name: "1 unread comment on line 3", exact: true })).toHaveAttribute("title", "1 unread · 2 comments");
  });

  test("c opens the selected line's existing thread", async () => {
    // Given a selected line with an unread thread
    await page.getByRole("button", { name: "1 unread comment on line 3", exact: true }).waitFor();
    await page.locator('[data-content] > [data-line-index="3,2"]').click();

    // When the comment shortcut is pressed
    await page.keyboard.press("c");

    // Then the existing comment is shown instead of a new-thread composer
    await expect(page.getByRole("dialog").getByText("Can we use a named constant here?", { exact: true })).toBeVisible();
  });

  test("file comments includes local threads from an old snapshot", async () => {
    // Given a local thread whose anchor belongs to an older commit
    threads[0].anchor.commitId = "b".repeat(40);
    await page.reload();

    // When file comments opens
    await page.getByRole("button", { name: /^Comments \(/ }).click();

    // Then the old thread is labeled as orphaned
    await expect(page.locator(".file-comment-thread .comment-outdated").first()).toHaveText("Outdated");
  });

  test("file comments replies to the original local thread", async () => {
    // Given a local thread anchored to an older snapshot
    threads[0].anchor.commitId = "b".repeat(40);
    await page.reload();
    // And its reply composer is opened from file comments
    await page.getByRole("button", { name: /^Comments \(/ }).click();
    await page.keyboard.press("Enter");
    await page.getByRole("textbox", { name: "Thread reply", exact: true }).fill("Please keep this change");

    // When the local reply is saved
    const request = page.waitForRequest((request) => request.url().endsWith("/discussion") && request.method() === "POST");
    await page.getByRole("button", { name: "Save locally", exact: true }).click();

    // Then it targets the original thread without creating a new anchor
    expect((await request).postDataJSON()).toEqual({ action: "reply", threadId: "thread", body: "Please keep this change" });
  });

  test("local threads open within the existing file-comments modal", async () => {
    // Given file comments is open on a local review
    await page.getByRole("button", { name: /^Comments \(/ }).click();

    // When the reader opens its thread
    await page.keyboard.press("Enter");
    await page.getByRole("textbox", { name: "Thread reply", exact: true }).waitFor();

    // Then no second modal is opened
    await expect(page.locator("dialog[open]")).toHaveCount(1);
  });

  test("Back retains a local reply draft", async () => {
    // Given a local reply entered from file comments
    await page.getByRole("button", { name: /^Comments \(/ }).click();
    await page.keyboard.press("Enter");
    await page.getByRole("textbox", { name: "Thread reply", exact: true }).fill("Keep the local draft");

    // When the reader goes back and reopens the thread
    await page.getByRole("button", { name: "Back to file comments", exact: true }).click();
    await page.keyboard.press("Enter");

    // Then the local draft remains in the prefocused reply box
    await expect(page.getByRole("textbox", { name: "Thread reply", exact: true })).toHaveValue("Keep the local draft");
  });

  test("r resolves and collapses the selected local thread", async () => {
    // Given a local thread selected in file comments
    await page.getByRole("button", { name: /^Comments \(/ }).click();

    // When resolve is pressed
    await page.keyboard.press("r");

    // Then the local thread is shown as resolved
    await expect(page.locator(".file-comment-thread")).toHaveAttribute("data-resolved", "");
  });

  test("u leaves a collapsed local thread unchanged in the list", async () => {
    // Given an already resolved local thread
    threads[0].resolved = true;
    await page.reload();
    await page.getByRole("button", { name: /^Comments \(/ }).click();

    // When unresolve is pressed
    await page.keyboard.press("u");

    // Then its row remains resolved
    await expect(page.locator(".file-comment-thread")).toHaveAttribute("data-resolved", "");
  });

  test("r resolves a drilled-in local thread without closing it", async () => {
    // Given a local thread open inside file comments
    await page.getByRole("button", { name: /^Comments \(/ }).click();
    await page.keyboard.press("Enter");
    // And focus is outside the reply box
    await page.getByRole("button", { name: "Back to file comments", exact: true }).focus();

    // When resolve is pressed
    await page.keyboard.press("r");

    // Then the same thread can be unresolved from within the detail view
    await expect(page.getByRole("button", { name: "Unresolve thread", exact: true })).toBeVisible();
  });

  test("u unresolves a drilled-in local thread", async () => {
    // Given a resolved local thread opened for reading
    threads[0].resolved = true;
    await page.reload();
    await page.getByRole("button", { name: /^Comments \(/ }).click();
    await page.keyboard.press("Enter");
    // And focus is outside the reply box
    await page.getByRole("button", { name: "Back to file comments", exact: true }).focus();

    // When unresolve is pressed
    await page.keyboard.press("u");

    // Then the existing thread is open again
    await expect(page.getByRole("button", { name: "Resolve thread", exact: true })).toBeVisible();
  });

  test("comment dialogs expose their own collapsed keyboard help", async () => {
    // Given a standalone comment dialog
    await page.getByRole("button", { name: "1 unread comment on line 3", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Close comment thread", exact: true }).focus();

    // When the reader requests the dialog's shortcuts
    await page.keyboard.press("?");

    // Then its close shortcut is shown
    await expect(dialog.getByRole("button", { name: "Esc shortcut", exact: true })).toBeVisible();
  });

  test("closing file comments with X retains the embedded reply draft", async () => {
    // Given an unsent reply inside file comments
    await page.getByRole("button", { name: /^Comments \(/ }).click();
    await page.keyboard.press("Enter");
    await page.getByRole("textbox", { name: "Thread reply", exact: true }).fill("Keep this draft after closing");

    // When the reader closes the whole dialog and reopens it
    await page.getByRole("button", { name: "Close file comments", exact: true }).click();
    await page.getByRole("button", { name: /^Comments \(/ }).click();

    // Then the embedded reply still has its draft
    await expect(page.getByRole("textbox", { name: "Thread reply", exact: true })).toHaveValue("Keep this draft after closing");
  });

  test("the outer X respects an embedded composer's pending save", async () => {
    // Given an embedded reply whose save request is held
    let release: (() => void) | undefined;
    await page.route("**/discussion", async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      await new Promise<void>((resolve) => { release = resolve; });
      await route.fulfill({ status: 500, json: { error: "Save failed" } });
    });
    await page.getByRole("button", { name: /^Comments \(/ }).click();
    await page.keyboard.press("Enter");
    await page.getByRole("textbox", { name: "Thread reply", exact: true }).fill("Pending reply");

    // When the reply is submitted
    await page.getByRole("button", { name: "Save locally", exact: true }).click();

    // Then closing cannot unmount the pending save's error feedback
    try { await expect(page.getByRole("button", { name: "Close file comments", exact: true })).toBeDisabled(); }
    finally { release?.(); }
  });

  test("c keeps a new comment's source line above the composer", async () => {
    // Given a selected line near the bottom of the reading surface
    await positionBottomLine(page);

    // When the comment composer opens
    await page.keyboard.press("c");
    await page.getByRole("dialog").waitFor();

    // Then the whole line is visible above the dialog, with a gap
    const lineBottom = await page.locator("[data-biff-focused]").evaluate((element) => element.getBoundingClientRect().bottom);
    const dialog = await page.getByRole("dialog").boundingBox();
    expect(dialog!.y - lineBottom).toBeGreaterThanOrEqual(7);
  });

  test("c keeps an existing thread's source line above its dialog", async () => {
    // Given an existing thread on a line near the bottom of the reading surface
    threads[0].anchor.line = 60;
    threads[0].anchor.endLine = 60;
    await positionBottomLine(page);

    // When its existing thread opens through the c shortcut
    await page.keyboard.press("c");
    await page.getByRole("textbox", { name: "Thread reply", exact: true }).waitFor();

    // Then the thread box leaves the entire source line visible
    await expect(page.locator("[data-biff-focused]")).toBeVisible();
    const lineBottom = await page.locator("[data-biff-focused]").evaluate((element) => element.getBoundingClientRect().bottom);
    const dialog = await page.getByRole("dialog").boundingBox();
    expect(dialog!.y - lineBottom).toBeGreaterThanOrEqual(7);
  });

  test("short viewports retain a visible source line when commenting", async () => {
    // Given a shorter window with a selected line at the bottom
    await page.setViewportSize({ width: 1440, height: 600 });
    await positionBottomLine(page);

    // When the comment composer opens
    await page.keyboard.press("c");
    await page.getByRole("dialog").waitFor();

    // Then the line remains fully inside the reading surface and above the dialog
    const line = await page.locator("[data-biff-focused]").boundingBox();
    const viewport = await page.getByRole("main", { name: "Diff reading surface" }).boundingBox();
    const dialog = await page.getByRole("dialog").boundingBox();
    expect(line!.y).toBeGreaterThanOrEqual(viewport!.y);
    expect(dialog!.y - (line!.y + line!.height)).toBeGreaterThanOrEqual(7);
  });

  test("comment placement animates with the line while keeping it unobscured", async () => {
    // Given a bottom-of-viewport line with normal animation preferences
    await positionBottomLine(page);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    const before = await page.locator("[data-biff-focused]").evaluate((element) => element.getBoundingClientRect().bottom);

    // When a comment opens and the first few animation frames render
    await page.keyboard.press("c");
    const samples = await page.evaluate(async () => {
      const positions: { line: number; gap: number }[] = [];
      for (let frame = 0; frame < 6; frame++) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const row = document.querySelector(".viewport diffs-container")!.shadowRoot!.querySelector("[data-biff-focused]")!;
        const line = row.getBoundingClientRect().bottom;
        positions.push({ line, gap: document.querySelector("dialog[open]")!.getBoundingClientRect().top - line });
      }
      return positions;
    });

    // Then the line moves progressively, with the comment box following below it
    expect(samples[0].line).toBeLessThan(before);
    expect(samples.at(-1)!.line).toBeLessThan(samples[0].line);
    expect(Math.min(...samples.map((sample) => sample.gap))).toBeGreaterThanOrEqual(7);
  });

  test("opening and closing a thread leaves it unread", async () => {
    // Given an unread conversation
    await page.getByRole("button", { name: "1 unread comment on line 3", exact: true }).click();

    // When the reader closes it without acknowledging
    await page.keyboard.press("Escape");

    // Then no receipt was written
    expect(readKeys).toEqual([]);
  });

  test("Space acknowledges optimistically while navigation stays available", async () => {
    // Given a read request held by the server
    const pending = Promise.withResolvers<void>();
    await page.route("**/comment-reads", async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      await pending.promise;
      return route.fallback();
    });
    await page.getByRole("button", { name: "1 unread comment on line 3", exact: true }).click();

    // When Space acknowledges and Escape closes before completion
    await expect(page.locator('[data-comment-message][data-selected="true"]')).toBeFocused();
    await page.keyboard.press("Space");
    await page.keyboard.press("Escape");

    // Then the gutter updates without waiting for persistence
    try { await expect(page.getByRole("button", { name: "1 comment on line 3", exact: true })).toBeVisible(); }
    finally { pending.resolve(); }
  });

  test("a failed acknowledgement rolls back and can retry after closing", async () => {
    // Given a thread with an unsent reply and a failing read request
    let fail = true;
    await page.route("**/comment-reads", (route) => route.request().method() === "POST" && fail ? route.fulfill({ status: 500, json: { error: "Read receipt failed" } }) : route.fallback());
    await page.getByRole("button", { name: "1 unread comment on line 3", exact: true }).click();
    await page.getByRole("textbox", { name: "Thread reply", exact: true }).fill("Keep this draft");
    await page.getByRole("button", { name: "Mark comment read", exact: true }).click();
    await page.getByText("Read receipt failed", { exact: false }).waitFor();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "1 unread comment on line 3", exact: true }).waitFor();

    // When the reader retries from persistent background feedback
    fail = false;
    await page.getByRole("button", { name: "Retry", exact: true }).click();

    // Then the same exact message becomes durably read
    await expect.poll(() => readKeys).toEqual(["local:first"]);
  });

  test("a reply arriving during acknowledgement remains unread with its draft intact", async () => {
    // Given a held read receipt and an unsent reply
    const pending = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    await page.route("**/comment-reads", async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      started.resolve();
      await pending.promise;
      return route.fallback();
    });
    await page.getByRole("button", { name: "1 unread comment on line 3", exact: true }).click();
    await page.getByRole("textbox", { name: "Thread reply", exact: true }).fill("Still composing");
    await page.getByRole("button", { name: "Mark comment read", exact: true }).click();
    await started.promise;

    // When a new message arrives before the saved snapshot is acknowledged
    threads[0].messages.push({ id: "later", sequence: 2, author: "agent", body: "Another question", createdAt: "2026-10-17T12:01:00Z" });
    discussionVersion++;
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.getByText("Another question", { exact: true }).waitFor();
    pending.resolve();
    await expect.poll(() => readKeys).toEqual(["local:first"]);

    // Then the new message still needs an explicit acknowledgement
    await expect(page.getByRole("button", { name: "1 unread comment on line 3", exact: true })).toHaveAttribute("title", "1 unread · 2 comments");
    await expect(page.getByRole("textbox", { name: "Thread reply", exact: true })).toHaveValue("Still composing");
  });

  test("a shared gutter previews both roots before opening a thread", async () => {
    // Given two distinct threads at the same coordinate
    await addSecondThread(page, threads);

    // When the shared gutter is clicked
    await page.getByRole("button", { name: "2 threads on line 3", exact: true }).click();

    // Then the chooser shows separate roots without mounting a composer
    await expect(page.locator(".line-thread-preview")).toHaveText(["Can we use a named constant here?", "Should this return a boolean?"]);
    await expect(page.locator(".comment-overlay, .comment-detail")).toHaveCount(0);
    expect(readKeys).toEqual([]);
  });

  test("c and j choose the second root before Enter opens its composer", async () => {
    // Given a focused source line with two separate threads
    await addSecondThread(page, threads);
    await page.locator('[data-content] > [data-line]').filter({ hasText: "const PAGE_SIZE = 50;" }).click();

    // When choosing the second root from the keyboard
    await page.keyboard.press("c");
    await page.getByRole("dialog", { name: "Choose comment thread" }).waitFor();
    await page.keyboard.press("j");
    await page.keyboard.press("Enter");

    // Then only the chosen thread appears in the dialog
    await expect(page.locator(".comment-overlay .markdown-text")).toHaveText(["Should this return a boolean?"]);
    await expect(page.getByRole("dialog", { name: "Choose comment thread" })).toHaveCount(0);
  });

  test("Escape dismisses the chooser and returns focus to its gutter", async () => {
    // Given a chooser opened from the shared gutter
    await addSecondThread(page, threads);
    const gutter = page.getByRole("button", { name: "2 threads on line 3", exact: true });
    await gutter.click();

    // When the chooser is dismissed without selecting a thread
    await page.keyboard.press("Escape");

    // Then its original gutter is ready for another keyboard action
    await expect(gutter).toBeFocused();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  test("file comments lists same-line roots separately without a detail switcher", async () => {
    // Given two independent roots on the same line
    await addSecondThread(page, threads);
    await page.getByRole("button", { name: /^Comments \(/ }).click();
    await expect(page.locator(".file-comment-thread")).toHaveCount(2);

    // When the second root is opened from the list
    await page.locator(".file-comment-thread").filter({ hasText: "Should this return a boolean?" }).click();

    // Then detail contains only that thread, with no sibling-thread buttons
    await expect(page.locator(".comment-detail .markdown-text")).toHaveText(["Should this return a boolean?"]);
    await expect(page.getByRole("navigation", { name: "Threads on this line" })).toHaveCount(0);
  });
  test("rapid Space acknowledgements retain both messages while the first save is held", async () => {
    // Given two unread messages and a held receipt request
    threads[0].messages.push({ id: "second", sequence: 2, author: "agent", body: "Second question", createdAt: "2026-10-17T12:01:00Z" });
    await page.reload();
    const pending = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    await page.route("**/comment-reads", async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      started.resolve();
      await pending.promise;
      return route.fallback();
    });
    await page.getByRole("button", { name: "2 unread comments on line 3", exact: true }).click();

    // When both messages are read before the first save completes
    await expect(page.locator("[data-comment-message]").first()).toBeFocused();
    await page.keyboard.press("Space");
    await started.promise;
    await expect(page.locator("[data-comment-message]").nth(1)).toBeFocused();
    await page.keyboard.press("Space");
    await expect(page.getByRole("button", { name: "Comment read", exact: true })).toHaveCount(2);
    pending.resolve();

    // Then both receipts are durable
    await expect.poll(() => readKeys).toEqual(["local:first", "local:second"]);
  });

  test("j and k select comments without acknowledging them", async () => {
    // Given two unread messages
    threads[0].messages.push({ id: "second", sequence: 2, author: "agent", body: "Second question", createdAt: "2026-10-17T12:01:00Z" });
    await page.reload();
    await page.getByRole("button", { name: "2 unread comments on line 3", exact: true }).click();

    // When moving forward and back before reading the first comment
    await expect(page.locator("[data-comment-message]").first()).toBeFocused();
    await page.keyboard.press("j");
    await expect(page.locator("[data-comment-message]").nth(1)).toBeFocused();
    await page.keyboard.press("k");
    await expect(page.locator("[data-comment-message]").first()).toBeFocused();
    await page.keyboard.press("Space");

    // Then only the first message has a receipt
    await expect.poll(() => readKeys).toEqual(["local:first"]);
  });

  test("own messages are read and only own messages expose editing", async () => {
    // Given an agent question and the user's reply
    threads[0].messages.push({ id: "mine", sequence: 2, author: "user", body: "My answer", createdAt: "2026-10-17T12:01:00Z" });
    await page.reload();

    // When opening their thread
    await page.getByRole("button", { name: "1 unread comment on line 3", exact: true }).click();

    // Then edit controls and read status respect ownership
    await expect(page.locator("[data-comment-message]").first().getByRole("button", { name: "Edit", exact: true })).toHaveCount(0);
    await expect(page.locator("[data-comment-message]").nth(1).getByRole("button", { name: "Edit", exact: true })).toBeVisible();
    await expect(page.locator("[data-comment-message]").nth(1).getByRole("button", { name: "Comment read", exact: true })).toHaveCount(0);
  });

  test("reading shortcuts leave a reply editor untouched", async () => {
    // Given a focused reply editor in an unread thread
    await page.getByRole("button", { name: "1 unread comment on line 3", exact: true }).click();
    const reply = page.getByRole("textbox", { name: "Thread reply", exact: true });
    await reply.focus();

    // When typing navigation keys and a space
    await page.keyboard.type("j k");

    // Then typing neither navigates nor acknowledges comments
    await expect(reply).toHaveValue("j k");
    expect(readKeys).toEqual([]);
  });
  test("reading another comment retains a failed earlier acknowledgement", async () => {
    // Given two unread messages and a first receipt that fails
    threads[0].messages.push({ id: "second", sequence: 2, author: "agent", body: "Second question", createdAt: "2026-10-17T12:01:00Z" });
    await page.reload();
    let fail = true;
    await page.route("**/comment-reads", (route) => route.request().method() === "POST" && fail ? route.fulfill({ status: 500, json: { error: "Read receipt failed" } }) : route.fallback());
    await page.getByRole("button", { name: "2 unread comments on line 3", exact: true }).click();
    await expect(page.locator("[data-comment-message]").first()).toBeFocused();
    await page.keyboard.press("Space");
    await page.getByText("Read receipt failed", { exact: false }).waitFor();

    // When the next comment is read after connectivity recovers
    fail = false;
    await page.keyboard.press("Space");

    // Then the newer save retains the failed receipt as well
    await expect.poll(() => readKeys).toEqual(["local:first", "local:second"]);
  });
  test("Space in the list reads every message and advances before the save completes", async () => {
    // Given a multi-message thread followed by a second thread
    threads[0].messages.push({ id: "reply", sequence: 2, author: "agent", body: "Another question", createdAt: "2026-10-17T12:01:00Z" });
    await addSecondThread(page, threads);
    const held = Promise.withResolvers<void>();
    await page.route("**/comment-reads", async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      await held.promise;
      return route.fallback();
    });
    await page.getByRole("button", { name: /^Comments \(/ }).click();
    await expect(page.locator(".file-comment-thread").first()).toBeFocused();

    // When Space completes the first thread
    await page.keyboard.press("Space");
    try {
      // Then focus advances and the row is read without opening detail or waiting for persistence
      await expect(page.locator(".file-comment-thread").nth(1)).toBeFocused();
      await expect(page.locator(".file-comment-thread").first().getByText("Unread", { exact: true })).toHaveCount(0);
      await expect(page.locator(".comment-detail")).toHaveCount(0);
    } finally { held.resolve(); }
    await expect.poll(() => readKeys).toEqual(["local:first", "local:reply"]);
  });
});

/** Reload two independent roots on one line without changing their source coordinates. */
async function addSecondThread(page: Page, threads: ReviewThread[]) {
  threads.push({ ...threads[0], id: "second-thread", messages: [{ id: "second", sequence: 2, author: "user", body: "Should this return a boolean?", createdAt: "2026-10-17T12:01:00Z" }] });
  await page.reload();
  await page.getByRole("button", { name: "2 threads on line 3", exact: true }).waitFor();
}

/** Put a real virtualized source row at the bottom, rather than mocking its geometry. */
async function positionBottomLine(page: Page) {
  const lines = Array.from({ length: 100 }, (_, index) => `+const line${index + 1} = ${index + 1};`).join("\n");
  const patch = `diff --git a/src/reviews.ts b/src/reviews.ts\n--- a/src/reviews.ts\n+++ b/src/reviews.ts\n@@ -0,0 +1,100 @@\n${lines}\n`;
  const revision = { commit_id: "a".repeat(40), change_id: "qwerty", description: "Comment placement" };
  await page.route("**/review?**", (route) => route.fulfill({ json: {
    workspace: { id: "fixture", name: "fixture", path: "/fixture" }, selected: revision, revisions: [revision], patch, identity: { id: "fixture" },
  } }));
  await page.reload();
  await page.locator("[data-biff-focused]").waitFor();
  await page.getByRole("main", { name: "Diff reading surface" }).evaluate((element) => { element.scrollTop = 57 * 35; });
  const row = page.locator('[data-content] > [data-line]').filter({ hasText: "const line60 = 60;" });
  await row.click();
  await row.evaluate((element) => {
    const viewport = (element.getRootNode() as ShadowRoot).host.closest<HTMLElement>(".viewport")!;
    viewport.scrollTop += element.getBoundingClientRect().bottom - viewport.getBoundingClientRect().bottom + 24;
  });
}
