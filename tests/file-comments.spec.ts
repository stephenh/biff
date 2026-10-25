import { chromium, expect, test, type Browser, type Page } from "@playwright/test";
import type { Conversation } from "../shared/types";
import { createTwoFilesPatch } from "diff";
import { identifyChanges } from "../src/changeProgress";
import { parseInput } from "../src/patches";

test.describe("File comments", () => {
  let browser: Browser;
  let page: Page;
  let conversation: Conversation;
  let resolutionWrites: { id: string; resolved: boolean }[];
  test.beforeAll(async () => { browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium" }); });
  test.afterAll(async () => { await browser.close(); });
  test.afterEach(async () => { await page.close(); });
  test.beforeEach(async () => {
    page = await browser.newPage({ baseURL: "http://127.0.0.1:5173", reducedMotion: "reduce" });
    const patch = ["src/example.ts", "src/other.ts"].map((path) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old value\n+new value\n`).join("");
    resolutionWrites = [];
    conversation = { comments: [], reviews: [], inline: [
      { id: 1, path: "src/example.ts", line: 1, side: "RIGHT", body: "Current discussion", user: { login: "alice" }, html_url: "" },
      { id: 2, path: "src/example.ts", line: null, original_line: 1, side: "RIGHT", body: "Orphaned discussion", user: { login: "bob" }, html_url: "" },
      { id: 3, in_reply_to_id: 2, body: "An older reply", user: { login: "alice" }, html_url: "" },
      { id: 4, path: "src/removed.ts", line: null, original_line: 50, side: "RIGHT", body: "Discussion on a missing file", user: { login: "bob" }, html_url: "" },
      { id: 5, path: "src/other.ts", line: 1, side: "RIGHT", body: "Other file discussion", user: { login: "alice" }, html_url: "" },
    ] };
    for (const comment of conversation.inline.filter((comment) => !comment.in_reply_to_id)) {
      comment.reviewThread = { id: `thread-${comment.id}`, resolved: false, canResolve: true, canReopen: true };
    }
    await page.route("**/api/**", (route) => {
      const path = new URL(route.request().url()).pathname;
      let json: unknown = [];
      if (path.endsWith("/review")) json = { pr: { title: "File comments fixture", user: { login: "author" }, head: { sha: "a".repeat(40) }, base: { sha: "b".repeat(40) } }, commit: "all", commits: [], patch };
      else if (path.endsWith("/conversation")) json = conversation;
      else if (path.endsWith("/thread")) {
        const body = route.request().postDataJSON() as { id: string; resolved: boolean };
        resolutionWrites.push(body);
        const target = conversation.inline.find((comment) => comment.reviewThread?.id === body.id)?.reviewThread;
        if (target) target.resolved = body.resolved;
        json = { saved: true };
      }
      else if (path.endsWith("/discussion")) json = { identity: { id: "fixture" }, threads: [], version: 0 };
      else if (path.endsWith("/viewed")) json = { files: {} };
      else if (path.endsWith("/identity") || path.endsWith("/stack")) json = null;
      return route.fulfill({ json });
    });
    await page.goto("/pr/example/repo/1");
    await page.getByRole("button", { name: /^Comments \(/ }).waitFor();
    await page.locator("[data-biff-focused]").waitFor();
  });

  test("the shared file bar keeps the review controls in order", async () => {
    // Given a loaded PR
    // When the file controls are shown
    // Then hunk progress, Reviewed, follow-ups and comments keep their reading order
    await expect(page.getByRole("navigation", { name: "File review controls" })).toHaveText("0/1 ReviewedFollow-ups (0)Comments (3)");
  });

  test("current and orphaned comments stay together under their file", async () => {
    // Given current and outdated discussions on the same line
    // When file comments opens
    await page.getByRole("button", { name: "Comments (3)", exact: true }).click();

    // Then both threads and their replies appear under the file
    await expect(page.getByRole("dialog", { name: "File comments", exact: true }).getByRole("region", { name: "src/example.ts", exact: true }).locator(".file-comment-message > .markdown-text")).toHaveText(["Current discussion", "Orphaned discussion", "An older reply"]);
  });

  test("comments on files absent from the patch remain accessible", async () => {
    // Given a discussion on a file absent from the diff
    // When file comments opens
    await page.getByRole("button", { name: "Comments (3)", exact: true }).click();

    // Then the missing file keeps its own orphaned discussion group
    await expect(page.getByRole("region", { name: "src/removed.ts", exact: true }).locator(".file-comment-message > .markdown-text")).toHaveText("Discussion on a missing file");
  });

  test("C opens file comments rather than the line composer", async () => {
    // Given a selected diff line
    // When Shift+C is pressed
    await page.keyboard.press("Shift+C");

    // Then only the file comments dialog opens
    await expect(page.getByRole("dialog")).toHaveAccessibleName("File comments");
  });

  test("j and k move focus between threads", async () => {
    // Given file comments focused on the first current thread
    await page.getByRole("button", { name: "Comments (3)", exact: true }).click();

    // When the reader moves down, back up, then down
    await page.keyboard.press("j");
    await page.keyboard.press("k");
    await page.keyboard.press("j");

    // Then the next current thread receives focus before any orphaned threads
    await expect(page.locator(".file-comment-thread").filter({ hasText: "Other file discussion" })).toBeFocused();
  });

  test("Enter focuses the orphaned thread's read acknowledgement", async () => {
    // Given the orphaned thread is selected
    await page.getByRole("button", { name: /^Comments \(/ }).click();
    await focusOrphanedThread(page);

    // When the thread is opened
    await page.keyboard.press("Enter");

    // Then Enter can explicitly acknowledge the displayed thread
    await expect(page.getByRole("button", { name: "Mark read", exact: true })).toBeFocused();
  });

  test("Enter opens the selected thread's reply composer", async () => {
    // Given an orphaned thread is focused
    await page.getByRole("button", { name: "Comments (3)", exact: true }).click();
    await focusOrphanedThread(page);

    // When Enter is pressed on the thread
    await page.keyboard.press("Enter");

    // Then its existing discussion is shown inside file comments
    await expect(page.getByRole("dialog", { name: "File comments", exact: true }).locator(".discussion-comment .markdown-text")).toHaveText(["Orphaned discussion", "An older reply"]);
  });

  test("replying uses the orphaned root comment rather than its reused line", async () => {
    // Given the orphaned thread's reply composer
    await page.getByRole("button", { name: "Comments (3)", exact: true }).click();
    await focusOrphanedThread(page);
    await page.keyboard.press("Enter");
    await page.getByRole("combobox", { name: "Thread reply", exact: true }).fill("Still worth fixing");

    // When the reply is saved
    const request = page.waitForRequest((request) => request.url().endsWith("/comment") && request.method() === "POST");
    await page.getByRole("button", { name: "Save as Comment", exact: true }).click();

    // Then it targets the original GitHub thread
    expect((await request).postDataJSON()).toEqual({ body: "Still worth fixing", replyTo: 2 });
  });

  test("Escape returns from a thread to its position in file comments", async () => {
    // Given an open thread inside file comments
    await page.getByRole("button", { name: "Comments (3)", exact: true }).click();
    await focusOrphanedThread(page);
    await page.keyboard.press("Enter");
    await page.getByRole("combobox", { name: "Thread reply", exact: true }).waitFor();

    // When the reply is dismissed
    await page.keyboard.press("Escape");

    // Then the same orphaned thread keeps keyboard focus
    await expect(page.locator(".file-comment-thread").filter({ hasText: "Orphaned discussion" })).toBeFocused();
  });

  test("opening from another file focuses that file's comments", async () => {
    // Given the second file is selected
    await page.keyboard.press("l");
    await page.getByRole("button", { name: "Comments (1/4)", exact: true }).waitFor();

    // When file comments opens
    await page.keyboard.press("Shift+C");

    // Then the second file's thread receives focus
    await expect(page.locator(".file-comment-thread").filter({ hasText: "Other file discussion" })).toBeFocused();
  });

  test("orphaned threads do not acquire a gutter badge on a reused line", async () => {
    // Given current and outdated discussions both name line one
    // When the current diff renders
    // Then only the current comment contributes to its line badge
    await expect(page.locator("[data-biff-comments]")).toHaveAttribute("title", "1 unread · 1 comment");
  });

  test("Enter navigates into the thread without opening another dialog", async () => {
    // Given an orphaned thread selected in file comments
    await page.getByRole("button", { name: "Comments (3)", exact: true }).click();
    await focusOrphanedThread(page);

    // When the reader navigates into the thread
    await page.keyboard.press("Enter");
    await page.getByRole("combobox", { name: "Thread reply", exact: true }).waitFor();

    // Then file comments remains the only modal
    await expect(page.locator("dialog[open]")).toHaveCount(1);
  });

  test("the Back action returns to the selected thread", async () => {
    // Given an orphaned thread open inside file comments
    await page.getByRole("button", { name: "Comments (3)", exact: true }).click();
    await focusOrphanedThread(page);
    await page.keyboard.press("Enter");

    // When Back is clicked
    await page.getByRole("button", { name: "Back to file comments", exact: true }).click();

    // Then the original thread regains focus
    await expect(page.locator(".file-comment-thread").filter({ hasText: "Orphaned discussion" })).toBeFocused();
  });

  test("Back retains an unsent reply when the thread is reopened", async () => {
    // Given an unsent reply in an orphaned thread
    await page.getByRole("button", { name: "Comments (3)", exact: true }).click();
    await focusOrphanedThread(page);
    await page.keyboard.press("Enter");
    await page.getByRole("combobox", { name: "Thread reply", exact: true }).fill("Keep this draft");

    // When the reader goes back and reopens the same thread
    await page.getByRole("button", { name: "Back to file comments", exact: true }).click();
    await page.keyboard.press("Enter");

    // Then the draft remains in the reply box
    await expect(page.getByRole("combobox", { name: "Thread reply", exact: true })).toHaveValue("Keep this draft");
  });

  test("thread navigation shortcuts remain ordinary text while replying", async () => {
    // Given a focused reply box
    await page.getByRole("button", { name: "Comments (3)", exact: true }).click();
    await page.keyboard.press("Enter");
    await page.getByRole("combobox", { name: "Thread reply", exact: true }).waitFor();
    await page.getByRole("combobox", { name: "Thread reply", exact: true }).focus();

    // When the reader types navigation keys and a newline
    await page.keyboard.type("jkru");
    await page.keyboard.press("Enter");
    await page.keyboard.type("gc");

    // Then typing does not navigate away from the reply
    await expect(page.getByRole("combobox", { name: "Thread reply", exact: true })).toHaveValue("jkru\ngc");
  });

  test("failed background replies retain their text when the thread reopens", async () => {
    // Given a thread whose reply will be rejected
    await page.route("**/comment", (route) => route.fulfill({ status: 500, json: { error: "Reply rejected" } }));
    // And an unsent reply
    await page.getByRole("button", { name: "Comments (3)", exact: true }).click();
    await page.keyboard.press("Enter");
    await page.getByRole("combobox", { name: "Thread reply", exact: true }).fill("Keep this failed reply");

    // When the reply fails
    await page.getByRole("button", { name: "Save as Comment", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "Reply rejected" }).waitFor();
    await page.getByRole("button", { name: "Comments (3)", exact: true }).click();
    await page.keyboard.press("Enter");

    // Then the failed text remains available after reopening the thread
    await expect(page.getByRole("dialog", { name: "File comments", exact: true }).getByRole("combobox", { name: "Thread reply", exact: true })).toHaveValue("Keep this failed reply");
  });

  test("replies are indented beneath their root comment", async () => {
    // Given a file with a multi-message thread
    // When its comments list opens
    await page.getByRole("button", { name: "Comments (3)", exact: true }).click();
    const thread = page.locator(".file-comment-thread").filter({ hasText: "Orphaned discussion" });
    const root = await thread.locator(":scope > .file-comment-message").boundingBox();
    const reply = await thread.locator(".file-comment-replies .file-comment-message").boundingBox();

    // Then the reply is visibly nested beneath the root
    expect(reply!.x).toBeGreaterThan(root!.x);
  });

  test("file navigation occupies seventy percent of the shared bar", async () => {
    // Given the loaded file bar
    // When its navigation area is measured
    const bar = await page.getByRole("region", { name: "File navigation", exact: true }).boundingBox();
    const files = await page.locator(".file-navigation").boundingBox();

    // Then files occupy the left seventy percent of the available width
    expect(files!.width / bar!.width).toBeCloseTo(0.7, 2);
  });

  test("file stats share the file selector's row", async () => {
    // Given file navigation and review controls
    // When their row positions are measured
    const files = await page.locator(".file-navigation").boundingBox();
    const stats = await page.getByRole("navigation", { name: "File review controls", exact: true }).boundingBox();

    // Then review controls no longer consume a separate row
    expect(stats!.y).toEqual(files!.y);
  });

  test("the repo and PR number beneath the title link to GitHub", async () => {
    // Given a loaded PR
    // When the metadata beneath its title is shown
    const link = page.locator(".review-metadata").getByRole("link", { name: "example/repo #1", exact: true });

    // Then the metadata opens the same PR on GitHub
    await expect(link).toHaveAttribute("href", "https://github.com/example/repo/pull/1");
  });

  test("the comments list omits file-path headings and the current-file label", async () => {
    // Given a loaded PR with comments across files
    // When file comments opens
    await page.getByRole("button", { name: "Comments (3)", exact: true }).click();

    // Then only the modal title is rendered as a heading
    await expect(page.getByRole("dialog", { name: "File comments", exact: true }).getByRole("heading")).toHaveText(["File comments"]);
  });

  test("the comment count and shortcuts sit above the comments", async () => {
    // Given file comments is open
    await page.getByRole("button", { name: "Comments (3)", exact: true }).click();

    // When the summary and comments positions are measured
    const tools = await page.locator(".file-comments-tools").boundingBox();
    const body = await page.locator(".file-comments-body").boundingBox();

    // Then the count and shortcuts appear before the scrollable comments
    expect(tools!.y + tools!.height).toBeLessThanOrEqual(body!.y);
  });

  test("r resolves the selected GitHub thread instead of opening a reply", async () => {
    // Given an orphaned thread selected in the list
    await page.getByRole("button", { name: "Comments (3)", exact: true }).click();
    await focusOrphanedThread(page);

    // When resolve is pressed
    await page.keyboard.press("r");
    await page.getByRole("button", { name: "Unresolve thread", exact: true }).waitFor();

    // Then GitHub receives the original thread ID and explicit resolved state
    await expect.poll(() => resolutionWrites).toEqual([{ id: "thread-2", resolved: true }]);
  });

  test("resolving a thread collapses its message bodies", async () => {
    // Given an orphaned discussion with a reply
    await page.getByRole("button", { name: "Comments (3)", exact: true }).click();
    await focusOrphanedThread(page);

    // When it is resolved
    await page.keyboard.press("r");
    await page.getByRole("button", { name: "Unresolve thread", exact: true }).waitFor();

    // Then its full message previews are collapsed
    await expect(page.locator(".file-comment-thread").filter({ hasText: "Orphaned discussion" }).locator(".file-comment-message")).toHaveCount(0);
  });

  test("u leaves the selected resolved thread unchanged in the list", async () => {
    // Given a resolved orphaned discussion
    conversation.inline[1].reviewThread!.resolved = true;
    await page.reload();
    await page.getByRole("button", { name: /^Comments \(/ }).click();
    await focusOrphanedThread(page);

    // When unresolve is pressed
    await page.keyboard.press("u");

    // Then the original discussion remains resolved
    await expect(page.locator(".file-comment-thread").filter({ hasText: "Orphaned discussion" })).toHaveAttribute("data-resolved", "");
  });

  test("Enter opens a collapsed resolved thread for reading", async () => {
    // Given a resolved orphaned discussion
    conversation.inline[1].reviewThread!.resolved = true;
    await page.reload();
    await page.getByRole("button", { name: "Comments (3)", exact: true }).click();
    await focusOrphanedThread(page);

    // When the collapsed thread is opened
    await page.keyboard.press("Enter");

    // Then the complete discussion is readable inside the same modal
    await expect(page.locator(".comment-detail .discussion-comment .markdown-text")).toHaveText(["Orphaned discussion", "An older reply"]);
  });

  test("r resolves a drilled-in thread without discarding its reply draft", async () => {
    // Given an open orphaned thread and an unsent reply
    await page.getByRole("button", { name: "Comments (3)", exact: true }).click();
    await focusOrphanedThread(page);
    await page.keyboard.press("Enter");
    await page.getByRole("combobox", { name: "Thread reply", exact: true }).fill("Keep this while resolving");
    // And focus is outside the text field
    await page.getByRole("button", { name: "Back to file comments", exact: true }).focus();

    // When the open thread is resolved
    await page.keyboard.press("r");
    await page.getByRole("button", { name: "Unresolve thread", exact: true }).waitFor();

    // Then the draft remains in the open thread
    await expect(page.getByRole("combobox", { name: "Thread reply", exact: true })).toHaveValue("Keep this while resolving");
  });

  test("u unresolves a drilled-in thread", async () => {
    // Given a resolved thread opened for reading
    conversation.inline[1].reviewThread!.resolved = true;
    await page.reload();
    await page.getByRole("button", { name: /^Comments \(/ }).click();
    await focusOrphanedThread(page);
    await page.keyboard.press("Enter");
    // And focus is outside the reply box
    await page.getByRole("button", { name: "Back to file comments", exact: true }).focus();

    // When unresolve is pressed
    await page.keyboard.press("u");
    await page.getByRole("button", { name: "Resolve thread", exact: true }).waitFor();

    // Then the existing GitHub thread is explicitly reopened
    await expect.poll(() => resolutionWrites).toEqual([{ id: "thread-2", resolved: false }]);
  });

  test("rejected resolution leaves the thread expanded", async () => {
    // Given GitHub will reject resolving the thread
    await page.route("**/thread", (route) => route.fulfill({ status: 403, json: { error: "Cannot resolve this thread" } }));
    // And an orphaned discussion is selected
    await page.getByRole("button", { name: "Comments (3)", exact: true }).click();
    await focusOrphanedThread(page);

    // When resolution fails
    await page.keyboard.press("r");
    await page.getByRole("alert").filter({ hasText: "Cannot resolve this thread" }).waitFor();

    // Then the thread remains expanded with its reply
    await expect(page.locator(".file-comment-thread").filter({ hasText: "Orphaned discussion" }).locator(".file-comment-message > .markdown-text")).toHaveText(["Orphaned discussion", "An older reply"]);
  });

  test("resolution shortcuts respect GitHub permissions", async () => {
    // Given the current thread cannot be resolved by this user
    conversation.inline[0].reviewThread!.canResolve = false;
    await page.reload();
    await page.getByRole("button", { name: "Comments (3)", exact: true }).click();

    // When resolve is pressed
    await page.keyboard.press("r");

    // Then no GitHub write is attempted
    expect(resolutionWrites).toEqual([]);
  });

  test("resolving collapses the thread before its background request finishes", async () => {
    // Given a resolution request held by the server
    const held = Promise.withResolvers<void>();
    await page.route("**/thread", async (route) => { await held.promise; await route.fallback(); });
    // And an orphaned thread selected in file comments
    await page.getByRole("button", { name: "Comments (3)", exact: true }).click();
    await focusOrphanedThread(page);

    try {
      // When resolve is pressed while the server is still waiting
      await page.keyboard.press("r");
      await page.locator(".file-comments-tools .background-save-summary").filter({ hasText: "Saving 1 change…" }).waitFor();

      // Then the selected thread is already collapsed
      await expect(page.locator(".file-comment-thread").filter({ hasText: "Orphaned discussion" })).toHaveAttribute("data-resolved", "");
    } finally {
      held.resolve();
      await page.locator(".file-comments-tools .background-save-summary").filter({ hasText: /^Saved$/ }).waitFor();
    }
  });

  test("unresolving expands the thread before its background request finishes", async () => {
    // Given a resolved thread and a held unresolve request
    conversation.inline[1].reviewThread!.resolved = true;
    await page.reload();
    const held = Promise.withResolvers<void>();
    await page.route("**/thread", async (route) => { await held.promise; await route.fallback(); });
    // And the thread is opened from its collapsed row
    await page.getByRole("button", { name: /^Comments \(/ }).click();
    await focusOrphanedThread(page);
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "Back to file comments", exact: true }).focus();

    try {
      // When the reader unresolves it
      await page.keyboard.press("u");
      await page.keyboard.press("Escape");

      // Then the messages expand without waiting for the server
      await expect(page.locator(".file-comment-thread").filter({ hasText: "Orphaned discussion" }).locator(".file-comment-message > .markdown-text")).toHaveText(["Orphaned discussion", "An older reply"]);
    } finally {
      held.resolve();
      await page.locator(".file-comments-tools .background-save-summary").filter({ hasText: /^Saved$/ }).waitFor();
    }
  });

  test("another thread can save while the first is still pending", async () => {
    // Given the first thread's resolution request is held
    const held = Promise.withResolvers<void>();
    await page.route("**/thread", async (route) => {
      if (route.request().postDataJSON().id === "thread-1") await held.promise;
      await route.fallback();
    });
    // And file comments is focused on that thread
    await page.getByRole("button", { name: "Comments (3)", exact: true }).click();

    try {
      // When the reader resolves it, moves down, and resolves the next thread
      await page.keyboard.press("r");
      await page.keyboard.press("j");
      await page.keyboard.press("r");

      // Then the second thread can reach the server independently
      await expect.poll(() => resolutionWrites).toEqual([{ id: "thread-5", resolved: true }]);
    } finally {
      held.resolve();
      await page.locator(".file-comments-tools .background-save-summary").filter({ hasText: /^Saved$/ }).waitFor();
    }
  });

  test("rapid resolution reversals save in user order", async () => {
    // Given the first write is held by the server
    const held = Promise.withResolvers<void>();
    await page.route("**/thread", async (route) => { await held.promise; await route.fallback(); });
    await page.getByRole("button", { name: /^Comments \(/ }).click();
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "Back to file comments", exact: true }).focus();

    try {
      // When the reader resolves and immediately reopens the same thread
      await page.keyboard.press("r");
      await page.keyboard.press("u");
    } finally { held.resolve(); }
    await page.locator(".file-comments-tools .background-save-summary").filter({ hasText: /^Saved$/ }).waitFor();

    // Then the final server state follows the reader's latest intent
    expect(resolutionWrites).toEqual([{ id: "thread-1", resolved: true }, { id: "thread-1", resolved: false }]);
  });

  test("reopening the modal retains a pending optimistic change", async () => {
    // Given a held resolution request
    const held = Promise.withResolvers<void>();
    await page.route("**/thread", async (route) => { await held.promise; await route.fallback(); });
    await page.getByRole("button", { name: "Comments (3)", exact: true }).click();
    // And a thread has been optimistically resolved
    await page.keyboard.press("r");

    try {
      // When the comments modal is closed and reopened
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "Comments (3)", exact: true }).click();

      // Then the unresolved server snapshot does not undo the pending collapse
      await expect(page.locator(".file-comment-thread").filter({ hasText: "Current discussion" })).toHaveAttribute("data-resolved", "");
    } finally {
      held.resolve();
      await page.locator(".file-comments-tools .background-save-summary").filter({ hasText: /^Saved$/ }).waitFor();
    }
  });

  test("failed background saves have a working retry", async () => {
    // Given the first resolution attempt will fail
    let attempts = 0;
    await page.route("**/thread", async (route) => {
      if (++attempts === 1) await route.fulfill({ status: 503, json: { error: "Temporary save failure" } });
      else await route.fallback();
    });
    // And the reader has attempted to resolve a thread
    await page.keyboard.press("Shift+C");
    await page.keyboard.press("r");
    await page.getByRole("alert").filter({ hasText: "Temporary save failure" }).waitFor();

    // When Retry is clicked
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await page.locator(".file-comments-tools .background-save-summary").filter({ hasText: /^Saved$/ }).waitFor();

    // Then the failed resolve is retried and persisted
    expect(resolutionWrites).toEqual([{ id: "thread-1", resolved: true }]);
  });

  test("background failures remain visible after navigating away", async () => {
    // Given a held request that will fail
    const held = Promise.withResolvers<void>();
    await page.route("**/thread", async (route) => { await held.promise; await route.fulfill({ status: 503, json: { error: "Save failed after leaving" } }); });
    // And a resolution has been started
    await page.getByRole("button", { name: "Comments (3)", exact: true }).click();
    await page.keyboard.press("r");

    try {
      // When the reader closes the modal and navigates away before completion
      await page.keyboard.press("Escape");
      await page.getByRole("link", { name: "Working Copies", exact: true }).click();
    } finally { held.resolve(); }

    // Then the app shell retains the failed save and its retry action
    await expect(page.locator(".background-save-notice").getByRole("alert")).toHaveText("Thread src/example.ts:1: Save failed after leavingRetry");
  });

  test("a refresh failure does not roll back an acknowledged save", async () => {
    // Given the resolution can save but its follow-up refresh will fail
    await page.route("**/conversation", (route) => route.fulfill({ status: 503, json: { error: "Refresh unavailable" } }));
    await page.getByRole("button", { name: "Comments (3)", exact: true }).click();

    // When the resolution is acknowledged and the refresh fails
    const refresh = page.waitForResponse((response) => response.url().endsWith("/conversation") && response.status() === 503);
    await page.keyboard.press("r");
    await refresh;
    await page.locator(".file-comments-tools .background-save-summary").filter({ hasText: /^Saved$/ }).waitFor();

    // Then the server-acknowledged resolution stays collapsed
    await expect(page.locator(".file-comment-thread").filter({ hasText: "Current discussion" })).toHaveAttribute("data-resolved", "");
  });

  test("unsaved work is protected from an accidental browser reload", async () => {
    // Given a held background write
    const held = Promise.withResolvers<void>();
    await page.route("**/thread", async (route) => { await held.promise; await route.fallback(); });
    await page.getByRole("button", { name: "Comments (3)", exact: true }).click();
    await page.keyboard.press("r");

    try {
      // When the browser checks whether it can unload the app
      // Then the pending write requests an unsaved-work warning
      await expect.poll(() => page.evaluate(() => !window.dispatchEvent(new Event("beforeunload", { cancelable: true })))).toEqual(true);
    } finally {
      held.resolve();
      await page.locator(".file-comments-tools .background-save-summary").filter({ hasText: /^Saved$/ }).waitFor();
    }
  });

  test("orphaned threads follow current threads from all files", async () => {
    // Given current discussions on two files and orphaned discussions on existing and missing files
    // When file comments opens
    await page.getByRole("button", { name: "Comments (3)", exact: true }).click();

    // Then every current discussion appears before the orphaned discussions
    await expect(page.locator(".file-comments-body .file-comment-message > .markdown-text")).toHaveText(["Current discussion", "Other file discussion", "Orphaned discussion", "An older reply", "Discussion on a missing file"]);
  });

  test("j reclaims diff focus after closing file comments", async () => {
    // Given a comments button that regained focus after its modal closed
    await page.getByRole("button", { name: "Comments (3)", exact: true }).click();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Comments (3)", exact: true }).focus();

    // When keyboard reading resumes, even at the last line of this small file
    await page.keyboard.press("j");

    // Then focus belongs to the diff rather than the toolbar button
    await expect(page.getByRole("main", { name: "Diff reading surface", exact: true })).toBeFocused();
  });

  test("k clears focus from other toolbar buttons", async () => {
    // Given a toolbar button has keyboard focus
    await page.getByRole("button", { name: "Find in review", exact: true }).focus();

    // When the reader moves up in the diff
    await page.keyboard.press("k");

    // Then the reading surface takes keyboard focus
    await expect(page.getByRole("main", { name: "Diff reading surface", exact: true })).toBeFocused();
  });

  test("Space reviews the hunk after j resumes reading", async () => {
    // Given the reader closed the comments modal and returned to line navigation
    await page.getByRole("button", { name: "Comments (3)", exact: true }).click();
    await page.keyboard.press("Escape");
    await page.keyboard.press("j");

    // When Space is pressed
    const request = page.waitForRequest((request) => request.url().endsWith("/progress") && request.method() === "POST");
    await page.keyboard.press("Space");

    // Then it reviews the selected hunk instead of reopening comments
    expect((await request).postDataJSON()).toMatchObject({ path: "src/example.ts", reviewed: true });
  });

  test("Space still activates a deliberately focused comments button", async () => {
    // Given keyboard focus is intentionally on the comments button
    await page.getByRole("button", { name: "Comments (3)", exact: true }).focus();

    // When Space is used without resuming diff navigation
    await page.keyboard.press("Space");

    // Then native button activation remains available
    await expect(page.getByRole("dialog", { name: "File comments", exact: true })).toBeVisible();
  });

  test("saving a GitHub reply closes the whole modal before the response", async () => {
    // Given a reply whose GitHub request is held
    const held = Promise.withResolvers<void>();
    await page.route("**/comment", async (route) => { await held.promise; await route.fallback(); });
    // And a reply composed inside file comments
    await page.getByRole("button", { name: "Comments (3)", exact: true }).click();
    await page.keyboard.press("Enter");
    await page.getByRole("combobox", { name: "Thread reply", exact: true }).fill("Save this in the background");

    try {
      // When the reply is submitted
      await page.getByRole("button", { name: "Save as Comment", exact: true }).click();

      // Then no dialog remains while the request is pending
      await expect(page.locator("dialog[open]")).toHaveCount(0);
    } finally {
      held.resolve();
      await page.locator(".background-save-notice .background-save-summary").filter({ hasText: /^Saved$/ }).waitFor();
    }
  });

  test("a new inline comment closes immediately while saving", async () => {
    // Given a line without an existing thread and a held publication request
    conversation.inline = [];
    await page.reload();
    await page.getByRole("button", { name: "Comments (0)", exact: true }).waitFor();
    const held = Promise.withResolvers<void>();
    await page.route("**/inline-comment", async (route) => { await held.promise; await route.fulfill({ json: { id: 99 } }); });
    // And a new inline comment
    await page.locator("[data-biff-focused]").waitFor();
    await page.keyboard.press("c");
    await page.getByRole("combobox", { name: "Inline comment", exact: true }).fill("A new background comment");

    try {
      // When it is submitted
      await page.getByRole("button", { name: "Save as Comment", exact: true }).click();

      // Then the composer closes before GitHub responds
      await expect(page.locator("dialog[open]")).toHaveCount(0);
    } finally {
      held.resolve();
      await page.locator(".background-save-notice .background-save-summary").filter({ hasText: /^Saved$/ }).waitFor();
    }
  });

  test("a GitHub reply retries with the original submission ID and text", async () => {
    // Given a publication that fails once
    const attempts: { id: string | undefined; body: unknown }[] = [];
    await page.route("**/comment", async (route) => {
      attempts.push({ id: route.request().headers()["idempotency-key"], body: route.request().postDataJSON() });
      if (attempts.length === 1) await route.fulfill({ status: 503, json: { error: "Publication interrupted" } });
      else await route.fallback();
    });
    // And a reply is submitted from file comments
    await page.getByRole("button", { name: "Comments (3)", exact: true }).click();
    await page.keyboard.press("Enter");
    await page.getByRole("combobox", { name: "Thread reply", exact: true }).fill("Do not lose or duplicate this reply");
    await page.getByRole("button", { name: "Save as Comment", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "Publication interrupted" }).waitFor();

    // When the background error is retried
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await page.locator(".background-save-notice .background-save-summary").filter({ hasText: /^Saved$/ }).waitFor();

    // Then the same immutable submission is retried
    expect(attempts).toEqual([{ id: expect.any(String), body: { body: "Do not lose or duplicate this reply", replyTo: 1 } }, attempts[0]]);
  });

  test("an old background completion does not clear a newer reply draft", async () => {
    // Given a submitted reply whose response is held
    const held = Promise.withResolvers<void>();
    await page.route("**/comment", async (route) => { await held.promise; await route.fallback(); });
    await page.getByRole("button", { name: "Comments (3)", exact: true }).click();
    await page.keyboard.press("Enter");
    await page.getByRole("combobox", { name: "Thread reply", exact: true }).fill("First reply");
    await page.getByRole("button", { name: "Save as Comment", exact: true }).click();
    // And the reader has opened the thread again and typed different text
    await page.getByRole("button", { name: "Comments (3)", exact: true }).click();
    await page.keyboard.press("Enter");
    await page.getByRole("combobox", { name: "Thread reply", exact: true }).fill("Keep this newer draft");

    // When the older publication succeeds
    held.resolve();
    await page.locator(".comment-detail .background-save-summary").filter({ hasText: /^Saved$/ }).waitFor();

    // Then the newer text remains in its open composer
    await expect(page.getByRole("combobox", { name: "Thread reply", exact: true })).toHaveValue("Keep this newer draft");
  });
  test("a neighboring file's unread badge opens its file comments", async () => {
    // Given the first file is selected and the neighboring file has an unread thread
    // When the neighboring file's badge is clicked
    await page.getByRole("button", { name: "1 unread threads in src/other.ts", exact: true }).click();

    // Then file comments opens with that file's thread focused
    await expect(page.getByRole("dialog", { name: "File comments", exact: true }).locator(".file-comment-thread").filter({ hasText: "Other file discussion" })).toBeFocused();
  });
  test("resolving acknowledges the root comment and every reply", async () => {
    // Given an unread thread with a root comment and a reply
    await page.keyboard.press("Shift+C");
    await focusOrphanedThread(page);
    const receipt = page.waitForRequest((request) => request.url().endsWith("/comment-reads") && request.method() === "POST");

    // When the reader explicitly resolves the thread
    await page.keyboard.press("r");

    // Then both displayed comments receive durable read receipts
    expect((await receipt).postDataJSON()).toEqual({ keys: ["github:2", "github:3"] });
  });

  test("resolving clears unread state before background saves complete", async () => {
    // Given held resolution and read requests
    const held = Promise.withResolvers<void>();
    await page.route("**/thread", async (route) => { await held.promise; await route.fallback(); });
    await page.route("**/comment-reads", async (route) => {
      if (route.request().method() === "POST") await held.promise;
      await route.fallback();
    });
    // And an unread thread selected in the unread-only list
    await page.keyboard.press("Shift+C");
    await page.getByRole("checkbox", { name: /^Unread/ }).check();
    await focusOrphanedThread(page);

    try {
      // When its Resolve thread button is clicked
      await page.locator(".file-comment-card").filter({ hasText: "Orphaned discussion" }).getByRole("button", { name: "Resolve thread", exact: true }).click();

      // Then the retained thread no longer shows an unread indicator
      await expect(page.locator(".file-comment-thread").filter({ hasText: "Orphaned discussion" }).getByText("Unread", { exact: true })).toHaveCount(0);
    } finally {
      held.resolve();
      await page.locator(".file-comments-tools .background-save-summary").filter({ hasText: /^Saved$/ }).waitFor();
    }
  });
  test("Space resolves a GitHub thread started by the reader", async () => {
    // Given the reader authored the first thread
    conversation.viewer = "alice";
    await page.reload();
    await page.locator("[data-biff-focused]").waitFor();
    await page.keyboard.press("Shift+C");

    // When the reader completes that thread
    await page.keyboard.press("Space");

    // Then GitHub receives the resolution
    await expect.poll(() => resolutionWrites).toEqual([{ id: "thread-1", resolved: true }]);
  });

  test("Space advances while the reader's GitHub resolution is pending", async () => {
    // Given the reader's resolution request is held
    conversation.viewer = "alice";
    await page.reload();
    await page.locator("[data-biff-focused]").waitFor();
    const held = Promise.withResolvers<void>();
    await page.route("**/thread", async (route) => { await held.promise; await route.fallback(); });
    await page.keyboard.press("Shift+C");

    try {
      // When Space completes the first thread
      await page.keyboard.press("Space");

      // Then focus advances before GitHub acknowledges the save
      await expect(page.locator(".file-comment-thread").filter({ hasText: "Orphaned discussion" })).toBeFocused();
    } finally {
      held.resolve();
      await page.locator(".file-comments-tools .background-save-summary").filter({ hasText: /^Saved$/ }).waitFor();
    }
  });

  test("Space does not resolve someone else's thread when the reader only replied", async () => {
    // Given Bob started the thread and the reader Alice replied
    conversation.viewer = "alice";
    await page.reload();
    await page.locator("[data-biff-focused]").waitFor();
    await page.keyboard.press("Shift+C");
    await focusOrphanedThread(page);

    // When the reader marks the thread read and advances
    await page.keyboard.press("Space");

    // Then the GitHub thread remains unresolved
    expect(resolutionWrites).toEqual([]);
  });
  test("g jumps from a comment to its file", async () => {
    // Given another file's thread selected in the review-wide list
    await page.keyboard.press("Shift+C");
    await page.getByRole("button", { name: /^Entire review/ }).click();
    await page.locator(".file-comment-thread").filter({ hasText: "Other file discussion" }).focus();

    // When the reader goes to its code
    await page.keyboard.press("g");

    // Then that file becomes the active reading surface
    await expect(page.getByLabel("Current file")).toHaveText("other.ts");
  });

  test("g returns keyboard focus to the code", async () => {
    // Given a current thread selected in file comments
    await page.keyboard.press("Shift+C");

    // When the reader goes to its code
    await page.keyboard.press("g");

    // Then the diff has keyboard focus outside the modal
    await expect(page.getByRole("main", { name: "Diff reading surface" })).toBeFocused();
  });
  test("g focuses an already-reviewed later hunk in another file", async () => {
    // Given a comment on the reviewed second hunk of another file
    conversation.inline.find((comment) => comment.id === 5)!.line = 20;
    const patch = ["src/example.ts", "src/other.ts"].map((path) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old first\n+new first\n@@ -20 +20 @@\n-old target\n+new target\n`).join("");
    const blocks = await identifyChanges(parseInput(patch, false));
    await page.route("**/progress", (route) => route.fulfill({ json: blocks.filter((block) => block.path === "src/other.ts" && block.newLine === 20) }));
    await page.route("**/review?*", (route) => route.fulfill({ json: { pr: { title: "Later hunk", user: { login: "author" }, head: { sha: "a".repeat(40) }, base: { sha: "b".repeat(40) } }, commit: "all", commits: [], patch } }));
    await page.reload();
    await page.locator("[data-biff-focused]").waitFor();
    await page.keyboard.press("Shift+C");
    await page.getByRole("button", { name: /^Entire review/ }).click();
    await page.locator(".file-comment-thread").filter({ hasText: "Other file discussion" }).focus();

    // When jumping across files to the comment
    await page.keyboard.press("g");

    // Then the comment's line is focused rather than the first hunk
    await expect(page.locator("[data-biff-focused]")).toHaveAttribute("data-line", "20");
  });
  test("g reveals a comment line omitted from the patch context", async () => {
    // Given a current comment between distant hunks
    conversation.inline[0].line = 12;
    const oldFile = { name: "src/example.ts", contents: Array.from({ length: 30 }, (_, index) => `const line${index + 1} = 0;\n`).join("") };
    const newFile = { ...oldFile, contents: oldFile.contents.replace("line1 = 0", "line1 = 1").replace("line30 = 0", "line30 = 1") };
    const patch = createTwoFilesPatch(oldFile.name, newFile.name, oldFile.contents, newFile.contents);
    await page.route("**/review?*", (route) => route.fulfill({ json: { pr: { title: "Omitted context", user: { login: "author" }, head: { sha: "a".repeat(40) }, base: { sha: "b".repeat(40) } }, commit: "all", commits: [], patch } }));
    await page.route("**/contents", (route) => route.fulfill({ json: { oldFile, newFile } }));
    await page.reload();
    await page.locator("[data-biff-focused]").waitFor();
    await page.keyboard.press("Shift+C");

    // When jumping to its code
    await page.keyboard.press("g");

    // Then the omitted source line is revealed and focused
    await expect(page.locator("[data-biff-focused]")).toHaveText("const line12 = 0;");
  });
  test("a deferred import render cannot undo a comment jump into a hydrated file", async () => {
    // Given a file with folded imports, a first unreviewed hunk, and a later reviewed comment
    conversation.inline[0].line = 90;
    const oldFile = { name: "src/example.ts", contents: ['import {', '  useState,', '} from "react";', ...Array.from({ length: 107 }, (_, index) => `const line${index + 4} = 0;`)].join("\n") + "\n" };
    const newFile = { ...oldFile, contents: oldFile.contents.replace("useState,", "useMemo,").replace("line78 = 0", "line78 = 1").replace("line90 = 0", "line90 = 1") };
    const patch = createTwoFilesPatch(oldFile.name, newFile.name, oldFile.contents, newFile.contents) + createTwoFilesPatch("src/other.ts", "src/other.ts", "old value\n", "new value\n");
    const blocks = await identifyChanges(parseInput(patch, false));
    await page.route("**/progress", (route) => route.fulfill({ json: blocks.filter((block) => block.newLine === 90) }));
    await page.route("**/review?*", (route) => route.fulfill({ json: { pr: { title: "Hydrated imports", user: { login: "author" }, head: { sha: "a".repeat(40) }, base: { sha: "b".repeat(40) } }, commit: "all", commits: [], patch } }));
    await page.route("**/contents", (route) => route.request().postDataJSON().path === oldFile.name ? route.fulfill({ json: { oldFile, newFile } }) : route.fulfill({ status: 503, json: { error: "No source fixture" } }));
    await page.reload();
    await page.locator('[data-biff-focused][data-line="78"]').waitFor();
    // And the reader navigates away before selecting the original file's comment
    await page.keyboard.press("l");
    await expect(page.getByLabel("Current file")).toHaveText("other.ts");
    await page.keyboard.press("Shift+C");
    await page.getByRole("button", { name: /^Entire review/ }).click();
    await page.locator(".file-comment-thread").filter({ hasText: "Current discussion" }).focus();

    // When jumping back to the comment after full source has been cached
    await page.keyboard.press("g");

    // Then post-render work preserves the requested reviewed line
    await expect(page.locator("[data-biff-focused]")).toHaveAttribute("data-line", "90");
  });
});

/** Focus by identity so reply and resolution tests do not depend on the thread's sorted position. */
async function focusOrphanedThread(page: Page) {
  await page.locator(".file-comment-thread").filter({ hasText: "Orphaned discussion" }).focus();
}
