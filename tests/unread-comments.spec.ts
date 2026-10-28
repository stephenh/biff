import { chromium, expect, test, type Browser, type Page } from "@playwright/test";
import type { Conversation } from "../shared/types";
import { inboxPR } from "./inbox-fixture";

test.describe("Unread comment inbox", () => {
  let browser: Browser;
  let page: Page;
  test.beforeAll(async () => { browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium" }); });
  test.afterAll(async () => { await browser.close(); });
  test.afterEach(async () => { await page.close(); });
  test.beforeEach(async () => {
    page = await browser.newPage({ baseURL: "http://127.0.0.1:5173" });
    let keys: string[] = [];
    const pr = { title: "My change", body: "Description belongs in overview", user: { login: "me" }, head: { sha: "a".repeat(40), ref: "feature" }, base: { sha: "b".repeat(40), ref: "main" } };
    const conversation: Conversation = {
      viewer: "me", comments: [{ id: 3, user: { login: "alice" }, body: "Please update the description", html_url: "" }],
      reviews: [{ id: 4, user: { login: "alice" }, body: "One more concern", state: "COMMENTED", html_url: "" }],
      inline: [{ id: 1, path: "file.ts", line: 1, side: "RIGHT", user: { login: "alice" }, body: "Check this constant", html_url: "", reviewThread: { id: "T1", resolved: false, canResolve: true, canReopen: true } }],
    };
    await page.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith("/comment-reads")) {
        if (route.request().method() === "POST") keys = [...new Set([...keys, ...route.request().postDataJSON().keys])];
        return route.fulfill({ json: keys });
      }
      if (path === "/api/inbox") return route.fulfill({ json: { updatedAt: Date.now(), items: [{ ...inboxPR(1, "My change"), repository: { nameWithOwner: "example/repo" }, author: { login: "me" }, unreadThreads: ["github:1", "general:3", "review:4"].filter((key) => !keys.includes(key)).length }] } });
      if (path.endsWith("/metadata")) return route.fulfill({ json: pr });
      if (path.endsWith("/review-draft")) return route.fulfill({ json: { commitId: "a".repeat(40), body: "", comments: [], version: 0 } });
      if (path.endsWith("/review")) return route.fulfill({ json: { pr, commit: "all", commits: [], patch: "diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new\n" } });
      if (path.endsWith("/conversation")) return route.fulfill({ json: conversation });
      if (path.endsWith("/thread")) {
        const body = route.request().postDataJSON();
        if (body.action !== "complete") conversation.inline[0].reviewThread!.resolved = body.resolved;
        if (body.resolved || body.action === "complete") keys = [...new Set([...keys, ...body.keys])];
        return route.fulfill({ json: { ...conversation, commentReads: keys } });
      }
      if (path.endsWith("/discussion")) return route.fulfill({ json: { identity: { id: "fixture" }, threads: [], version: 0 } });
      if (path.endsWith("/identity") || path.endsWith("/stack")) return route.fulfill({ json: null });
      if (path.endsWith("/viewed")) return route.fulfill({ json: { files: {} } });
      return route.fulfill({ json: [] });
    });
  });

  test("dashboard badges use the file-comment browser for all kinds of feedback", async () => {
    // Given a PR with general, review-summary, and inline feedback
    await page.goto("/prs");

    // When its unread badge is opened
    await page.getByRole("button", { name: "3 unread threads on PR 1", exact: true }).click();

    // Then the shared browser presents three thread previews, with no overview content
    await expect(page.getByRole("dialog", { name: "Review comments", exact: true }).locator(".file-comment-thread")).toHaveCount(3);
    await expect(page.getByText("Description belongs in overview", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("combobox", { name: "Review summary", exact: true })).toHaveCount(0);
  });

  test("acknowledging general discussion updates the dashboard after dismissal", async () => {
    // Given the PR-wide comment browser over the inbox
    await openInboxComments(page);
    await openThread(page, "Please update the description");

    // When the general conversation is acknowledged and the modal closed
    await page.getByRole("button", { name: "Mark comment read", exact: true }).click();
    await page.getByRole("button", { name: "Close review comments", exact: true }).click();

    // Then only the other two conversations remain unread
    await expect(page.getByRole("button", { name: "2 unread threads on PR 1", exact: true })).toBeVisible();
  });

  test("opening a thread does not acknowledge it", async () => {
    // Given an unread inline discussion
    await openInboxComments(page);
    await openThread(page, "Check this constant");

    // When the reader returns through Back and then dismisses the list
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Close review comments", exact: true }).click();

    // Then all conversations still need acknowledgement
    await expect(page.getByRole("button", { name: "3 unread threads on PR 1", exact: true })).toBeVisible();
  });

  test("review author tabs summarize unread conversations", async () => {
    // Given a review author's PR has three conversations to read
    await page.goto("/needs-review");

    // When the author tabs load
    const author = page.getByRole("navigation", { name: "Review authors" }).getByRole("link", { name: /^me / });

    // Then its badge carries the conversation count
    await expect(author.locator(".unread-thread-badge")).toHaveText("3");
  });

  test("an inbox badge opens comments without navigating or loading the diff", async () => {
    // Given a filtered list with diff requests recorded
    const diffRequests: string[] = [];
    page.on("request", (request) => { if (new URL(request.url()).pathname.endsWith("/review")) diffRequests.push(request.url()); });
    await page.goto("/needs-review?author=me");
    await page.getByRole("textbox", { name: "Filter PRs" }).fill("My change");

    // When its unread badge opens the conversation list
    await page.getByRole("button", { name: "3 unread threads on PR 1", exact: true }).click();
    await page.locator(".file-comment-thread").first().waitFor();

    // Then the list remains the underlying route and no diff was requested
    await expect(page).toHaveURL("http://127.0.0.1:5173/needs-review?author=me");
    expect(diffRequests).toEqual([]);
  });

  test("Escape returns focus to the badge and preserves the list filter", async () => {
    // Given comments opened over a filtered inbox
    await page.goto("/prs");
    await page.getByRole("textbox", { name: "Filter PRs" }).fill("My change");
    const badge = page.getByRole("button", { name: "3 unread threads on PR 1", exact: true });
    await badge.click();
    await expect(page.locator(".file-comment-thread").first()).toBeFocused();

    // When the reader dismisses with Escape
    await page.keyboard.press("Escape");

    // Then the prior list position remains ready for keyboard navigation
    await expect(badge).toBeFocused();
    await expect(page.getByRole("textbox", { name: "Filter PRs" })).toHaveValue("My change");
  });

  test("closing and reopening a thread retains its unsent reply", async () => {
    // Given a reply draft in a selected thread
    await openInboxComments(page);
    await openThread(page, "Check this constant");
    await page.getByRole("combobox", { name: "Thread reply", exact: true }).fill("Keep this reply");

    // When the modal closes and the same thread reopens
    await page.getByRole("button", { name: "Close review comments", exact: true }).click();
    await page.getByRole("button", { name: "3 unread threads on PR 1", exact: true }).click();
    await openThread(page, "Check this constant");

    // Then the original reply text remains available
    await expect(page.getByRole("combobox", { name: "Thread reply", exact: true })).toHaveValue("Keep this reply");
  });

  test("a failed background reply can retry after the comment browser closes", async () => {
    // Given a reply request held by the server
    const pending = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const submissions: { body: string; replyTo: number; id: string | undefined }[] = [];
    let fail = true;
    await page.route("**/comment", async (route) => {
      submissions.push({ ...route.request().postDataJSON(), id: route.request().headers()["idempotency-key"] });
      started.resolve();
      await pending.promise;
      await route.fulfill({ status: fail ? 500 : 200, json: fail ? { error: "Reply unavailable" } : { id: 5 } });
    });
    await openInboxComments(page);
    await openThread(page, "Check this constant");
    await page.getByRole("combobox", { name: "Thread reply", exact: true }).fill("My reply");

    // When publishing closes the modal before the failed response arrives
    await page.getByRole("button", { name: "Save as Comment", exact: true }).click();
    await started.promise;
    await expect(page.getByRole("dialog")).toHaveCount(0);
    pending.resolve();
    await page.getByRole("button", { name: "Retry", exact: true }).waitFor();
    fail = false;
    await page.getByRole("button", { name: "Retry", exact: true }).click();

    // Then Retry republishes the same immutable submission, not a second comment
    await expect.poll(() => submissions.length).toEqual(2);
    expect(submissions[1]).toEqual(submissions[0]);
    expect(submissions[0].replyTo).toEqual(1);
  });

  test("reading the final thread returns focus to the PR title when its badge disappears", async () => {
    // Given three unread conversations
    await openInboxComments(page);

    // When each thread is acknowledged and the modal closed
    for (const body of ["Please update the description", "One more concern", "Check this constant"]) {
      await openThread(page, body);
      await page.getByRole("button", { name: "Mark comment read", exact: true }).click();
      await page.getByRole("button", { name: "Back to review comments", exact: true }).click();
    }
    await expect(page.locator(".unread-thread-trigger")).toHaveCount(0);
    await page.getByRole("button", { name: "Close review comments", exact: true }).click();

    // Then focus returns to the retained PR row rather than the document body
    await expect(page.getByRole("link", { name: "My change", exact: true })).toBeFocused();
  });

  test("the row menu opens all comments after every thread is read", async () => {
    // Given read receipts covering every conversation
    await page.route("**/comment-reads", (route) => route.fulfill({ json: ["github:1", "general:3", "review:4"] }));
    await page.goto("/prs");

    // When Review comments is opened through the row actions
    await page.getByLabel("Actions for PR 1", { exact: true }).click();
    await page.getByRole("button", { name: "Review comments", exact: true }).click();

    // Then read conversations remain available in the same browser
    await expect(page.locator(".file-comment-thread")).toHaveCount(3);
  });

  test("the list retains its scroll position while comments are open", async () => {
    // Given a PR below the fold in a long inbox
    const items = Array.from({ length: 30 }, (_, index) => ({ ...inboxPR(index + 1, `Change ${index + 1}`), repository: { nameWithOwner: "example/repo" }, author: { login: "me" }, unreadThreads: 3 }));
    await page.route("**/api/inbox?**", (route) => route.fulfill({ json: { updatedAt: Date.now(), items } }));
    await page.goto("/prs");
    const badge = page.getByRole("button", { name: "3 unread threads on PR 20", exact: true });
    await badge.scrollIntoViewIfNeeded();
    const scroll = await page.evaluate(() => window.scrollY);

    // When the reader scrolls over the modal backdrop before dismissing
    await badge.click();
    await page.locator(".file-comment-thread").first().waitFor();
    await page.mouse.move(5, 5);
    await page.mouse.wheel(0, 600);
    await page.getByRole("button", { name: "Close review comments", exact: true }).click();

    // Then the list is still at the same PR
    await expect.poll(() => page.evaluate(() => window.scrollY)).toEqual(scroll);
    await expect(badge).toBeFocused();
  });

  test("PR overview contains metadata and review submission without fetching comments", async () => {
    // Given the inbox with comment requests recorded
    const requests: string[] = [];
    page.on("request", (request) => { if (new URL(request.url()).pathname.endsWith("/conversation")) requests.push(request.url()); });
    await page.goto("/prs");

    // When PR overview is opened from the row menu
    await page.getByLabel("Actions for PR 1", { exact: true }).click();
    await page.getByRole("button", { name: "PR overview", exact: true }).click();

    // Then metadata and submission are separate from the comment browser
    await expect(page.getByRole("dialog", { name: "My change" }).getByText("Description belongs in overview", { exact: true })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Review summary", exact: true })).toBeVisible();
    expect(requests).toEqual([]);
  });

  test("j, Enter, and Escape navigate the same mounted list and embedded thread", async () => {
    // Given the first thread selected in the review-wide browser
    await openInboxComments(page);
    await expect(page.locator(".file-comment-thread").first()).toBeFocused();

    // When the reader opens the next thread and returns with Escape
    await page.keyboard.press("j");
    await page.keyboard.press("Enter");
    await expect(page.locator('[data-comment-message][data-selected="true"]')).toBeFocused();
    await page.keyboard.press("Escape");

    // Then the same second thread is selected in the original modal
    await expect(page.locator(".file-comment-thread").nth(1)).toBeFocused();
    await expect(page.getByRole("dialog")).toHaveCount(1);
  });

  test("the per-file Entire review scope includes PR discussion and review summaries", async () => {
    // Given the same PR open in the diff viewer
    await page.goto("/pr/example/repo/1");
    await page.getByRole("button", { name: /^Comments \(/ }).click();

    // When the file browser switches to the entire review and opens general discussion
    await page.getByRole("button", { name: /^Entire review/ }).click();
    await expect(page.locator(".file-comment-thread")).toHaveCount(3);
    await openThread(page, "Please update the description");

    // Then it uses the same embedded PR conversation and explicit read control
    await expect(page.getByRole("button", { name: "Back to review comments", exact: true })).toBeVisible();
    await expect(page.locator('[data-comment-message][data-selected="true"]')).toBeFocused();
    await expect(page.getByRole("dialog")).toHaveCount(1);
  });

  test("resolution is optimistic and failures remain retryable after dismissal", async () => {
    // Given a resolution request held by the server
    const pending = Promise.withResolvers<void>();
    let fail = true;
    await page.route("**/thread", async (route) => {
      await pending.promise;
      if (fail) return route.fulfill({ status: 500, json: { error: "Resolution unavailable" } });
      return route.fallback();
    });
    await openInboxComments(page);
    const inline = page.locator(".file-comment-thread").filter({ hasText: "Check this constant" });
    await inline.focus();

    // When resolving updates immediately, then fails after closing
    await page.keyboard.press("r");
    await expect(inline).toHaveAttribute("data-resolved", "");
    await page.getByRole("button", { name: "Close review comments", exact: true }).click();
    pending.resolve();
    await page.getByRole("button", { name: "Retry", exact: true }).waitFor();
    fail = false;
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await page.getByRole("button", { name: "3 unread threads on PR 1", exact: true }).click();

    // And the now-read thread is inspected in the full list
    await page.getByRole("checkbox", { name: /^Unread/ }).uncheck();

    // Then the retried resolution is retained in the reopened browser
    await expect(page.locator(".file-comment-thread").filter({ hasText: "Check this constant" })).toHaveAttribute("data-resolved", "");
  });

  test("opening the full diff sends no PR-level read acknowledgement", async () => {
    // Given a PR with requests to its personal-state endpoint recorded
    const writes: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "POST" && new URL(request.url()).pathname.endsWith("/inbox")) writes.push(request.postData() ?? "");
    });

    // When the visible full diff loads and a thread is opened
    await page.goto("/pr/example/repo/1");
    await page.getByRole("button", { name: /^Comments \(/ }).click();
    await openThread(page, "Check this constant");
    await expect(page.getByRole("button", { name: "Mark comment read", exact: true })).toBeVisible();

    // Then navigation has not acknowledged PR activity
    expect(writes).toEqual([]);
  });
  test("GitHub thread reading excludes own replies and restricts edit controls", async () => {
    // Given an unread root, an own reply, and another unread reply in one thread
    await page.route("**/conversation", (route) => route.fulfill({ json: {
      viewer: "me", comments: [], reviews: [], inline: [
        { id: 1, path: "file.ts", line: 1, user: { login: "alice" }, body: "Check this constant", html_url: "" },
        { id: 2, in_reply_to_id: 1, user: { login: "me" }, body: "My reply", html_url: "" },
        { id: 5, in_reply_to_id: 1, user: { login: "alice" }, body: "Another question", html_url: "" },
      ],
    } }));
    await openInboxComments(page);

    // When opening the thread without acknowledging any message
    await openThread(page, "Check this constant");

    // Then only other authors' messages need reading and only the own reply is editable
    await expect(page.getByRole("button", { name: "Mark comment read", exact: true })).toHaveCount(2);
    await expect(page.getByRole("button", { name: "Comment read", exact: true })).toHaveCount(0);
    await expect(page.locator("[data-comment-message]").filter({ has: page.getByRole("button", { name: "Edit", exact: true }) }).locator(".markdown-text")).toHaveText("My reply");
  });
  test("Space reads a whole inbox thread and retains its row while advancing", async () => {
    // Given the unread-only inbox browser
    await openInboxComments(page);
    await expect(page.locator(".file-comment-thread").first()).toBeFocused();

    // When Space marks the first thread done
    await page.keyboard.press("Space");

    // Then its row stays in place and focus advances without opening the thread
    await expect(page.locator(".file-comment-thread")).toHaveCount(3);
    await expect(page.locator(".file-comment-thread").nth(1)).toBeFocused();
    await expect(page.locator(".comment-detail")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "2 unread threads on PR 1", exact: true })).toHaveCount(1);
  });

  test("a list acknowledgement can retry after the browser closes", async () => {
    // Given a failing read receipt from the unread-only inbox
    let fail = true;
    await page.route("**/comment-reads", (route) => route.request().method() === "POST" && fail ? route.fulfill({ status: 500, json: { error: "Receipt unavailable" } }) : route.fallback());
    await openInboxComments(page);
    await expect(page.locator(".file-comment-thread").first()).toBeFocused();

    // When Space fails and the user closes the browser before retrying
    await page.keyboard.press("Space");
    await page.getByText("Receipt unavailable", { exact: false }).waitFor();
    await page.keyboard.press("Escape");
    fail = false;
    await page.getByRole("button", { name: "Retry", exact: true }).click();

    // Then the retried thread receipt updates the inbox
    await expect(page.getByRole("button", { name: "2 unread threads on PR 1", exact: true })).toBeVisible();
  });
  test("GitHub arrows align after read status and own editing controls", async () => {
    // Given another author's comment followed by an own reply
    await page.route("**/conversation", (route) => route.fulfill({ json: {
      viewer: "me", comments: [], reviews: [], inline: [
        { id: 1, path: "file.ts", line: 1, user: { login: "alice" }, body: "Check this constant", html_url: "https://github.com/example/repo/pull/1#discussion_r1" },
        { id: 2, in_reply_to_id: 1, user: { login: "me" }, body: "My reply", html_url: "https://github.com/example/repo/pull/1#discussion_r2" },
      ],
    } }));
    await openInboxComments(page);

    // When viewing both message headers
    await openThread(page, "Check this constant");
    const arrows = await page.locator(".comment-message-actions > a").evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().right));
    const unread = await page.getByRole("button", { name: "Mark comment read", exact: true }).boundingBox();
    const arrow = await page.locator(".comment-message-actions > a").first().boundingBox();

    // Then the arrows share the right edge, after the read indicator
    expect(arrows[0]).toEqual(arrows[1]);
    expect(arrow!.x).toBeGreaterThan(unread!.x + unread!.width);
  });
  test("PR overview renders screenshot tags without executing their HTML attributes", async () => {
    // Given a description with a large screenshot and an untrusted event handler
    await page.route("**/metadata", (route) => route.fulfill({ json: {
      title: "My change", body: 'Before screenshot\n<img width="1600" alt="Updated screen" src="https://github.com/user-attachments/assets/e056a94d-514e-4fe6-af87-25c2d09a1ca0" onload="document.title=\'unsafe\'">\nAfter screenshot',
      user: { login: "me" }, head: { sha: "a".repeat(40), ref: "feature" }, base: { sha: "b".repeat(40), ref: "main" },
    } }));
    await page.route("**/api/github/attachment/e056a94d-514e-4fe6-af87-25c2d09a1ca0", (route) => route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900"><rect width="1600" height="900" fill="green"/></svg>' }));

    // When the overview opens
    await page.goto("/prs");
    await page.getByLabel("Actions for PR 1", { exact: true }).click();
    await page.getByRole("button", { name: "PR overview", exact: true }).click();
    const image = page.getByRole("img", { name: "Updated screen" });
    await expect(image).toBeVisible();

    // Then the screenshot fits the description and only safe image attributes are rendered
    await expect.poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth)).toEqual(1600);
    expect(await image.evaluate((element) => element.getBoundingClientRect().width <= element.parentElement!.getBoundingClientRect().width)).toEqual(true);
    expect(await image.getAttribute("onload")).toEqual(null);
    await expect(page.locator(".pr-description")).toHaveText("Before screenshot\n\nAfter screenshot");
  });
  test("PR descriptions render GitHub Markdown and discard executable HTML", async () => {
    // Given a description containing common GitHub formatting and untrusted HTML
    await page.route("**/metadata", (route) => route.fulfill({ json: {
      title: "My change", body: '# Summary\n\n**Important** with `code` and [details](https://github.com/example/repo).\n\n- [x] Tested\n\n| Column | Value |\n| --- | --- |\n| Status | Ready |\n\n```ts\nconst ready = true;\n```\n\n<script>alert("unsafe")</script>\n<a href="javascript:alert(1)">Unsafe link</a>',
      user: { login: "me" }, head: { sha: "a".repeat(40), ref: "feature" }, base: { sha: "b".repeat(40), ref: "main" },
    } }));

    // When the overview opens
    await page.goto("/prs");
    await page.getByLabel("Actions for PR 1", { exact: true }).click();
    await page.getByRole("button", { name: "PR overview", exact: true }).click();
    const description = page.locator(".pr-description");

    // Then the description has semantic formatting without executable content
    await expect(description.getByRole("heading", { name: "Summary" })).toBeVisible();
    await expect(description.locator("strong")).toHaveText("Important");
    await expect(description.getByRole("link", { name: "details" })).toHaveAttribute("href", "https://github.com/example/repo");
    await expect(description.getByRole("checkbox")).toBeChecked();
    await expect(description.getByRole("checkbox")).toBeDisabled();
    await expect(description.getByRole("cell")).toHaveText(["Status", "Ready"]);
    await expect(description.locator("pre code")).toHaveText("const ready = true;\n");
    await expect(description.locator("script, [href^='javascript:']")).toHaveCount(0);
  });

  test("GitHub comments render Markdown while editing retains the original source", async () => {
    // Given a thread with Markdown in another author's root and my own reply
    const body = "My **formatted** reply with `code`";
    await page.route("**/conversation", (route) => route.fulfill({ json: {
      viewer: "me", comments: [], reviews: [], inline: [
        { id: 1, path: "file.ts", line: 1, user: { login: "alice" }, body: "Check **this constant** and [reference](https://github.com/example/repo)", html_url: "" },
        { id: 2, in_reply_to_id: 1, user: { login: "me" }, body, html_url: "" },
      ],
    } }));
    await openInboxComments(page);

    // When opening the rendered preview and editing my reply
    await expect(page.locator(".file-comment-thread strong")).toHaveText(["alice", "this constant", "me", "formatted"]);
    await expect(page.locator(".file-comment-thread a")).toHaveCount(0);
    await openThread(page, "Check this constant");
    await expect(page.locator(".comment-detail").getByRole("link", { name: "reference" })).toHaveAttribute("href", "https://github.com/example/repo");
    await page.getByRole("button", { name: "Edit", exact: true }).click();

    // Then editing operates on the original Markdown rather than rendered text
    await expect(page.getByLabel("Edit comment", { exact: true })).toHaveValue(body);
  });

  test("g carries an outdated inbox comment to the closest current hunk", async () => {
    // Given an outdated comment between two current hunks
    await page.route("**/conversation", (route) => route.fulfill({ json: { viewer: "me", comments: [], reviews: [], inline: [
      { id: 1, path: "file.ts", line: null, original_line: 18, side: "RIGHT", user: { login: "alice" }, body: "Outdated inbox comment", html_url: "" },
    ] } }));
    // And the review will mount only after leaving the inbox
    await page.route("**/review?*", (route) => route.fulfill({ json: {
      pr: { title: "My change", user: { login: "me" }, head: { sha: "a".repeat(40) }, base: { sha: "b".repeat(40) } }, commit: "all", commits: [],
      patch: "diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old first\n+new first\n@@ -20 +20 @@\n-old target\n+new target\n",
    } }));
    await openInboxComments(page);
    await page.locator(".file-comment-thread").filter({ hasText: "Outdated inbox comment" }).focus();

    // When going to code from the inbox modal
    await page.keyboard.press("g");

    // Then the new review preserves the best-effort navigation request across the route change
    await expect(page.locator("[data-biff-focused]")).toHaveText("new target");
  });
});

/** Open the inbox's unread-only review browser without navigating away. */
async function openInboxComments(page: Page) {
  await page.goto("/prs");
  await page.getByRole("button", { name: "3 unread threads on PR 1", exact: true }).click();
  await page.locator(".file-comment-thread").first().waitFor();
}

/** Use the same preview entry point as mouse and keyboard users of file comments. */
async function openThread(page: Page, body: string) {
  await page.locator(".file-comment-thread").filter({ hasText: body }).click();
  await page.locator(".comment-detail").waitFor();
}
