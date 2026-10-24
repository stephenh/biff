import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { chromium, expect as browserExpect, type Browser, type BrowserContext, type Page, type Route } from "@playwright/test";
import type { DiscussionComment, DraftComment, FileViewedState, ReviewSubmission } from "../shared/types";
import { matchesChange, type ReviewedChange } from "../shared/progress";
import type { Discussion } from "../shared/discussion";
import type { FollowUp } from "../shared/followUps";
import type { PullActivity } from "../shared/inbox";
import { createTwoFilesPatch } from "diff";
import type { ReviewTimings } from "../src/diffMetrics";

const head = "a".repeat(40);
const previous = "b".repeat(40);
interface FixtureState { progress: ReviewedChange[]; patch: string; writes: ReviewSubmission[]; rejectReview: boolean; empty: boolean; viewedFiles: Record<string, FileViewedState>; rejectViewed: boolean; inline: DiscussionComment[]; lineWrites: { commitId: string; comment: DraftComment }[]; replies: { body: string; replyTo?: number }[]; rejectInline: boolean; approvalActivity?: PullActivity; prHead?: string }

describe("integration", () => {
  let server: ReturnType<typeof Bun.spawn>;
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let state: FixtureState;
  let followUps: FollowUp[];
  const url = "http://127.0.0.1:5175";

  beforeAll(async () => {
    // Dependency patches change without a lockfile edit; never test a stale prebundle.
    server = Bun.spawn(["bun", "node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "5175", "--strictPort", "--force"], { cwd: new URL("..", import.meta.url).pathname, stdout: "ignore", stderr: "inherit" });
    for (let attempt = 0; attempt < 100; attempt++) {
      if (server.exitCode !== null) throw new Error("Integration test server exited");
      try { if ((await fetch(url)).ok) break; } catch { /* Server is starting. */ }
      await Bun.sleep(50);
    }
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium" });
  });
  beforeEach(async () => {
    state = { progress: [], patch: await Bun.file(new URL("../fixtures/demo.diff", import.meta.url)).text(), writes: [], rejectReview: false, empty: false, viewedFiles: { "src/reviews.ts": "UNVIEWED" }, rejectViewed: false, inline: [], lineWrites: [], replies: [], rejectInline: false };
    context = await browser.newContext({ viewport: { width: 1600, height: 1100 }, reducedMotion: "reduce" });
    await context.route("**/api/**", (route) => fixtureResponse(route, state));
    followUps = [];
    await context.route("**/follow-ups", async (route) => {
      if (route.request().method() === "POST") {
        const update = route.request().postDataJSON();
        followUps = followUps.filter((item) => item.type !== "hunk" || !matchesChange(item, update));
        if (update.enabled) {
          followUps.push({ ...update, source: "pr" });
          state.progress = [...state.progress.filter((item) => !matchesChange(item, update)), { ...update, reviewedAt: new Date().toISOString() }];
        }
      }
      await route.fulfill({ contentType: "application/json", body: JSON.stringify(followUps) });
    });
    page = await context.newPage();
  });
  afterEach(async () => { await context.close(); });
  afterAll(async () => { await browser?.close(); server?.kill(); await server?.exited; });

  test("working-copy routes retain the revision and support browser history", async () => {
    // Given an explicit single-revision review (the dashboard defaults to All changes)
    await page.goto(`${url}/workspaces/project?rev=@`);

    // When the previous revision is selected
    await page.getByLabel("JJ revision").selectOption("@-");

    // Then the selected revision has its own URL and rendered diff
    await browserExpect(page).toHaveURL(`${url}/workspaces/project/f/reviews.ts?rev=%40-`);
    await browserExpect(page).toHaveTitle("project / @- · qwertyui — Biff");
    await browserExpect(page.locator("[data-biff-focused]")).toBeVisible();
    await page.goBack();
    await browserExpect(page.getByLabel("JJ revision")).toHaveValue("@");
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
    await browserExpect(page).toHaveURL(`${url}/pr/example/project/12/f/reviews.ts?commit=${previous}`);
    await browserExpect(page).toHaveTitle("project Improve the viewer · bbbbbbbb — Biff");
    await browserExpect(page.locator("[data-biff-focused]")).toBeVisible();
  });

  test("a review submits the selected new-file line and summary", async () => {
    // Given the first added line in a PR's full diff
    await page.goto(`${url}/pr/example/project/12`);
    await page.locator("[data-biff-focused]").waitFor();

    // When the reader adds an inline comment and submits a review
    await composeComment(page);
    await page.getByLabel("Inline comment", { exact: true }).fill("Please explain this constant.");
    await page.getByRole("button", { name: "Save as Review Comment", exact: true }).click();
    await page.getByRole("button", { name: "PR overview", exact: true }).click();
    await page.getByLabel("Review summary").fill("One question.");
    await page.getByRole("button", { name: "Comment", exact: true }).click();
    await browserExpect(page.getByRole("dialog", { name: "PR overview" })).toBeHidden();

    // Then the API receives the reviewed SHA and exact line coordinate
    expect(state.writes).toEqual([{ commitId: head, body: "One question.", event: "COMMENT", comments: [{ path: "src/reviews.ts", line: 3, side: "RIGHT", body: "Please explain this constant." }] }]);
  });

  test("a failed GitHub write keeps the draft available for correction", async () => {
    // Given a PR whose review submission will fail
    state.rejectReview = true;
    await page.goto(`${url}/pr/example/project/12`);
    await page.getByRole("button", { name: "PR overview", exact: true }).click();
    await page.getByLabel("Review summary").fill("Keep this draft.");

    // When submission fails
    await page.getByRole("button", { name: "Comment", exact: true }).click();

    // Then the error is shown without clearing the draft
    await browserExpect(page.getByRole("alert")).toHaveText("GitHub rejected this review");
    await browserExpect(page.getByLabel("Review summary")).toHaveValue("Keep this draft.");
  });

  test("marking a file Viewed persists across a PR refresh", async () => {
    // Given an unviewed file in the full PR diff
    await page.goto(`${url}/pr/example/project/12`);

    // When the reader marks it viewed and refreshes the PR
    await page.getByRole("checkbox", { name: "File reviewed", exact: true }).click();
    await viewedFile(page, "src/reviews.ts").waitFor({ state: "attached" });
    await page.reload();

    // Then the saved GitHub mark is loaded again
    await browserExpect(viewedFile(page, "src/reviews.ts")).toHaveCount(1);
  });

  test("a saved Viewed mark can be cleared", async () => {
    // Given a file already marked viewed on GitHub
    state.viewedFiles["src/reviews.ts"] = "VIEWED";
    await page.goto(`${url}/pr/example/project/12`);
    await browserExpect(page.getByLabel("Current file")).toHaveText("review.graphql");
    await page.keyboard.press("h");
    await browserExpect(page.getByRole("checkbox", { name: "File reviewed", exact: true })).toBeChecked();

    // When the reader clears its mark
    await page.getByRole("checkbox", { name: "File reviewed", exact: true }).click();

    // Then the GitHub state is unviewed
    await browserExpect.poll(() => state.viewedFiles["src/reviews.ts"]).toBe("UNVIEWED");
  });

  test("a failed GitHub sync preserves the local edit and offers retry", async () => {
    // Given a viewed file whose next update will fail
    state.viewedFiles["src/reviews.ts"] = "VIEWED";
    // And GitHub rejects viewed updates
    state.rejectViewed = true;
    await page.goto(`${url}/pr/example/project/12`);
    await browserExpect(page.getByLabel("Current file")).toHaveText("review.graphql");
    await page.keyboard.press("h");
    await browserExpect(page.getByRole("checkbox", { name: "File reviewed", exact: true })).toBeChecked();
    await browserExpect(page.getByRole("checkbox", { name: "File reviewed", exact: true })).toBeEnabled();

    // When the reader tries to clear its mark
    await page.getByRole("checkbox", { name: "File reviewed", exact: true }).click();
    await page.getByRole("alert").waitFor();

    // Then the checkbox reflects the saved Biff edit despite the pending GitHub sync
    await browserExpect(page.getByRole("checkbox", { name: "File reviewed", exact: true })).not.toBeChecked();
  });

  test("opening an inline thread does not reflow the code", async () => {
    // Given a published thread with a reply on the first added line
    state.inline = [inlineComment(42, "Please explain this constant before merging."), { ...inlineComment(43, "Here is the explanation."), in_reply_to_id: 42 }];
    await page.goto(`${url}/pr/example/project/12`);
    const line = page.locator('[data-content] > [data-line="3"][data-line-type="change-addition"]');
    await line.waitFor();
    const before = await line.boundingBox();

    // When the short author preview is opened
    await commentBadge(page).click();
    await page.getByRole("dialog", { name: "Comment thread", exact: true }).waitFor();
    await page.getByText("Here is the explanation.", { exact: true }).waitFor();

    // Then the code line retains exactly the same position and size
    // Comment-read updates can replace Pierre's rows after the dialog appears.
    // Reacquire the same source line and wait for its layout, not keyboard focus.
    await browserExpect.poll(() => line.boundingBox()).toEqual(before);
  });

  test("Save as Comment publishes a new line thread immediately", async () => {
    // Given the full PR diff
    await page.goto(`${url}/pr/example/project/12`);

    // When a new thread is saved as a comment
    await composeComment(page);
    await page.getByLabel("Inline comment", { exact: true }).fill("Publish this now.");
    await page.getByRole("button", { name: "Save as Comment", exact: true }).click();
    await page.getByRole("dialog").waitFor({ state: "detached" });

    // Then the API receives the current head and exact line coordinate
    await browserExpect.poll(() => state.lineWrites).toEqual([{ commitId: head, comment: { path: "src/reviews.ts", line: 3, side: "RIGHT", body: "Publish this now." } }]);
  });

  test("an inline thread reply is posted to its root comment", async () => {
    // Given an existing inline thread
    state.inline = [inlineComment(42, "Please explain this constant.")];
    await page.goto(`${url}/pr/example/project/12`);

    // When the reader replies in the floating overlay
    await commentBadge(page).click();
    await page.getByLabel("Thread reply", { exact: true }).fill("Here is why.");
    await page.getByRole("button", { name: "Save as Comment", exact: true }).click();
    await page.getByRole("dialog").waitFor({ state: "detached" });

    // Then the reply targets the existing root rather than creating a new thread
    await browserExpect.poll(() => state.replies).toEqual([{ body: "Here is why.", replyTo: 42 }]);
  });

  test("a rejected background comment retains its text when the composer reopens", async () => {
    // Given GitHub rejects the next line comment
    state.rejectInline = true;
    await page.goto(`${url}/pr/example/project/12`);

    // When immediate publication fails
    await composeComment(page);
    await page.getByLabel("Inline comment", { exact: true }).fill("Keep my explanation.");
    await page.getByRole("button", { name: "Save as Comment", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "GitHub rejected this line comment" }).waitFor();
    await composeComment(page);

    // Then the reader can correct or retry the same text
    await browserExpect(page.getByLabel("Inline comment", { exact: true })).toHaveValue("Keep my explanation.");
  });

  test("saved review comments survive reload without publishing", async () => {
    // Given a new comment in the line overlay
    await page.goto(`${url}/pr/example/project/12`);
    await composeComment(page);
    await page.getByLabel("Inline comment", { exact: true }).fill("Save for the review.");

    // When the reader saves it as a review comment and reloads
    await page.getByRole("button", { name: "Save as Review Comment", exact: true }).click();
    await page.reload();
    await commentBadge(page).click();

    // Then the local review comment is available for editing
    await browserExpect(page.getByLabel("Inline comment", { exact: true })).toHaveValue("Save for the review.");
  });

  test("Escape closes the overlay without losing unsaved text", async () => {
    // Given an unsaved line comment
    await page.goto(`${url}/pr/example/project/12`);
    await composeComment(page);
    await page.getByLabel("Inline comment", { exact: true }).fill("Still composing.");

    // When the reader dismisses and reopens the composer
    await page.keyboard.press("Escape");
    await composeComment(page);

    // Then the unsaved text is retained
    await browserExpect(page.getByLabel("Inline comment", { exact: true })).toHaveValue("Still composing.");
  });

  test("multiple threads on one line can each receive a reply", async () => {
    // Given two separate root comments at the same coordinate
    state.inline = [inlineComment(42, "First thread."), inlineComment(44, "Second thread.")];
    await page.goto(`${url}/pr/example/project/12`);

    // When the second thread is selected at the gutter and answered
    await page.getByRole("button", { name: "2 threads on line 3", exact: true }).click();
    await page.getByRole("dialog", { name: "Choose comment thread" }).getByRole("button").filter({ hasText: "Second thread." }).click();
    await page.getByLabel("Thread reply", { exact: true }).fill("Answer for the second thread.");
    await page.getByRole("button", { name: "Save as Comment", exact: true }).click();
    await page.getByRole("dialog").waitFor({ state: "detached" });

    // Then the reply targets the selected root comment
    await browserExpect.poll(() => state.replies).toEqual([{ body: "Answer for the second thread.", replyTo: 44 }]);
  });

  test("edited review comments reopen with their saved text", async () => {
    // Given a saved inline review comment
    await page.goto(`${url}/pr/example/project/12`);
    await composeComment(page);
    await page.getByLabel("Inline comment", { exact: true }).fill("Initial draft.");
    await page.getByRole("button", { name: "Save as Review Comment", exact: true }).click();

    // When the draft is edited, saved, and opened again
    await commentBadge(page).click();
    await page.getByLabel("Inline comment", { exact: true }).fill("Revised draft.");
    await page.getByRole("button", { name: "Save as Review Comment", exact: true }).click();
    await commentBadge(page).click();

    // Then the overlay shows the revised saved comment
    await browserExpect(page.getByLabel("Inline comment", { exact: true })).toHaveValue("Revised draft.");
  });

  test("c opens a composer on the keyboard-focused line", async () => {
    // Given the reader navigated down from the first changed line
    await page.goto(`${url}/pr/example/project/12`);
    await page.locator("[data-biff-focused]").waitFor();
    await page.keyboard.press("j");

    // When c opens the overlay and the reader saves a comment
    await page.keyboard.press("c");
    await page.getByLabel("Inline comment", { exact: true }).fill("On the next line.");
    await page.getByRole("button", { name: "Save as Comment", exact: true }).click();
    await page.getByRole("dialog").waitFor({ state: "detached" });

    // Then the comment belongs to the focused line, not the initial hunk line
    await browserExpect.poll(() => state.lineWrites).toEqual([{ commitId: head, comment: { path: "src/reviews.ts", line: 4, side: "RIGHT", body: "On the next line." } }]);
  });

  test("c opens an existing thread on the focused line", async () => {
    // Given a published comment on the initial focused line
    state.inline = [inlineComment(42, "Please explain this constant.")];
    await page.goto(`${url}/pr/example/project/12`);
    await commentBadge(page).waitFor();

    // When the reader presses c
    await page.keyboard.press("c");

    // Then the existing thread opens with its reply composer ready for typing
    await browserExpect(page.getByRole("button", { name: "Mark read", exact: true })).toBeFocused();
  });

  test("Shift+L saves the current file as viewed and advances", async () => {
    // Given an unviewed PR file
    await page.goto(`${url}/pr/example/project/12`);
    await browserExpect(page.getByRole("checkbox", { name: "File reviewed", exact: true })).toBeEnabled();

    // When the reader marks it done with Shift+L
    await page.keyboard.press("Shift+L");

    // Then GitHub has the mark and the next file is selected
    await browserExpect(page.getByLabel("Current file")).toHaveText("review.graphql");
    await viewedFile(page, "src/reviews.ts").waitFor({ state: "attached" });
    expect<FileViewedState>(state.viewedFiles["src/reviews.ts"]).toBe("VIEWED");
  });

  test("Shift+L advances even when the background save fails", async () => {
    // Given GitHub will reject the viewed update
    state.rejectViewed = true;
    await page.goto(`${url}/pr/example/project/12`);
    await browserExpect(page.getByRole("checkbox", { name: "File reviewed", exact: true })).toBeEnabled();

    // When the reader presses Shift+L
    await page.keyboard.press("Shift+L");

    // Then the failed file is identified while navigation stays on the next file
    await browserExpect(page.getByRole("alert")).toHaveText("src/reviews.ts: GitHub rejected this Viewed updateRetry");
    await browserExpect(page.getByLabel("Current file")).toHaveText("review.graphql");
  });

  test("Shift+L advances past an already-viewed file without clearing its mark", async () => {
    // Given a file already viewed, with further writes unavailable
    state.viewedFiles["src/reviews.ts"] = "VIEWED";
    // And GitHub would reject a redundant write
    state.rejectViewed = true;
    await page.goto(`${url}/pr/example/project/12`);
    await browserExpect(page.getByLabel("Current file")).toHaveText("review.graphql");
    await page.keyboard.press("h");
    await browserExpect(page.getByRole("checkbox", { name: "File reviewed", exact: true })).toBeChecked();

    // When the reader presses Shift+L
    await page.keyboard.press("Shift+L");

    // Then navigation advances and the saved mark remains viewed
    await browserExpect(page.getByLabel("Current file")).toHaveText("review.graphql");
    expect<FileViewedState>(state.viewedFiles["src/reviews.ts"]).toBe("VIEWED");
  });

  test("Shift+L marks the final file without wrapping to the beginning", async () => {
    // Given the final PR file is selected and unviewed
    state.viewedFiles["settings.json"] = "UNVIEWED";
    await page.goto(`${url}/pr/example/project/12`);
    await browserExpect(page.getByRole("checkbox", { name: "File reviewed", exact: true })).toBeEnabled();
    await page.keyboard.press("l");
    await page.keyboard.press("l");

    // When the reader finishes the last file
    await page.keyboard.press("Shift+L");

    // Then that file stays selected with its viewed mark saved
    await browserExpect(page.getByRole("checkbox", { name: "File reviewed", exact: true })).toBeChecked();
    await browserExpect(page.getByLabel("Current file")).toHaveText("settings.json");
    expect<FileViewedState>(state.viewedFiles["settings.json"]).toBe("VIEWED");
  });

  test("browser reload keeps the selected PR file instead of the first unreviewed file", async () => {
    // Given the reader navigated to the last file
    await page.goto(`${url}/pr/example/project/12`);
    await page.locator("[data-biff-focused]").waitFor();
    await page.keyboard.press("Control+p");
    await page.getByRole("combobox", { name: "Search files", exact: true }).fill("settings.json");
    await page.keyboard.press("Enter");

    // When the tab reloads
    await page.reload();

    // Then it keeps the file selected before reload
    await browserExpect(page.getByLabel("Current file")).toHaveText("settings.json");
  });

  test("reload restores a working-copy file by path after reordering", async () => {
    // Given the reader selected settings.json
    await page.goto(`${url}/workspaces/project`);
    await page.locator("[data-biff-focused]").waitFor();
    await page.keyboard.press("Control+p");
    await page.getByRole("combobox", { name: "Search files", exact: true }).fill("settings.json");
    await page.keyboard.press("Enter");
    // And the refreshed patch moves that file to the front
    const patches = state.patch.split(/(?=^diff --git )/m);
    state.patch = [patches[2], patches[0], patches[1]].join("");

    // When the browser tab reloads
    await page.reload();

    // Then selection follows the file rather than its previous index
    await browserExpect(page.getByLabel("Current file")).toHaveText("settings.json");
  });

  test("inline mention suggestions support keyboard selection and continued typing", async () => {
    // Given a new inline comment on a PR
    await page.goto(`${url}/pr/example/project/12`);
    await composeComment(page);

    // When the reader selects the second repository user with the keyboard
    const composer = page.getByLabel("Inline comment", { exact: true });
    await composer.fill("Please ask @al");
    await page.getByRole("option", { name: "@alice Alice Reviewer", exact: true }).waitFor();
    await composer.press("ArrowDown");
    await composer.press("Enter");
    await composer.pressSequentially("to check.");
    await page.getByRole("button", { name: "Save as Comment", exact: true }).click();
    await page.getByRole("dialog").waitFor({ state: "detached" });

    // Then the published comment contains the selected GitHub username
    await browserExpect.poll(() => state.lineWrites).toEqual([{ commitId: head, comment: { path: "src/reviews.ts", line: 3, side: "RIGHT", body: "Please ask @albert to check." } }]);
  });

  test("discussion comments accept mention suggestions by mouse", async () => {
    // Given the PR discussion composer
    await page.goto(`${url}/pr/example/project/12`);
    await page.getByRole("button", { name: "Review comments", exact: true }).click();
    await page.getByRole("button", { name: "New PR comment", exact: true }).click();

    // When a suggested repository user is clicked and the comment is posted
    await page.getByLabel("Discussion comment", { exact: true }).fill("Thanks @ali");
    await page.getByRole("option", { name: "@alice Alice Reviewer", exact: true }).click();
    await page.getByRole("button", { name: "Save as Comment", exact: true }).click();
    await browserExpect(page.getByRole("dialog", { name: "Review comments" })).toBeHidden();

    // Then the general comment contains the literal GitHub mention
    await browserExpect.poll(() => state.replies).toEqual([{ body: "Thanks @alice " }]);
  });

  test("thread replies support repository-user mentions", async () => {
    // Given an existing inline thread
    state.inline = [inlineComment(42, "Who can check this?")];
    await page.goto(`${url}/pr/example/project/12`);
    await commentBadge(page).click();

    // When a reply mentions a repository user
    await page.getByLabel("Thread reply", { exact: true }).fill("Ask @ali");
    await page.getByRole("option", { name: "@alice Alice Reviewer", exact: true }).click();
    await page.getByRole("button", { name: "Save as Comment", exact: true }).click();
    await page.getByRole("dialog").waitFor({ state: "detached" });

    // Then the mention is sent as part of the existing thread reply
    await browserExpect.poll(() => state.replies).toEqual([{ body: "Ask @alice ", replyTo: 42 }]);
  });

  test("Escape dismisses mention suggestions without closing the comment overlay", async () => {
    // Given an inline composer showing repository-user suggestions
    await page.goto(`${url}/pr/example/project/12`);
    await composeComment(page);
    const composer = page.getByLabel("Inline comment", { exact: true });
    await composer.fill("Ask @ali");
    await page.getByRole("option", { name: "@alice Alice Reviewer", exact: true }).waitFor();

    // When suggestions are dismissed and typing continues
    await composer.press("Escape");
    await composer.pressSequentially("ce manually");

    // Then the composer remains open with the unmodified typed text
    await browserExpect(composer).toHaveValue("Ask @alice manually");
  });

  test("a failed mention lookup does not prevent composing a comment", async () => {
    // Given GitHub rejects repository-user lookup
    await page.route("**/mentions?**", (route) => route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "GitHub unavailable" }) }));
    await page.goto(`${url}/pr/example/project/12`);
    await composeComment(page);

    // When a mention search fails and the reader dismisses suggestions
    const composer = page.getByLabel("Inline comment", { exact: true });
    await composer.fill("Please check @alice");
    await page.getByText("Could not load repository users.", { exact: true }).waitFor();
    await composer.press("Escape");

    // Then the comment body remains available for manual editing or publication
    await browserExpect(composer).toHaveValue("Please check @alice");
  });
  test("PR metadata shows its stack position next to the repository and number", async () => {
    // Given a PR in the middle of a stack
    await page.route("**/stack", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ position: 2, total: 3, pulls: [{ number: 11, title: "Base change" }, { number: 12, title: "Improve the viewer" }, { number: 13, title: "Follow-up change" }] }) }));
    // When its review opens
    await page.goto(`${url}/pr/example/project/12`);
    // Then the title's metadata includes the stack counter
    await browserExpect(page.locator(".review-title .muted")).toHaveText("example/project #12 2 / 3");
  });

  test("switching stacked PRs opens the selected PR's complete diff", async () => {
    // Given an individual commit selected within a stacked PR
    await page.route("**/stack", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ position: 2, total: 2, pulls: [{ number: 11, title: "Base change" }, { number: 12, title: "Improve the viewer" }] }) }));
    await page.goto(`${url}/pr/example/project/12?commit=${previous}`);
    // When another PR is chosen from the stack
    await page.getByRole("button", { name: "Stack position 2 of 2", exact: true }).click();
    await page.getByLabel("Stack PR", { exact: true }).selectOption("11");
    // Then navigation drops the previous PR's commit selection
    await browserExpect(page).toHaveURL(`${url}/pr/example/project/11/f/reviews.ts`);
  });

  test("Shift+L advances through multiple files while their saves are pending", async () => {
    // Given saves are held until the reader has moved through the review
    const held = Promise.withResolvers<void>();
    await page.route("**/viewed", async (route) => {
      if (route.request().method() === "POST") await held.promise;
      await fixtureResponse(route, state);
    });
    await page.goto(`${url}/pr/example/project/12`);
    await browserExpect(page.getByRole("checkbox", { name: "File reviewed", exact: true })).toBeEnabled();

    try {
      // When two files are marked before GitHub finishes either save
      await page.keyboard.press("Shift+L");
      await browserExpect(page.getByLabel("Current file")).toHaveText("review.graphql");
      await page.keyboard.press("Shift+L");

      // Then the last file is selected without waiting for either network response
      await browserExpect(page.getByLabel("Current file")).toHaveText("settings.json");
    } finally { held.resolve(); }
  });

  test("background Viewed saves are retained for every skipped file", async () => {
    // Given two files whose viewed saves are delayed
    const held = Promise.withResolvers<void>();
    await page.route("**/viewed", async (route) => {
      if (route.request().method() === "POST") await held.promise;
      await fixtureResponse(route, state);
    });
    await page.goto(`${url}/pr/example/project/12`);
    await browserExpect(page.getByRole("checkbox", { name: "File reviewed", exact: true })).toBeEnabled();

    try {
      // When the reader moves ahead twice and both saves then finish
      await page.keyboard.press("Shift+L");
      await browserExpect(page.getByLabel("Current file")).toHaveText("review.graphql");
      await page.keyboard.press("Shift+L");
      held.resolve();
      await viewedFile(page, "schema/review.graphql").waitFor({ state: "attached" });
      await viewedFile(page, "src/reviews.ts").waitFor({ state: "attached" });

      // Then both previous files have their own saved GitHub marks
      await browserExpect.poll(() => state.viewedFiles).toEqual({ "src/reviews.ts": "VIEWED", "schema/review.graphql": "VIEWED" });
    } finally { held.resolve(); }
  });

  test("a failed background Viewed save can be retried from the next file", async () => {
    // Given GitHub rejects the previous file's Viewed mark
    state.rejectViewed = true;
    await page.goto(`${url}/pr/example/project/12`);
    await browserExpect(page.getByRole("checkbox", { name: "File reviewed", exact: true })).toBeEnabled();
    await page.keyboard.press("Shift+L");
    await page.getByRole("alert").waitFor();
    // And GitHub becomes available again
    state.rejectViewed = false;

    // When the failed mark is retried without going back
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await viewedFile(page, "src/reviews.ts").waitFor({ state: "attached" });

    // Then the original file's mark is saved
    expect<FileViewedState>(state.viewedFiles["src/reviews.ts"]).toBe("VIEWED");
  });

  test("expanding folded imports reveals their commented stanza", async () => {
    // Given a published thread on an import replacement
    state.patch = 'diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n@@ -1,3 +1,3 @@\n-import Old from "old";\n+import New from "new";\n \n const body = true;\n';
    state.inline = [{ ...inlineComment(42, "Please check this import."), path: "file.ts", line: 1 }];
    await page.goto(`${url}/pr/example/project/12`);
    await page.getByRole("button", { name: "2 Import changes · 1 thread", exact: true }).waitFor();

    // When the reader expands the import group containing the thread
    await page.getByRole("button", { name: "2 Import changes · 1 thread", exact: true }).click();

    // Then the import stanza is expanded so its exact comment location is readable
    await browserExpect(page.getByRole("button", { name: "2 Import changes · 1 thread", exact: true })).toHaveAttribute("aria-expanded", "true");
  });
  test("Space saves the current edit and advances to the next unreviewed change", async () => {
    // Given the first selected change of a PR
    await page.goto(`${url}/pr/example/project/12`);
    await page.locator("[data-biff-focused]").waitFor();
    // When it is completed with Space
    await page.keyboard.press("Space");
    // Then the next business change is selected
    await browserExpect(page.locator("[data-biff-focused]")).toHaveAttribute("data-line", "8");
  });

  test("review progress survives reload and skips the completed initial change", async () => {
    // Given a PR with a completed first edit
    await page.goto(`${url}/pr/example/project/12`);
    await page.locator("[data-biff-focused]").waitFor();
    await page.keyboard.press("Space");
    await browserExpect(page.locator("[data-biff-focused]")).toHaveAttribute("data-line", "8");
    // When the page is reloaded
    await page.reload();
    // Then initial selection skips the persisted reviewed edit
    await browserExpect(page.locator("[data-biff-focused]")).toHaveAttribute("data-line", "8");
  });

  test("p skips reviewed edits", async () => {
    // Given a completed first edit and the next edit selected
    await page.goto(`${url}/pr/example/project/12`);
    await page.locator("[data-biff-focused]").waitFor();
    await page.keyboard.press("Space");
    await browserExpect(page.locator("[data-biff-focused]")).toHaveAttribute("data-line", "8");
    // When change navigation goes backwards
    await page.keyboard.press("p");
    // Then it stays on the first unreviewed edit
    await browserExpect(page.locator("[data-biff-focused]")).toHaveAttribute("data-line", "8");
  });

  test("a failed completion save retains the selected change and exposes an error", async () => {
    // Given progress writes fail but loading succeeds
    await page.route("**/progress", async (route) => {
      if (route.request().method() === "POST") await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Disk unavailable" }) });
      else await route.fallback();
    });
    await page.goto(`${url}/pr/example/project/12`);
    await page.locator("[data-biff-focused]").waitFor();
    // When Space attempts to persist completion
    await page.keyboard.press("Space");
    await page.getByRole("alert").filter({ hasText: "Disk unavailable" }).waitFor();
    // Then the unsaved edit remains selected for retry
    await browserExpect(page.locator("[data-biff-focused]")).toHaveAttribute("data-line", "3");
  });

  test("completing a change preserves rendered rows during the smooth scroll", async () => {
    // Given normal motion and the current diff already rendered
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.goto(`${url}/pr/example/project/12`);
    await page.locator("[data-biff-focused]").waitFor();
    // Font loading can invalidate native wrapped-row measurements independently of approval.
    await page.evaluate(async () => { await document.fonts.ready; await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); });
    await page.evaluate(() => {
      const row = document.querySelector("diffs-container")!.shadowRoot!.querySelector("[data-line]")!;
      row.setAttribute("data-preserve-test", "original");
    });
    // When completing the change applies reviewed styling and starts navigation
    await page.keyboard.press("Space");
    await browserExpect(page.locator("[data-biff-focused]")).toHaveAttribute("data-line", "8");
    // Then Pierre has kept the original rendered row instead of rebuilding the code
    await browserExpect(page.locator('[data-preserve-test="original"]')).toHaveCount(1);
  });

  test("lowercase line navigation still enters reviewed code", async () => {
    // Given a completed first edit and a later change selected
    await page.goto(`${url}/pr/example/project/12`);
    await page.locator("[data-biff-focused]").waitFor();
    await page.keyboard.press("Space");
    await browserExpect(page.locator("[data-biff-focused]")).toHaveAttribute("data-line", "8");
    // When line navigation moves back through the visible lines
    for (let count = 0; count < 5; count++) await page.keyboard.press("k");
    // Then the completed addition remains an ordinary line-navigation stop
    await browserExpect(page.locator("[data-biff-focused]")).toHaveAttribute("data-line", "3");
  });

  test("Shift+H marks the current file viewed and moves to the previous file", async () => {
    // Given the second PR file is selected
    await page.goto(`${url}/pr/example/project/12`);
    await page.locator("[data-biff-focused]").waitFor();
    await page.keyboard.press("l");
    await browserExpect(page.getByLabel("Current file")).toHaveText("review.graphql");

    // When the reader marks it viewed while moving left
    await page.keyboard.press("Shift+H");
    await browserExpect(page.getByLabel("Current file")).toHaveText("reviews.ts");

    // Then the file left behind is marked viewed
    await browserExpect.poll(() => state.viewedFiles["schema/review.graphql"]).toBe("VIEWED");
  });

  test("publishing a local thread replaces its unpublished label with a GitHub receipt", async () => {
    // Given a PR with an unpublished local note
    await localDiscussionFixture(page);
    await page.goto(`${url}/pr/example/project/12`);
    await page.getByRole("button", { name: "Review comments", exact: true }).click();
    await page.locator(".file-comment-thread").first().click();
    await browserExpect(page.getByRole("dialog").getByText("Local", { exact: true }).first()).toBeVisible();

    // When the user explicitly publishes the saved thread
    await page.getByRole("button", { name: "Publish to PR", exact: true }).click();

    // Then the publication status links to the actual GitHub comment
    await browserExpect(page.getByRole("dialog").getByRole("link", { name: "GitHub", exact: true }).first()).toHaveAttribute("href", "https://github.com/example/project/pull/12#discussion_r99");
  });

  test("a local reply to a published thread is explicitly labeled unpublished", async () => {
    // Given a local thread whose root has been published
    await localDiscussionFixture(page);
    await page.goto(`${url}/pr/example/project/12`);
    await page.getByRole("button", { name: "Review comments", exact: true }).click();
    await page.locator(".file-comment-thread").first().click();
    await page.getByRole("button", { name: "Publish to PR", exact: true }).click();
    await browserExpect(page.getByRole("dialog").getByRole("link", { name: "GitHub", exact: true }).first()).toBeVisible();

    // When another reply is saved only in Biff
    await page.getByRole("textbox", { name: "Thread reply", exact: true }).fill("This reply is still local.");
    await page.getByRole("button", { name: "Save locally", exact: true }).click();
    await browserExpect(page.locator(".comment-detail")).toHaveCount(0);
    await page.locator(".file-comment-thread").first().click();

    // Then that reply has its own unpublished badge despite the published root
    await browserExpect(page.getByRole("dialog").locator("article").filter({ hasText: "This reply is still local." }).getByText("Local", { exact: true })).toBeVisible();
  });
  test("completing the last block syncs the single Reviewed flag to GitHub", async () => {
    // Given a file with one reviewable change
    state.patch = "diff --git a/src/reviews.ts b/src/reviews.ts\n--- a/src/reviews.ts\n+++ b/src/reviews.ts\n@@ -1 +1 @@\n-old value\n+new value\n";
    await page.goto(`${url}/pr/example/project/12`);
    await browserExpect(page.getByRole("checkbox", { name: "File reviewed", exact: true })).toBeEnabled();

    // When the reader completes its only block
    await page.keyboard.press("Space");

    // Then GitHub receives the file's completion without a separate Viewed action
    await browserExpect.poll(() => state.viewedFiles["src/reviews.ts"]).toBe("VIEWED");
  });

  test("existing Biff file progress syncs to GitHub when the PR opens", async () => {
    // Given saved Biff progress
    await page.goto(`${url}/pr/example/project/12`);
    await page.getByRole("checkbox", { name: "File reviewed", exact: true }).click();
    await browserExpect.poll(() => state.viewedFiles["src/reviews.ts"]).toBe("VIEWED");
    // And GitHub does not yet have the same mark
    state.viewedFiles["src/reviews.ts"] = "UNVIEWED";

    // When the PR opens again with that shared Biff progress
    await page.reload();

    // Then the existing completion syncs to GitHub
    await browserExpect.poll(() => state.viewedFiles["src/reviews.ts"]).toBe("VIEWED");
  });

  test("retrying a failed sync sends the saved Reviewed value to GitHub", async () => {
    // Given a saved local completion whose GitHub sync failed
    state.rejectViewed = true;
    await page.goto(`${url}/pr/example/project/12`);
    await page.getByRole("checkbox", { name: "File reviewed", exact: true }).click();
    await page.getByRole("alert").waitFor();
    // And GitHub accepts updates again
    state.rejectViewed = false;

    // When the user retries the sync
    await page.getByRole("button", { name: "Retry", exact: true }).click();

    // Then GitHub catches up with Biff's saved completion
    await browserExpect.poll(() => state.viewedFiles["src/reviews.ts"]).toBe("VIEWED");
  });
  test("the linked bookmark URL lets the server derive the PR base", async () => {
    // Given a PR linked to a local WIP review
    await page.route("**/identity", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ id: "linked", closed: false, local: { workspace: "workspace-id", bookmark: "" } }) }));
    await page.goto(`${url}/pr/example/project/12`);

    // When opening the review options
    await page.getByLabel("Review options", { exact: true }).click();

    // Then navigation explicitly retains the PR's base rather than guessing from local bookmarks
    await browserExpect(page.getByRole("link", { name: "Open linked bookmark ↗", exact: true })).toHaveAttribute("href", "/workspaces/workspace-id?bookmark=&changes=all");
  });

  test("an empty old draft follows the current PR head after reload", async () => {
    // Given an empty draft persisted against an older PR head
    await page.goto(`${url}/pr/example/project/12`);
    await page.evaluate((commitId) => localStorage.setItem("biff:review:/api/github/pr/example/project/12", JSON.stringify({ commitId, body: "", comments: [] })), previous);

    // When the reader reloads and composes a review comment
    await page.reload();
    await composeComment(page);
    await page.getByLabel("Inline comment", { exact: true }).fill("Review this on the current head.");
    await page.getByRole("button", { name: "Save as Review Comment", exact: true }).click();
    await page.getByRole("dialog").waitFor({ state: "detached" });

    // Then the saved comment is anchored to the current head
    expect(await page.evaluate((commitId) => JSON.parse(localStorage.getItem(`biff:review:/api/github/pr/example/project/12:${commitId}`)!), head)).toEqual({ commitId: head, body: "", comments: [{ path: "src/reviews.ts", line: 3, side: "RIGHT", body: "Review this on the current head." }] });
  });

  test("a nonempty old draft does not block new comments on the current head", async () => {
    // Given an unsent review belonging to an older head
    await page.goto(`${url}/pr/example/project/12`);
    await page.evaluate((commitId) => localStorage.setItem("biff:review:/api/github/pr/example/project/12", JSON.stringify({ commitId, body: "Preserve this review", comments: [] })), previous);

    // When the reader reloads and adds another review comment
    await page.reload();
    await composeComment(page);
    await page.getByLabel("Inline comment", { exact: true }).fill("Another note.");

    // Then current-head comments can be saved independently of the older draft
    await browserExpect(page.getByRole("button", { name: "Save as Review Comment", exact: true })).toBeEnabled();
  });

  test("replying to a published comment does not show an unrelated stale draft warning", async () => {
    // Given a published thread and a separate unsent review on an older head
    state.inline = [inlineComment(42, "Please explain this constant.")];
    await page.goto(`${url}/pr/example/project/12`);
    await page.evaluate((commitId) => localStorage.setItem("biff:review:/api/github/pr/example/project/12", JSON.stringify({ commitId, body: "Preserve this review", comments: [] })), previous);

    // When the reader reloads and opens the published thread
    await page.reload();
    await commentBadge(page).click();
    await page.getByRole("dialog").waitFor();

    // Then the independent reply has no stale-draft warning
    await browserExpect(page.getByRole("dialog").getByRole("alert")).toHaveCount(0);
  });

  test("a published inline comment can be edited in its thread", async () => {
    // Given a published inline comment
    state.inline = [inlineComment(42, "Original comment.")];
    await page.goto(`${url}/pr/example/project/12`);
    await commentBadge(page).click();

    // When its author edits by typing immediately after clicking Edit
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.insertText("Edited comment.");
    await page.getByRole("button", { name: "Save changes", exact: true }).click();

    // Then the refreshed thread shows the saved body
    await browserExpect(page.getByRole("dialog").getByText("Edited comment.", { exact: true })).toBeVisible();
  });

  test("deleting a published inline comment removes it from the diff", async () => {
    // Given a published inline comment
    state.inline = [inlineComment(42, "Remove this comment.")];
    await page.goto(`${url}/pr/example/project/12`);
    await commentBadge(page).click();

    // When its author deletes it
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByRole("dialog").waitFor({ state: "detached" });

    // Then the deleted thread no longer has a diff marker
    await browserExpect(commentBadge(page)).toHaveCount(0);
  });

  test("a rejected comment edit retains the unsaved text for retry", async () => {
    // Given an inline comment whose update will fail
    state.inline = [inlineComment(42, "Original comment.")];
    state.rejectInline = true;
    await page.goto(`${url}/pr/example/project/12`);
    await commentBadge(page).click();

    // When an edit is rejected by GitHub
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    await page.getByRole("textbox", { name: "Edit comment", exact: true }).fill("Keep this unsaved edit.");
    await page.getByRole("button", { name: "Save changes", exact: true }).click();
    await page.getByRole("dialog").getByRole("alert").waitFor();

    // Then the editor retains the user's text
    await browserExpect(page.getByRole("textbox", { name: "Edit comment", exact: true })).toHaveValue("Keep this unsaved edit.");
  });

  test("a GitHub thread can be resolved from its comment dialog", async () => {
    // Given an unresolved GitHub thread
    state.inline = [{ ...inlineComment(42, "Please fix this."), reviewThread: { id: "THREAD_42", resolved: false, canResolve: true, canReopen: true } }];
    await page.goto(`${url}/pr/example/project/12`);
    await commentBadge(page).click();

    // When the reader resolves it
    await page.getByRole("button", { name: "Resolve thread", exact: true }).click();

    // Then the refreshed thread offers to reopen it
    await browserExpect(page.getByRole("button", { name: "Reopen thread", exact: true })).toBeEnabled();
  });

  test("a GitHub thread can be reopened from Review comments", async () => {
    // Given a resolved GitHub thread
    state.inline = [{ ...inlineComment(42, "Please fix this."), reviewThread: { id: "THREAD_42", resolved: true, canResolve: true, canReopen: true } }];
    await page.goto(`${url}/pr/example/project/12`);
    await page.getByRole("button", { name: "Review comments", exact: true }).click();

    // When the reader reopens it
    await page.getByRole("button", { name: "Unresolve thread", exact: true }).click();

    // Then the panel offers to resolve the open thread
    await browserExpect(page.getByRole("button", { name: "Resolve thread", exact: true })).toBeEnabled();
  });

  test("a failed GitHub resolution leaves the thread open", async () => {
    // Given an open thread whose mutation will fail
    state.inline = [{ ...inlineComment(42, "Please fix this."), reviewThread: { id: "THREAD_42", resolved: false, canResolve: true, canReopen: true } }];
    await page.route("**/thread", (route) => route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "GitHub rejected resolution" }) }));
    await page.goto(`${url}/pr/example/project/12`);
    await commentBadge(page).click();

    // When resolving it fails
    await page.getByRole("button", { name: "Resolve thread", exact: true }).click();
    await page.getByRole("dialog").getByRole("alert").waitFor();

    // Then the action still reflects an open thread and permits retry
    await browserExpect(page.getByRole("button", { name: "Resolve thread", exact: true })).toBeEnabled();
  });

  test("Approve directly submits a review without requiring a summary", async () => {
    // Given an empty review draft
    await page.goto(`${url}/pr/example/project/12`);
    await page.getByRole("button", { name: "PR overview", exact: true }).click();

    // When the reader approves
    await page.getByRole("button", { name: "Approve", exact: true }).click();
    await browserExpect(page.getByRole("dialog", { name: "PR overview" })).toBeHidden();

    // Then GitHub receives an approval for the current head
    expect(state.writes).toEqual([{ commitId: head, body: "", comments: [], event: "APPROVE" }]);
  });

  test("Request changes directly submits the written feedback", async () => {
    // Given a review summary
    await page.goto(`${url}/pr/example/project/12`);
    await page.getByRole("button", { name: "PR overview", exact: true }).click();
    await page.getByLabel("Review summary").fill("Please handle the empty case.");

    // When the reader requests changes
    await page.getByRole("button", { name: "Request changes", exact: true }).click();
    await browserExpect(page.getByRole("dialog", { name: "PR overview" })).toBeHidden();

    // Then GitHub receives the requested outcome and summary
    expect(state.writes).toEqual([{ commitId: head, body: "Please handle the empty case.", comments: [], event: "REQUEST_CHANGES" }]);
  });

  test("opening a review comment shows its file and line in the shared browser", async () => {
    // Given a comment in a different file from the initially selected diff
    state.inline = [{ ...inlineComment(42, "Should drafts be nullable?"), path: "schema/review.graphql", line: 6 }];
    await page.goto(`${url}/pr/example/project/12`);
    await page.getByRole("button", { name: "Review comments", exact: true }).click();

    // When the comment text is clicked
    await page.locator(".file-comment-thread").filter({ hasText: "Should drafts be nullable?" }).click();

    // Then the embedded thread identifies the commented GraphQL field
    await browserExpect(page.locator(".comment-detail .comment-location")).toHaveText("schema/review.graphql:L6");
  });

  test("clicking a discussion reply opens its parent thread", async () => {
    // Given a thread and a reply in another file
    state.inline = [
      { ...inlineComment(42, "Should drafts be nullable?"), path: "schema/review.graphql", line: 6 },
      { ...inlineComment(43, "No, a boolean is correct."), in_reply_to_id: 42, path: "schema/review.graphql", line: null },
    ];
    await page.goto(`${url}/pr/example/project/12`);
    await page.getByRole("button", { name: "Review comments", exact: true }).click();

    // When the reply is clicked
    await page.locator(".file-comment-thread").filter({ hasText: "No, a boolean is correct." }).click();

    // Then the thread dialog includes its original comment
    await browserExpect(page.locator(".comment-detail").getByText("Should drafts be nullable?", { exact: true })).toBeVisible();
  });

  test("opening a PR skips files already viewed on GitHub", async () => {
    // Given the first file is already reviewed on GitHub
    state.viewedFiles["src/reviews.ts"] = "VIEWED";

    // When opening the PR
    await page.goto(`${url}/pr/example/project/12`);

    // Then the first file with unreviewed hunks is selected
    await browserExpect(page.getByLabel("Current file")).toHaveText("review.graphql");
  });

  test("opening a working copy without a file suffix skips reviewed files", async () => {
    // Given the first file is reviewed locally
    await page.goto(`${url}/workspaces/project`);
    await page.getByRole("checkbox", { name: "File reviewed", exact: true }).click();
    await viewedFile(page, "src/reviews.ts").waitFor({ state: "attached" });
    // And the reader last visited a later file
    await page.keyboard.press("l");
    await page.keyboard.press("l");
    await browserExpect(page.getByLabel("Current file")).toHaveText("settings.json");

    // When reopening the working-copy review without a file selection
    await page.goto(`${url}/workspaces/project`);

    // Then the first file with unreviewed hunks is selected
    await browserExpect(page.getByLabel("Current file")).toHaveText("review.graphql");
  });
  test("Escape closes discussion while its review composer has focus", async () => {
    // Given the discussion panel with the always-mounted settings popovers hidden
    await page.goto(`${url}/pr/example/project/12`);
    await page.getByRole("button", { name: "PR overview" }).click();
    await page.getByLabel("Review summary", { exact: true }).fill("Keep this draft");
    // When Escape is pressed in the composer
    await page.keyboard.press("Escape");
    // Then the discussion panel closes
    await browserExpect(page.getByRole("dialog", { name: "PR overview" })).toBeHidden();
  });

  test("flagging a hunk advances and uppercase navigation returns to it after reload", async () => {
    // Given a fully loaded PR review
    await page.goto(`${url}/pr/example/project/12`);
    await browserExpect(page.getByRole("progressbar", { name: "Change review progress" })).toHaveAttribute("aria-valuetext", "0 of 3 changes reviewed");
    await page.locator("[data-biff-focused]").waitFor();
    // When the reader flags the first hunk and reloads
    await page.keyboard.press("!");
    await browserExpect(page.getByRole("button", { name: "Follow-ups (1)", exact: true })).toBeVisible();
    await page.reload();
    await browserExpect(page.getByRole("button", { name: "Follow-ups (1)", exact: true })).toBeVisible();
    await page.keyboard.press("N");
    // Then follow-up navigation reaches the reviewed hunk
    await browserExpect(page.getByRole("status").filter({ hasText: "Follow-up 1 of 1" })).toBeVisible();
    await browserExpect(page.getByRole("progressbar", { name: "Change review progress" })).toHaveAttribute("aria-valuetext", "1 of 3 changes reviewed");
  });
  test("semantic hunk navigation skips folded imports and selects the next function", async () => {
    // Given a new file containing imports and two functions in a single Git hunk
    state.patch = createTwoFilesPatch("/dev/null", "file.ts", '', 'import A from "a";\nfunction first() {}\nfunction second() {}\n');
    await page.goto(`${url}/workspaces/project`);
    await page.getByRole("button", { name: "1 Import change", exact: true }).waitFor();
    await page.locator("[data-biff-focused]").waitFor();

    // When moving to the next review unit
    await page.keyboard.press("n");

    // Then navigation reaches the second function inside the same all-green hunk
    await browserExpect(page.locator("[data-biff-focused]")).toHaveText("function second() {}");
  });

  test("semantic hunk completion survives a fifth-function edit after reload", async () => {
    // Given ten newly added functions reviewed through the existing hunk shortcut
    const source = Array.from({ length: 10 }, (_, index) => `function f${index + 1}() { return ${index}; }\n`).join("");
    state.patch = createTwoFilesPatch("/dev/null", "file.ts", "", source);
    await page.goto(`${url}/workspaces/project`);
    await page.locator("[data-biff-focused]").waitFor();
    for (let count = 1; count <= 10; count++) {
      await page.keyboard.press("Space");
      await page.locator(`[aria-label="Change review progress"][aria-valuenow="${count}"]`).waitFor();
    }
    // And the fifth function grows while the others retain their exact text
    state.patch = createTwoFilesPatch("/dev/null", "file.ts", "", source.replace("return 4;", "\n  const value = 40;\n  return value;\n"));

    // When the review loads the new snapshot
    await page.reload();

    // Then the existing UI retains the other nine hunk approvals
    await browserExpect(page.getByRole("progressbar", { name: "Change review progress" })).toHaveAttribute("aria-valuetext", "9 of 10 changes reviewed");
  });

  test("the URL box opens a PR after registering it with the inbox", async () => {
    // Given the dashboard's manual recovery form
    await page.goto(`${url}/prs`);
    await page.getByLabel("GitHub PR URL").fill("https://github.com/example/project/pull/12");

    // When the reader registers and opens the PR
    await page.getByRole("button", { name: "Open PR", exact: true }).click();

    // Then the form reaches the requested review
    await browserExpect(page).toHaveURL(`${url}/pr/example/project/12/f/reviews.ts`);
  });

  test("failed URL recovery keeps the error available for retry", async () => {
    // Given a PR lookup that GitHub cannot complete
    await page.route("**/track", (route) => route.fulfill({ status: 503, json: { error: "GitHub unavailable" } }));
    await page.goto(`${url}/prs`);
    await page.getByLabel("GitHub PR URL").fill("https://github.com/example/project/pull/12");

    // When registration fails
    await page.getByRole("button", { name: "Open PR", exact: true }).click();

    // Then the form reports the failure instead of navigating away
    await browserExpect(page.getByRole("alert")).toHaveText("GitHub unavailable · Saved PRs remain available.");
  });

  test("working-copy file URLs preserve the selected revision across reload", async () => {
    // Given a working-copy revision with its first file selected
    await page.goto(`${url}/workspaces/project?rev=@-`);
    await page.locator("[data-biff-focused]").waitFor();

    // When the reader moves to another file and reloads
    await page.keyboard.press("l");
    await page.reload();

    // Then the URL and viewer retain that file and revision
    await browserExpect(page).toHaveURL(`${url}/workspaces/project/f/review.graphql?rev=@-`);
    await browserExpect(page.getByLabel("Current file")).toHaveText("review.graphql");
  });

  test("a reviewed PR file in the URL wins over delayed review progress", async () => {
    // Given a reviewed file explicitly linked from a PR
    state.viewedFiles["src/reviews.ts"] = "VIEWED";
    // And GitHub's viewed state arrives after the viewer
    const held = Promise.withResolvers<void>();
    await page.route("**/viewed", async (route) => { await held.promise; await fixtureResponse(route, state); });
    await page.goto(`${url}/pr/example/project/12/f/reviews.ts`);
    await page.locator("[data-biff-focused]").waitFor();

    // When saved review state arrives
    held.resolve();
    await browserExpect(page.getByRole("checkbox", { name: "File reviewed", exact: true })).toBeChecked();

    // Then selection remains on the requested file even though other files need review
    await browserExpect(page.getByLabel("Current file")).toHaveText("reviews.ts");
  });

  test("duplicate file links survive reordering and open in a fresh tab", async () => {
    // Given duplicate basenames in reverse path order
    const client = createTwoFilesPatch("client/foo.ts", "client/foo.ts", "const client = 1;\n", "const client = 2;\n");
    const server = createTwoFilesPatch("server/foo.ts", "server/foo.ts", "const server = 1;\n", "const server = 2;\n");
    state.patch = server + client;
    await page.goto(`${url}/workspaces/project`);
    await browserExpect(page).toHaveURL(`${url}/workspaces/project/f/foo.ts-2`);
    // And the patch order changes before sharing
    state.patch = client + server;

    // When a fresh tab opens the shared link without session storage
    const shared = await context.newPage();
    await shared.goto(page.url());

    // Then the same full-path file opens
    await browserExpect(shared.locator("[data-biff-focused]")).toHaveText("const server = 2;");
  });

  test("missing file links fall back to the first file and repair the URL", async () => {
    // Given a PR link to a file that is no longer present
    const link = `${url}/pr/example/project/12/f/deleted.ts?commit=${previous}`;

    // When the link opens
    await page.goto(link);

    // Then the first file replaces the missing selection
    await browserExpect(page).toHaveURL(`${url}/pr/example/project/12/f/reviews.ts?commit=${previous}`);
    await browserExpect(page.getByLabel("Current file")).toHaveText("reviews.ts");
  });

  test("encoded file links retain special characters after reload", async () => {
    // Given a filename containing URL delimiters, Unicode, and a literal percent escape
    const name = "café #?%20.ts";
    state.patch = createTwoFilesPatch("/dev/null", `src/${name}`, "", "const value = 2;\n");

    // When its encoded file link opens and reloads
    await page.goto(`${url}/workspaces/project/f/${encodeURIComponent(name)}`);
    await page.locator("[data-biff-focused]").waitFor();
    await page.reload();

    // Then the original filename is selected
    await browserExpect(page.getByLabel("Current file")).toHaveText(name);
  });

  test("file navigation replaces history instead of adding an entry for every file", async () => {
    // Given a review opened from the working copies dashboard
    await page.goto(`${url}/workspaces`);
    await page.getByRole("link", { name: "project", exact: true }).click();
    await page.locator("[data-biff-focused]").waitFor();

    // When the reader crosses multiple files and goes back once
    await page.keyboard.press("l");
    await page.keyboard.press("l");
    await browserExpect(page).toHaveURL(`${url}/workspaces/project/f/settings.json`);
    await page.goBack();

    // Then Back returns to the dashboard, not another file
    await browserExpect(page).toHaveURL(`${url}/workspaces`);
  });

  test("browser history restores a file URL without remounting the review", async () => {
    // Given another file URL in the same review's browser history
    await page.goto(`${url}/workspaces/project/f/reviews.ts`);
    await page.locator("[data-biff-focused]").waitFor();
    await page.evaluate(() => history.pushState(null, "", "/workspaces/project/f/settings.json"));
    await browserExpect(page.getByLabel("Current file")).toHaveText("settings.json");

    // When the reader goes back to the earlier file URL
    await page.goBack();

    // Then selection follows browser history
    await browserExpect(page.getByLabel("Current file")).toHaveText("reviews.ts");
  });

  test("g g opens GitHub from a PR file URL", async () => {
    // Given a PR opened at a particular file
    await context.route("https://github.com/**", (route) => route.fulfill({ body: "GitHub PR" }));
    await page.goto(`${url}/pr/example/project/12/f/settings.json`);
    await page.locator("[data-biff-focused]").waitFor();

    // When the reader uses the go-to-GitHub shortcut
    const opened = context.waitForEvent("page");
    await page.keyboard.press("g");
    await page.keyboard.press("g");
    const github = await opened;

    // Then the original PR opens without the file suffix
    await browserExpect(github).toHaveURL("https://github.com/example/project/pull/12");
  });

  test("a retained follow-up query does not override the file URL", async () => {
    // Given a follow-up in a different file from the explicitly selected file
    state.inline = [{ ...inlineComment(42, "Should drafts be nullable?"), path: "schema/review.graphql", line: 6 }];
    // And the URL still includes a previous follow-up request
    followUps = [{ type: "thread", id: "github:42", label: "Should drafts be nullable?", location: { path: "schema/review.graphql", line: 6, side: "RIGHT" } }];

    // When the file URL opens with that retained query
    const conversation = page.waitForResponse("**/conversation");
    await page.goto(`${url}/pr/example/project/12/f/settings.json?followUp=first`);
    await browserExpect(page.getByRole("button", { name: "Follow-ups (1)", exact: true })).toBeVisible();
    await conversation;

    // Then the explicit file remains selected
    await browserExpect(page.getByLabel("Current file")).toHaveText("settings.json");
  });

  test("slash search counts only occurrences in the current file", async () => {
    // Given two changed files using the same variable
    await openFileSearchFixture(page, state);

    // When searching with the file-local shortcut
    await page.keyboard.press("/");
    await page.getByRole("textbox", { name: "Search current file", exact: true }).fill("foo");

    // Then only the current file's three occurrences are counted
    await browserExpect(page.locator(".file-find [role=status]")).toHaveText("3 matches");
  });

  test("file search highlights text spanning syntax tokens without rewriting source", async () => {
    // Given a rendered function call whose name and punctuation have separate syntax spans
    await openFileSearchFixture(page, state);

    // When a literal search crosses those token boundaries
    await page.keyboard.press("/");
    await page.getByRole("textbox", { name: "Search current file", exact: true }).fill("consume(foo");

    // Then the highlight covers the exact text across the original nodes
    await browserExpect.poll(() => highlightedFileSearchText(page)).toEqual(["consume(foo"]);
  });

  test("file search uses a yellow highlight inside the diff's shadow root", async () => {
    // Given searchable code in the reading surface
    await openFileSearchFixture(page, state);

    // When the reader searches for a variable
    await page.keyboard.press("/");
    await page.getByRole("textbox", { name: "Search current file", exact: true }).fill("foo");

    // Then the source highlight uses the requested yellow background
    await browserExpect.poll(() => page.locator("[data-content] > [data-line]").first().evaluate((row) => getComputedStyle(row, "::highlight(biff-file-search)").backgroundColor)).toBe("rgb(246, 211, 101)");
  });

  test("file search steps through occurrences and wraps backwards within the file", async () => {
    // Given a variable used twice on one line, with another use earlier in the file
    await openFileSearchFixture(page, state);
    await page.keyboard.press("/");
    await page.getByRole("textbox", { name: "Search current file", exact: true }).fill("foo");

    // When Enter selects the first occurrence and Shift+Enter wraps backwards
    await page.keyboard.press("Enter");
    await page.getByText("1 of 3 matches", { exact: true }).waitFor();
    await page.keyboard.press("Shift+Enter");

    // Then the last occurrence in this file is selected, not a match in the next file
    await browserExpect(page.locator(".file-find [role=status]")).toHaveText("3 of 3 matches");
  });

  test("Escape clears file-search highlights", async () => {
    // Given an active search with painted occurrences
    await openFileSearchFixture(page, state);
    await page.keyboard.press("/");
    await page.getByRole("textbox", { name: "Search current file", exact: true }).fill("foo");
    await page.getByText("3 matches", { exact: true }).waitFor();

    // When the reader dismisses the search
    await page.keyboard.press("Escape");

    // Then no search ranges remain painted
    await browserExpect.poll(() => highlightedFileSearchText(page)).toEqual([]);
  });

  test("slash refocuses an existing file search after reading code", async () => {
    // Given an active search after the reader returns to the code
    await openFileSearchFixture(page, state);
    await page.keyboard.press("/");
    const input = page.getByRole("textbox", { name: "Search current file", exact: true });
    await input.fill("foo");
    await page.getByRole("main", { name: "Diff reading surface" }).focus();

    // When the reader presses slash again
    await page.keyboard.press("/");

    // Then the existing query is ready to edit
    await browserExpect(input).toBeFocused();
  });

  test("Ctrl+F keeps its query separate from file-local search", async () => {
    // Given a local search for a variable
    await openFileSearchFixture(page, state);
    await page.keyboard.press("/");
    await page.getByRole("textbox", { name: "Search current file", exact: true }).fill("foo");

    // When the reader searches across files and then returns to local search
    await page.keyboard.press("Control+f");
    await page.getByRole("textbox", { name: "Search files and symbols", exact: true }).fill("other");
    await page.keyboard.press("Escape");
    await page.getByRole("main", { name: "Diff reading surface" }).focus();
    await page.keyboard.press("/");

    // Then the local symbol query is unchanged
    await browserExpect(page.getByRole("textbox", { name: "Search current file", exact: true })).toHaveValue("foo");
  });

  test("file search reveals a match in omitted context after full source arrives", async () => {
    // Given a variable declaration outside the patch's context
    const oldSource = 'const foo = 1;\n' + '// context\n'.repeat(12) + 'before();\n';
    const newSource = oldSource.replace("before();", "after(foo);");
    state.patch = createTwoFilesPatch("file.ts", "file.ts", oldSource, newSource);
    // And the full-source response is held while the reader starts searching
    const gate = Promise.withResolvers<void>();
    await page.route("**/contents", async (route) => {
      await gate.promise;
      await route.fulfill({ json: { oldFile: { name: "file.ts", contents: oldSource }, newFile: { name: "file.ts", contents: newSource } } });
    });
    await page.goto(`${url}/workspaces/project`);
    await page.locator("[data-biff-focused]").waitFor();
    await page.keyboard.press("/");
    await page.getByRole("textbox", { name: "Search current file", exact: true }).fill("foo");
    await page.getByText("1 matches · Loading full source…", { exact: true }).waitFor();

    // When full source arrives and match navigation wraps to the omitted declaration
    gate.resolve();
    await page.getByText("2 matches", { exact: true }).waitFor();
    await page.keyboard.press("Enter");
    await page.getByText("2 of 2 matches", { exact: true }).waitFor();
    await page.keyboard.press("Enter");

    // Then the declaration is expanded and focused at its original source coordinate
    await browserExpect(page.locator("[data-biff-focused]")).toHaveAttribute("data-line", "1");
  });

  test("slash search starts with selected source text", async () => {
    // Given a variable selected in the rendered source
    await openFileSearchFixture(page, state);
    await page.locator("[data-content] > [data-line]").first().evaluate((row) => {
      const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode as Text;
        const start = node.data.indexOf("foo");
        if (start < 0) continue;
        const range = document.createRange();
        range.setStart(node, start);
        range.setEnd(node, start + 3);
        window.getSelection()!.removeAllRanges();
        window.getSelection()!.addRange(range);
        break;
      }
    });

    // When the reader presses slash
    await page.keyboard.press("/");

    // Then the selected symbol is ready to search without retyping it
    await browserExpect(page.getByRole("textbox", { name: "Search current file", exact: true })).toHaveValue("foo");
  });

  test("file search reveals an occurrence inside folded imports", async () => {
    // Given imports collapsed above the current reading position
    state.patch = createTwoFilesPatch("/dev/null", "file.ts", "", 'import { foo } from "module";\n\nconsume(foo);\n');
    await page.goto(`${url}/workspaces/project`);
    await page.locator("[data-biff-focused]").waitFor();
    await page.keyboard.press("/");
    await page.getByRole("textbox", { name: "Search current file", exact: true }).fill("foo");

    // When the reader advances past the current use and wraps to its import
    await page.keyboard.press("Enter");
    await page.getByText("2 of 2 matches", { exact: true }).waitFor();
    await page.keyboard.press("Enter");

    // Then the import is expanded and focused
    await browserExpect(page.locator("[data-biff-focused]")).toHaveText('import { foo } from "module";');
  });

  test("file search reveals occurrences in collapsed deleted code", async () => {
    // Given a replacement whose only use of the variable is on the old side
    state.patch = createTwoFilesPatch("file.ts", "file.ts", 'old(foo);\n', 'next();\n');
    await page.goto(`${url}/workspaces/project`);
    await page.locator("[data-biff-focused]").waitFor();
    await page.keyboard.press("/");
    await page.getByRole("textbox", { name: "Search current file", exact: true }).fill("foo");

    // When the reader selects that occurrence
    await page.keyboard.press("Enter");

    // Then navigation reveals and selects the removed use
    await browserExpect(page.locator("[data-biff-focused]")).toHaveText("old(foo);");
  });

  test("file comments defaults to the selected file, including its outdated threads", async () => {
    // Given comments on two files and an outdated thread on the selected file
    state.inline = [inlineComment(42, "Another file's comment."), { ...inlineComment(43, "Selected file's comment."), path: "schema/review.graphql", line: 6 }, { ...inlineComment(44, "Selected file's outdated comment."), path: "schema/review.graphql", line: null, original_line: 2 }];
    await page.goto(`${url}/pr/example/project/12/f/review.graphql`);

    // When opening comments from the selected file's toolbar
    await page.getByRole("button", { name: "Comments (2/3)", exact: true }).click();

    // Then only that file's current and outdated discussion is shown
    await browserExpect(page.locator(".file-comment-thread .markdown-text")).toHaveText(["Selected file's comment.", "Selected file's outdated comment."]);
  });

  test("review-wide comments counts unresolved threads rather than replies", async () => {
    // Given two comments in one thread and another file's discussion
    state.inline = [inlineComment(42, "Root comment."), { ...inlineComment(43, "A reply."), in_reply_to_id: 42 }, { ...inlineComment(44, "Another file's comment."), path: "schema/review.graphql", line: 6 }];
    await page.goto(`${url}/pr/example/project/12`);
    await page.getByRole("button", { name: "Comments (1/2)", exact: true }).click();

    // When switching the modal to the entire review
    await page.getByRole("button", { name: "Entire review (2)", exact: true }).click();

    // Then each unresolved thread counts once, regardless of its replies
    await browserExpect(page.locator(".file-comments-count")).toHaveText("2 threads · 2 unresolved");
  });

  test("review-wide comments labels files and retains discussions outside the patch", async () => {
    // Given discussion on the selected file, another changed file, and a missing file
    state.inline = [inlineComment(42, "First file."), { ...inlineComment(43, "Selected file."), path: "schema/review.graphql", line: 6 }, { ...inlineComment(44, "Missing file."), path: "deleted.ts", line: null, original_line: 1 }];
    await page.goto(`${url}/pr/example/project/12/f/review.graphql`);
    await page.getByRole("button", { name: "Comments (1/3)", exact: true }).click();

    // When switching the modal to the entire review
    await page.getByRole("button", { name: "Entire review (3)", exact: true }).click();

    // Then each thread identifies its file and line, with the selected file first and orphaned files retained
    await browserExpect(page.locator(".file-comment-path")).toHaveText(["schema/review.graphql:L6", "src/reviews.ts:L3", "deleted.ts:L1"]);
  });

  test("comments can switch back to only this file", async () => {
    // Given the modal showing comments from the whole review
    state.inline = [inlineComment(42, "This file."), { ...inlineComment(43, "Another file."), path: "schema/review.graphql", line: 6 }];
    await page.goto(`${url}/pr/example/project/12`);
    await page.getByRole("button", { name: "Comments (1/2)", exact: true }).click();
    await page.getByRole("button", { name: "Entire review (2)", exact: true }).click();

    // When the reader restores the file-local scope
    await page.getByRole("button", { name: "This file (1)", exact: true }).click();

    // Then the other file's discussion is no longer listed
    await browserExpect(page.locator(".file-comment-thread .markdown-text")).toHaveText(["This file."]);
  });

  test("reopening comments defaults back to this file", async () => {
    // Given a modal previously switched to the whole review
    state.inline = [inlineComment(42, "This file."), { ...inlineComment(43, "Another file."), path: "schema/review.graphql", line: 6 }];
    await page.goto(`${url}/pr/example/project/12`);
    await page.getByRole("button", { name: "Comments (1/2)", exact: true }).click();
    await page.getByRole("button", { name: "Entire review (2)", exact: true }).click();
    await page.getByRole("button", { name: "Close review comments", exact: true }).click();

    // When the reader reopens it with the keyboard shortcut
    await page.keyboard.press("g");
    await page.keyboard.press("c");

    // Then the file-local scope is selected again
    await browserExpect(page.getByRole("button", { name: "This file (1)", exact: true })).toHaveAttribute("aria-pressed", "true");
  });

  test("a file without comments does not show another file's discussion by default", async () => {
    // Given a comment only on a different file
    state.inline = [inlineComment(42, "Another file's comment.")];
    await page.goto(`${url}/pr/example/project/12/f/settings.json`);

    // When opening the selected file's empty comment list
    await page.getByRole("button", { name: "Comments (0/1)", exact: true }).click();

    // Then the modal explains that this file has no comments
    await browserExpect(page.getByText("No comments on this file.", { exact: true })).toBeVisible();
  });

  test("review-wide comments preserves reply drafts when returning to its list", async () => {
    // Given a reply draft in another file's thread opened from the review-wide list
    state.inline = [inlineComment(42, "This file."), { ...inlineComment(43, "Another file."), path: "schema/review.graphql", line: 6 }];
    await page.goto(`${url}/pr/example/project/12`);
    await page.getByRole("button", { name: "Comments (1/2)", exact: true }).click();
    await page.getByRole("button", { name: "Entire review (2)", exact: true }).click();
    await page.locator(".file-comment-thread").filter({ hasText: "Another file." }).click();
    await page.getByRole("combobox", { name: "Thread reply", exact: true }).fill("Keep this unsent reply.");

    // When returning to the list and reopening that thread
    await page.keyboard.press("Escape");
    await page.locator(".file-comment-thread").filter({ hasText: "Another file." }).click();

    // Then both the review-wide list and its draft survive the round trip
    await browserExpect(page.getByRole("combobox", { name: "Thread reply", exact: true })).toHaveValue("Keep this unsent reply.");
  });

  test("l switches file comments to the entire review", async () => {
    // Given file-local comments with another file's discussion available
    state.inline = [inlineComment(42, "This file."), { ...inlineComment(43, "Another file."), path: "schema/review.graphql", line: 6 }];
    await page.goto(`${url}/pr/example/project/12`);
    await page.getByRole("button", { name: "Comments (1/2)", exact: true }).click();

    // When the reader moves right between scopes
    await page.keyboard.press("l");

    // Then both files' comments are listed
    await browserExpect(page.locator(".file-comment-thread .markdown-text")).toHaveText(["This file.", "Another file."]);
  });

  test("h switches review-wide comments back to this file", async () => {
    // Given comments showing the entire review
    state.inline = [inlineComment(42, "This file."), { ...inlineComment(43, "Another file."), path: "schema/review.graphql", line: 6 }];
    await page.goto(`${url}/pr/example/project/12`);
    await page.getByRole("button", { name: "Comments (1/2)", exact: true }).click();
    await page.keyboard.press("l");

    // When the reader moves left between scopes
    await page.keyboard.press("h");

    // Then only the selected file's comments remain
    await browserExpect(page.locator(".file-comment-thread .markdown-text")).toHaveText(["This file."]);
  });

  test("l h l keeps switching comment scopes when this file has no comments", async () => {
    // Given a selected file without comments and discussion on another file
    state.inline = [inlineComment(42, "Another file's comment.")];
    await page.goto(`${url}/pr/example/project/12/f/settings.json`);
    await page.getByRole("button", { name: "Comments (0/1)", exact: true }).click();

    // When switching to the review, back to the empty file, and to the review again
    await page.keyboard.press("l");
    await page.locator(".file-comment-thread").waitFor();
    await page.keyboard.press("h");
    await page.getByText("No comments on this file.", { exact: true }).waitFor();
    await page.keyboard.press("l");

    // Then the second rightward switch still reaches the review's discussion
    await browserExpect(page.locator(".file-comment-thread .markdown-text")).toHaveText(["Another file's comment."]);
  });

  test("comment scope buttons count each unresolved thread once", async () => {
    // Given a two-comment thread on this file and one comment on another file
    state.inline = [inlineComment(42, "Root comment."), { ...inlineComment(43, "A reply."), in_reply_to_id: 42 }, { ...inlineComment(44, "Another file."), path: "schema/review.graphql", line: 6 }];
    await page.goto(`${url}/pr/example/project/12`);

    // When opening the comments modal
    await page.getByRole("button", { name: "Comments (1/2)", exact: true }).click();

    // Then both scope labels expose unresolved thread totals without counting replies again
    await browserExpect(page.getByRole("group", { name: "Comment scope", exact: true }).getByRole("button")).toHaveText(["This file (1)", "Entire review (2)"]);
  });

  test("the comments toolbar shows this file's count against the whole review", async () => {
    // Given two threads and a reply on one file, and one thread on a second file
    state.inline = [inlineComment(42, "Root comment."), { ...inlineComment(43, "A reply."), in_reply_to_id: 42 }, { ...inlineComment(44, "Another file."), path: "schema/review.graphql", line: 6 }, inlineComment(45, "Another thread.")];
    await page.goto(`${url}/pr/example/project/12`);
    await page.getByRole("button", { name: "Comments (2/3)", exact: true }).waitFor();

    // When navigating to the second file
    await page.keyboard.press("l");

    // Then the file count changes while the review total stays the same
    await browserExpect(page.getByRole("button", { name: /^Comments \(/ })).toHaveText("Comments (1/3)");
  });

  test("comment scope counts exclude resolved threads in both files", async () => {
    // Given open and resolved threads on this file and another file
    const resolved = { id: "RESOLVED", resolved: true, canResolve: false, canReopen: true };
    state.inline = [inlineComment(42, "Open here."), { ...inlineComment(43, "Resolved here."), reviewThread: resolved }, { ...inlineComment(44, "Open elsewhere."), path: "schema/review.graphql", line: 6 }, { ...inlineComment(45, "Resolved elsewhere."), path: "schema/review.graphql", line: 7, reviewThread: { ...resolved, id: "OTHER_RESOLVED" } }];
    await page.goto(`${url}/pr/example/project/12`);

    // When opening the file's comments
    await page.getByRole("button", { name: "Comments (1/2)", exact: true }).click();

    // Then each scope counts only its unresolved threads
    await browserExpect(page.getByRole("group", { name: "Comment scope", exact: true }).getByRole("button")).toHaveText(["This file (1)", "Entire review (2)"]);
  });

  test("the comments toolbar excludes resolved threads and replies", async () => {
    // Given a resolved thread with a reply and an unresolved thread on this file
    state.inline = [{ ...inlineComment(42, "Resolved root."), reviewThread: { id: "RESOLVED", resolved: true, canResolve: false, canReopen: true } }, { ...inlineComment(43, "Resolved reply."), in_reply_to_id: 42 }, inlineComment(44, "Open here.")];
    // And another unresolved thread on a different file
    state.inline.push({ ...inlineComment(45, "Open elsewhere."), path: "schema/review.graphql", line: 6 });

    // When the review opens
    await page.goto(`${url}/pr/example/project/12`);

    // Then the toolbar counts only the two unresolved threads
    await browserExpect(page.getByRole("button", { name: /^Comments \(/ })).toHaveText("Comments (1/2)");
  });

  test("resolving a thread updates toolbar counts before its save finishes", async () => {
    // Given a resolvable thread and another file's unresolved thread
    state.inline = [{ ...inlineComment(42, "Resolve me."), reviewThread: { id: "THREAD_42", resolved: false, canResolve: true, canReopen: true } }, { ...inlineComment(43, "Another file."), path: "schema/review.graphql", line: 6 }];
    // And the resolution request is held
    const gate = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    await page.route("**/thread", async (route) => {
      started.resolve();
      await gate.promise;
      state.inline[0].reviewThread!.resolved = true;
      await route.fulfill({ json: { saved: true } });
    });
    await page.goto(`${url}/pr/example/project/12`);
    await page.getByRole("button", { name: "Comments (1/2)", exact: true }).click();

    try {
      // When resolving the selected thread and closing the modal before acknowledgement
      await page.keyboard.press("r");
      await started.promise;
      await page.getByRole("button", { name: "Close file comments", exact: true }).click();

      // Then the toolbar immediately reflects the remaining unresolved thread
      await browserExpect(page.getByRole("button", { name: /^Comments \(/ })).toHaveText("Comments (0/1)");
    } finally { gate.resolve(); }
  });

  test("a failed resolution restores unresolved counts", async () => {
    // Given an unresolved thread whose resolution will fail
    state.inline = [{ ...inlineComment(42, "Keep me open."), reviewThread: { id: "THREAD_42", resolved: false, canResolve: true, canReopen: true } }];
    await page.route("**/thread", (route) => route.fulfill({ status: 500, json: { error: "Could not resolve thread." } }));
    await page.goto(`${url}/pr/example/project/12`);
    await page.getByRole("button", { name: "Comments (1/1)", exact: true }).click();

    // When the server rejects the optimistic resolution
    await page.keyboard.press("r");
    await page.locator(".file-comments .background-save-error").waitFor();

    // Then both scope counts return to the last acknowledged unresolved state
    await browserExpect(page.getByRole("group", { name: "Comment scope", exact: true }).getByRole("button")).toHaveText(["This file (1)", "Entire review (1)"]);
  });

  test("the file rail tags added, deleted, and updated files", async () => {
    // Given a new file, a deleted file, and an existing file with only added lines
    state.patch = fileStatusPatch();

    // When the review opens
    await page.goto(`${url}/workspaces/project`);

    // Then each filename has its file-level status, not its hunk's addition/deletion status
    await browserExpect(page.locator(".file-rail .file-change-tag")).toHaveText(["A", "D", "U"]);
  });

  test("the file picker includes file status tags before its filenames", async () => {
    // Given added, deleted, and updated files in the review
    state.patch = fileStatusPatch();
    await page.goto(`${url}/workspaces/project`);
    await page.locator("[data-biff-focused]").waitFor();

    // When opening the file list
    await page.keyboard.press("Control+p");

    // Then its rows expose the same compact file statuses as the rail
    await browserExpect(page.getByRole("listbox", { name: "Files in this review", exact: true }).locator(".file-change-tag")).toHaveText(["A", "D", "U"]);
  });

  test("file status tags use green, red, and orange for additions, deletions, and updates", async () => {
    // Given added, deleted, and updated files in the review
    state.patch = fileStatusPatch();
    await page.goto(`${url}/workspaces/project`);
    await page.locator(".file-rail .file-change-tag").first().waitFor();

    // When reading the tags' rendered colors
    const colors = await page.locator(".file-rail .file-change-tag").evaluateAll((tags) => tags.map((tag) => getComputedStyle(tag).color));

    // Then the statuses use mint green, coral red, and amber-orange respectively
    expect(colors).toEqual(["rgb(134, 217, 172)", "rgb(241, 153, 168)", "rgb(245, 185, 113)"]);
  });

  test("the PR list names approvers without annotating the reader's username", async () => {
    // Given an approved PR with approvals from the reader and another reviewer
    state.approvalActivity = { head, headAuthor: "author", viewer: "me", reviewDecision: "APPROVED", checks: "Passing", events: [], approvers: ["alice", "me"] };

    // When opening the PR list
    await page.goto(`${url}/prs`);

    // Then the badge lists both usernames without a redundant personal marker
    await browserExpect(page.locator(".inbox-badges").getByText("Approved by @alice, @me", { exact: true })).toBeVisible();
  });

  test("another reviewer's approval is not presented as the reader's own", async () => {
    // Given a PR approved only by someone else
    state.approvalActivity = { head, headAuthor: "author", viewer: "me", reviewDecision: "APPROVED", checks: "Passing", events: [], approvers: ["alice"] };

    // When opening the PR list
    await page.goto(`${url}/prs`);

    // Then the approval names that reviewer without a personal approval marker
    await browserExpect(page.locator(".inbox-badges").getByText("Approved by @alice", { exact: true })).toBeVisible();
  });

  test("personal approval remains visible while the PR awaits other required reviews", async () => {
    // Given the reader has approved but GitHub still requires another review
    state.approvalActivity = { head, headAuthor: "author", viewer: "me", reviewDecision: "REVIEW_REQUIRED", checks: "Passing", events: [], approvers: ["me"] };

    // When opening the PR list
    await page.goto(`${url}/prs`);

    // Then the pending overall decision does not hide the reader's approval
    await browserExpect(page.locator(".inbox-badges").getByText("Awaiting review · Approved by @me", { exact: true })).toBeVisible();
  });

  test("cached approval badges still render before approver names have refreshed", async () => {
    // Given an approved snapshot saved before Biff recorded approver names
    state.approvalActivity = { head, headAuthor: "author", viewer: "me", reviewDecision: "APPROVED", checks: "Passing", events: [] };

    // When opening the PR list from that cache
    await page.goto(`${url}/prs`);

    // Then the existing approval status is retained without inventing an approver
    await browserExpect(page.locator(".inbox-badges").getByText("Approved", { exact: true })).toBeVisible();
  });

  test("approved PRs have a green check beside their title", async () => {
    // Given a PR whose overall review decision is approved
    state.approvalActivity = { head, headAuthor: "author", viewer: "me", reviewDecision: "APPROVED", checks: "Passing", events: [], approvers: ["alice"] };

    // When opening the PR list
    await page.goto(`${url}/prs`);

    // Then the check directly after its title uses the same mint green as other positive statuses
    await browserExpect(page.locator(".pr-summary .card-title + .pr-approved-check")).toHaveCSS("color", "rgb(134, 217, 172)");
  });

  test("partial approval does not show an overall approval check", async () => {
    // Given an individual approval while GitHub still requires other reviews
    state.approvalActivity = { head, headAuthor: "author", viewer: "me", reviewDecision: "REVIEW_REQUIRED", checks: "Passing", events: [], approvers: ["me"] };
    await page.goto(`${url}/prs`);

    // When the pending decision and individual approver are displayed
    await page.getByText("Awaiting review · Approved by @me", { exact: true }).waitFor();

    // Then the PR does not claim to be fully approved
    await browserExpect(page.locator(".pr-card").getByRole("img", { name: "Approved", exact: true })).toHaveCount(0);
  });

  test("failing CI has a small coral-red cross after the PR title and approval check", async () => {
    // Given an approved PR whose CI checks are failing
    state.approvalActivity = { head, headAuthor: "author", viewer: "me", reviewDecision: "APPROVED", checks: "Failing", events: [], approvers: ["alice"] };

    // When opening the PR list
    await page.goto(`${url}/prs`);

    // Then both indicators follow the title, with CI using the same coral red as deleted files
    await browserExpect(page.locator(".card-title + .pr-approved-check + .pr-ci-failing")).toHaveCSS("color", "rgb(241, 153, 168)");
  });

  test("the failing CI icon replaces the old error-styled status label", async () => {
    // Given a PR with failing CI
    state.approvalActivity = { head, headAuthor: "author", viewer: "me", reviewDecision: "REVIEW_REQUIRED", checks: "Failing", events: [], approvers: [] };
    await page.goto(`${url}/prs`);

    // When its compact failure icon is displayed beside the title
    await page.getByRole("img", { name: "CI failing", exact: true }).waitFor();

    // Then the old, prominent failure label is no longer rendered
    await browserExpect(page.getByText("CI: Failing", { exact: true })).toHaveCount(0);
  });

  test("PR status icons explain approvals and CI failures in hover tooltips", async () => {
    // Given an approved PR with failing CI
    state.approvalActivity = { head, headAuthor: "author", viewer: "me", reviewDecision: "APPROVED", checks: "Failing", events: [], approvers: ["alice"] };
    await page.goto(`${url}/prs`);
    await page.getByRole("img", { name: "CI failing", exact: true }).waitFor();

    // When reading the title-row icons' hover descriptions
    const tooltips = await page.locator(".pr-summary > div > [role=img]").evaluateAll((icons) => icons.map((icon) => icon.getAttribute("title")));

    // Then approval names its reviewers and the cross explains the CI failure
    expect(tooltips).toEqual(["Approved by @alice", "One or more CI checks failed"]);
  });

  test("the file picker shows reviewed and total semantic hunks for every file", async () => {
    // Given files with two and three independently reviewable functions
    state.patch = hunkProgressPatch();
    await page.goto(`${url}/workspaces/project`);
    await page.locator("[data-biff-focused]").waitFor();
    // And the first function has been marked reviewed
    await page.keyboard.press("Space");
    await page.locator('.change-progress[aria-valuetext="1 of 2 changes reviewed"]').waitFor();

    // When opening the file picker
    await page.keyboard.press("Control+p");

    // Then each file shows its own reviewed/total hunk count
    await browserExpect(page.locator(".file-picker-hunks")).toHaveText(["1/2 hunks", "0/3 hunks"]);
  });

  test("filtering the file picker keeps progress attached to its original file", async () => {
    // Given different progress totals for two files
    state.patch = hunkProgressPatch();
    await page.goto(`${url}/workspaces/project`);
    await page.locator("[data-biff-focused]").waitFor();
    await page.keyboard.press("Space");
    await page.locator('.change-progress[aria-valuetext="1 of 2 changes reviewed"]').waitFor();
    await page.keyboard.press("Control+p");

    // When filtering to only the second file
    await page.getByRole("combobox", { name: "Search files", exact: true }).fill("second.ts");

    // Then the remaining row retains the second file's counts, not the first row's counts
    await browserExpect(page.locator(".file-picker-hunks")).toHaveText(["0/3 hunks"]);
  });

  test("file-picker hunk totals exclude folded import-only blocks", async () => {
    // Given imports followed by two added functions in one Git hunk
    const source = 'import A from "a";\nimport B from "b";\n\nfunction first() {}\n\nfunction second() {}\n';
    state.patch = createTwoFilesPatch("/dev/null", "file.ts", "", source);
    // And complete source is available for import classification
    await page.route("**/contents", (route) => route.fulfill({ json: { oldFile: { name: "file.ts", contents: "" }, newFile: { name: "file.ts", contents: source } } }));
    await page.goto(`${url}/workspaces/project`);
    await page.locator("[data-biff-focused]").waitFor();

    // When opening the file picker
    await page.keyboard.press("Control+p");

    // Then only the two functions contribute to reviewable hunk totals
    await browserExpect(page.locator(".file-picker-hunks")).toHaveText(["0/2 hunks"]);
  });

  test("file pickers without saved review progress show hunk totals only", async () => {
    // Given a single-commit view without shared hunk review marks
    state.patch = hunkProgressPatch();
    await page.goto(`${url}/pr/example/project/12?commit=${previous}`);
    await page.locator("[data-biff-focused]").waitFor();

    // When opening its file picker
    await page.keyboard.press("Control+p");

    // Then the counts do not imply saved completion state where none exists
    await browserExpect(page.locator(".file-picker-hunks")).toHaveText(["2 hunks", "3 hunks"]);
  });

  test("Biff declares its SVG favicon on every application page", async () => {
    // Given the PR dashboard
    await page.goto(`${url}/prs`);

    // When the browser looks for a tab icon
    const icon = page.locator('link[rel="icon"][type="image/svg+xml"]');

    // Then it uses the self-contained outlined brand mark
    await browserExpect(icon).toHaveAttribute("href", "/favicon.svg");
  });

  test("older review summaries and line comments remain recoverable after a push", async () => {
    // Given a legacy draft with a summary and an old line anchor
    await page.goto(`${url}/pr/example/project/12`);
    await page.evaluate((commitId) => localStorage.setItem("biff:review:/api/github/pr/example/project/12", JSON.stringify({ commitId, body: "Keep the earlier summary.", comments: [{ path: "old.ts", line: 99, side: "LEFT", body: "Keep this old line comment." }] })), previous);

    // When opening the current review and its saved earlier drafts
    await page.reload();
    await page.getByRole("button", { name: "PR overview", exact: true }).click();
    await page.getByText("Earlier drafts (1)", { exact: true }).click();

    // Then the original summary and comment text are available without re-anchoring them
    await browserExpect(page.locator(".older-review-drafts .markdown-text")).toHaveText(["Keep the earlier summary.", "Keep this old line comment."]);
  });

  test("new review submissions never include older drafts or their stale line anchors", async () => {
    // Given unsent text and an old-file line comment on a previous head
    await page.goto(`${url}/pr/example/project/12`);
    await page.evaluate((commitId) => localStorage.setItem("biff:review:/api/github/pr/example/project/12", JSON.stringify({ commitId, body: "Old summary.", comments: [{ path: "old.ts", line: 99, side: "LEFT", body: "Old line." }] })), previous);
    await page.reload();

    // When saving and submitting a new review comment on the current head
    await composeComment(page);
    await page.getByLabel("Inline comment", { exact: true }).fill("Current line only.");
    await page.getByRole("button", { name: "Save as Review Comment", exact: true }).click();
    await page.getByRole("dialog").waitFor({ state: "detached" });
    await page.getByRole("button", { name: "PR overview", exact: true }).click();
    await page.getByRole("group", { name: "Submit review", exact: true }).getByRole("button", { name: "Comment", exact: true }).click();

    // Then only the explicitly saved current-head comment is submitted
    await browserExpect.poll(() => state.writes).toEqual([{ commitId: head, event: "COMMENT", body: "", comments: [{ path: "src/reviews.ts", line: 3, side: "RIGHT", body: "Current line only." }] }]);
  });

  test("separate drafts survive switching between PR heads", async () => {
    // Given a summary saved on the first head
    await page.goto(`${url}/pr/example/project/12`);
    await page.getByRole("button", { name: "PR overview", exact: true }).click();
    await page.getByLabel("Review summary", { exact: true }).fill("First head's draft.");
    // And an independent summary on a newer head
    state.prHead = "c".repeat(40);
    await page.reload();
    await page.getByRole("button", { name: "PR overview", exact: true }).click();
    await page.getByLabel("Review summary", { exact: true }).fill("Second head's draft.");

    // When returning to the first head
    state.prHead = head;
    await page.reload();
    await page.getByRole("button", { name: "PR overview", exact: true }).click();

    // Then its original draft is restored rather than overwritten by the newer one
    await browserExpect(page.getByLabel("Review summary", { exact: true })).toHaveValue("First head's draft.");
  });

  test("current-head legacy drafts still migrate with their summary and line comments", async () => {
    // Given a legacy draft for the current head before per-head storage exists
    await page.goto(`${url}/prs`);
    await page.evaluate((commitId) => localStorage.setItem("biff:review:/api/github/pr/example/project/12", JSON.stringify({ commitId, body: "Keep this current review.", comments: [{ path: "src/reviews.ts", line: 3, side: "RIGHT", body: "Keep this current comment." }] })), head);

    // When opening its review
    await page.goto(`${url}/pr/example/project/12`);
    await page.getByRole("button", { name: "PR overview", exact: true }).click();

    // Then the current draft is saved under its scoped key without dropping either kind of text
    await browserExpect.poll(() => page.evaluate((commitId) => JSON.parse(localStorage.getItem(`biff:review:/api/github/pr/example/project/12:${commitId}`)!), head)).toEqual({ commitId: head, body: "Keep this current review.", comments: [{ path: "src/reviews.ts", line: 3, side: "RIGHT", body: "Keep this current comment." }] });
  });

  test("submitted per-head drafts do not resurrect an older legacy copy", async () => {
    // Given a legacy draft and a newer empty record after that head's review was submitted
    await page.goto(`${url}/prs`);
    await page.evaluate((commitId) => {
      localStorage.setItem("biff:review:/api/github/pr/example/project/12", JSON.stringify({ commitId, body: "Already submitted.", comments: [] }));
      localStorage.setItem(`biff:review:/api/github/pr/example/project/12:${commitId}`, JSON.stringify({ commitId, body: "", comments: [] }));
    }, previous);

    // When opening the current review
    await page.goto(`${url}/pr/example/project/12`);
    await page.getByRole("button", { name: "PR overview", exact: true }).click();

    // Then the submitted legacy text is not offered as an unsent earlier draft
    await browserExpect(page.locator(".older-review-drafts")).toHaveCount(0);
  });

  test("background publication removes its original head's draft after navigating to a newer head", async () => {
    // Given a saved review comment on the first head
    await page.goto(`${url}/pr/example/project/12`);
    await composeComment(page);
    await page.getByLabel("Inline comment", { exact: true }).fill("Publish this first-head comment.");
    await page.getByRole("button", { name: "Save as Review Comment", exact: true }).click();
    await page.getByRole("dialog").waitFor({ state: "detached" });
    // And publication is held while the reader changes PR heads
    const held = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    await page.route("**/inline-comment", async (route) => {
      started.resolve();
      await held.promise;
      await fixtureResponse(route, state);
    });

    try {
      // When publishing, navigating away, and returning on a new head before acknowledgement
      await commentBadge(page).click();
      await page.getByRole("button", { name: "Save as Comment", exact: true }).click();
      await started.promise;
      await page.getByRole("navigation", { name: "Main navigation", exact: true }).getByRole("link", { name: "PRs", exact: true }).click();
      state.prHead = "c".repeat(40);
      await page.getByRole("link", { name: "Improve the viewer", exact: true }).click();
      await page.locator("[data-biff-focused]").waitFor();
      held.resolve();

      // Then the acknowledged comment is removed from the original head's persisted draft
      await browserExpect.poll(() => page.evaluate((commitId) => JSON.parse(localStorage.getItem(`biff:review:/api/github/pr/example/project/12:${commitId}`)!), head)).toEqual({ commitId: head, body: "", comments: [] });
    } finally { held.resolve(); }
  });

  test("a failed publication keeps the saved per-head review comment for retry", async () => {
    // Given a saved current-head review comment that GitHub will reject
    state.rejectInline = true;
    await page.goto(`${url}/pr/example/project/12`);
    await composeComment(page);
    await page.getByLabel("Inline comment", { exact: true }).fill("Keep this saved comment.");
    await page.getByRole("button", { name: "Save as Review Comment", exact: true }).click();
    await page.getByRole("dialog").waitFor({ state: "detached" });

    // When immediate publication fails
    await commentBadge(page).click();
    await page.getByRole("button", { name: "Save as Comment", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "GitHub rejected this line comment" }).waitFor();

    // Then the persisted review draft still contains the unpublished comment
    expect(await page.evaluate((commitId) => JSON.parse(localStorage.getItem(`biff:review:/api/github/pr/example/project/12:${commitId}`)!), head)).toEqual({ commitId: head, body: "", comments: [{ path: "src/reviews.ts", line: 3, side: "RIGHT", body: "Keep this saved comment." }] });
  });

  test("the current filename is fifty percent larger than neighboring filenames", async () => {
    // Given a review with a current file and neighboring files
    await page.goto(`${url}/workspaces/project`);
    await page.locator(".current-file-name").waitFor();

    // When comparing the rendered filename sizes
    const currentSize = await page.locator(".current-file-name").evaluate((name) => parseFloat(getComputedStyle(name).fontSize));
    const neighborSize = await page.locator(".file-neighbor").first().evaluate((name) => parseFloat(getComputedStyle(name).fontSize));

    // Then the reading file stands out without enlarging its neighbors
    expect(currentSize / neighborSize).toBe(1.5);
  });

  test("reformatted calls highlight changed symbols rather than every argument", async () => {
    // Given a call expanded from one line to many, with one renamed argument
    const oldSource = 'const cellElement = renderFn(columnIndex, cellCss, content, row, rowStyle, undefined, cellOnClick, tooltip);\n';
    const newSource = 'const cellElement = renderFn(\n  columnIndex,\n  cellCss,\n  renderedContent,\n  row,\n  rowStyle,\n  undefined,\n  cellOnClick,\n  tooltip,\n);\n';
    state.patch = createTwoFilesPatch("file.ts", "file.ts", oldSource, newSource);

    // When the actual viewer renders its patched Pierre word highlighting
    await page.goto(`${url}/workspaces/project`);

    // Then only the new argument and added punctuation receive stronger emphasis
    await browserExpect(page.locator('[data-line-type="change-addition"] [data-diff-span]')).toHaveText(["renderedContent", ","]);
  });

  test("settings exposes local review and file timing diagnostics", async () => {
    // Given a fully rendered review
    await page.goto(`${url}/workspaces/project`);
    await page.locator("[data-biff-focused]").waitFor();

    // When opening the local timing snapshot
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Diff performance", exact: true }).click();

    // Then review totals and file phases can be inspected without a console
    await browserExpect(page.getByRole("dialog", { name: "Diff performance", exact: true })).toHaveText(/Review phase totals[\s\S]*review preparation[\s\S]*DOM post-processing[\s\S]*Slowest file phases/);
  });

  test("timing reports distinguish parsed files from files actually rendered", async () => {
    // Given the three-file demo with only its first file visited
    await page.goto(`${url}/workspaces/project`);
    await page.locator("[data-biff-focused]").waitFor();

    // When inspecting the timing snapshot
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Diff performance", exact: true }).click();

    // Then the report does not imply all files have been rendered
    await browserExpect(page.getByRole("dialog", { name: "Diff performance", exact: true })).toHaveText(/1 \/ 3 files rendered in retained samples/);
  });

  test("timing exports include the measured block result and its coordinates", async () => {
    // Given a reformatted replacement rendered in the browser
    state.patch = createTwoFilesPatch("file.ts", "file.ts", "call(oldArgument);\n", "call(\n  newArgument\n);\n");
    await page.goto(`${url}/workspaces/project`);
    await page.locator('[data-line-type="change-addition"] [data-diff-span]').first().waitFor();

    // When downloading the local diagnostic snapshot
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Diff performance", exact: true }).click();
    const downloading = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export JSON", exact: true }).click();
    const download = await downloading;
    const report: { reviews: ReviewTimings[] } = await Bun.file((await download.path())!).json();

    // Then hunk/block attribution and the fallback outcome survive export
    expect(report.reviews.at(-1)?.samples.find((sample) => sample.phase === "block word comparison")).toMatchObject({ file: "file.ts", hunk: 0, block: 0, outcome: "highlighted" });
  });

  test("new comment phrases have continuous highlights across their spaces", async () => {
    // Given a replacement comment in a block that also reformats a call
    state.patch = createTwoFilesPatch("file.ts", "file.ts", '// Previously\ncall(value);\n', '// Given two authors that are in this state\ncall(\n  value\n);\n');

    // When the real viewer decorates the newly added phrase
    await page.goto(`${url}/workspaces/project`);

    // Then its internal spaces share the words' stronger addition highlight
    await browserExpect(page.locator('[data-line-type="change-addition"] [data-diff-span]')).toHaveText(["Given two authors that are in this state"]);
  });

  test("lowercase slash searches highlight every casing of a symbol", async () => {
    // Given differently cased symbols in the current file
    state.patch = createTwoFilesPatch("/dev/null", "file.ts", "", 'const foo = 1;\nconsume(Foo, FOO);\n');
    await page.goto(`${url}/workspaces/project`);
    await page.locator("[data-biff-focused]").waitFor();

    // When the reader searches with lowercase letters
    await page.keyboard.press("/");
    await page.getByRole("textbox", { name: "Search current file", exact: true }).fill("foo");

    // Then the original source text is highlighted regardless of case
    await browserExpect.poll(() => highlightedFileSearchText(page)).toEqual(["foo", "Foo", "FOO"]);
  });

  test("typing an uppercase letter switches slash search highlights to exact case", async () => {
    // Given an active lowercase query matching all three casings
    state.patch = createTwoFilesPatch("/dev/null", "file.ts", "", 'const foo = 1;\nconsume(Foo, FOO);\n');
    await page.goto(`${url}/workspaces/project`);
    await page.locator("[data-biff-focused]").waitFor();
    await page.keyboard.press("/");
    const input = page.getByRole("textbox", { name: "Search current file", exact: true });
    await input.fill("foo");
    await page.getByText("3 matches", { exact: true }).waitFor();

    // When the reader changes the query to include uppercase
    await input.fill("Foo");

    // Then stale differently cased highlights are removed immediately
    await browserExpect.poll(() => highlightedFileSearchText(page)).toEqual(["Foo"]);
  });

  test("smart-case match navigation uses the same exact casing as highlights", async () => {
    // Given differently cased symbols on separate lines
    state.patch = createTwoFilesPatch("/dev/null", "file.ts", "", 'const foo = 1;\nconsume(Foo);\nconsume(FOO);\n');
    await page.goto(`${url}/workspaces/project`);
    await page.locator("[data-biff-focused]").waitFor();
    await page.keyboard.press("/");
    await page.getByRole("textbox", { name: "Search current file", exact: true }).fill("Foo");

    // When selecting the first exact-case match
    await page.keyboard.press("Enter");

    // Then navigation skips the earlier lowercase spelling
    await browserExpect(page.locator("[data-biff-focused]")).toHaveText("consume(Foo);");
  });

  test("GraphQL hunk navigation uses blank-line chunks", async () => {
    // Given two added definitions in one native GraphQL hunk
    state.patch = createTwoFilesPatch("/dev/null", "api.graphql", "", 'type First {\n  id: ID!\n}\n\ntype Second {\n  name: String!\n}\n');
    await page.goto(`${url}/workspaces/project`);
    await page.locator("[data-biff-focused]").waitFor();

    // When navigating to the next review unit
    await page.keyboard.press("n");

    // Then navigation skips the separator and selects the next definition
    await browserExpect(page.locator("[data-biff-focused]")).toHaveText("type Second {");
  });

  test("plain-text chunks can be reviewed independently", async () => {
    // Given an extensionless text file containing two chunks
    state.patch = createTwoFilesPatch("/dev/null", "NOTICE", "", 'First section\ncontinued.\n\nSecond section.\n');
    await page.goto(`${url}/workspaces/project`);
    await page.locator("[data-biff-focused]").waitFor();

    // When completing the first chunk
    await page.keyboard.press("Space");

    // Then the second chunk is still independently unreviewed
    await browserExpect(page.getByRole("progressbar", { name: "Change review progress" })).toHaveAttribute("aria-valuetext", "1 of 2 changes reviewed");
  });

  test("approving the last hunk wraps to pending work in the same file before the next file", async () => {
    // Given the last hunk of the first file, with its earlier hunk still unreviewed
    state.patch = hunkProgressPatch();
    await page.goto(`${url}/workspaces/project`);
    await page.locator("[data-biff-focused]").waitFor();
    await page.keyboard.press("n");
    await page.locator('[data-biff-focused]').filter({ hasText: "function firstB()" }).waitFor();

    // When approving the last hunk
    await page.keyboard.press("Space");

    // Then the first pending hunk in this file takes priority over the next file
    await browserExpect(page.locator("[data-biff-focused]")).toHaveText("function firstA() {}");
  });

  test("approval wraps within the final file too", async () => {
    // Given the final hunk of the only file, with an earlier pending hunk
    state.patch = createTwoFilesPatch("/dev/null", "only.ts", "", 'function first() {}\nfunction last() {}\n');
    await page.goto(`${url}/workspaces/project`);
    await page.locator("[data-biff-focused]").waitFor();
    await page.keyboard.press("n");
    await page.locator('[data-biff-focused]').filter({ hasText: "function last()" }).waitFor();

    // When completing its final hunk
    await page.keyboard.press("Space");

    // Then earlier pending work is selected rather than staying at the file's end
    await browserExpect(page.locator("[data-biff-focused]")).toHaveText("function first() {}");
  });

  test("approval wraparound skips earlier reviewed hunks", async () => {
    // Given a reviewed first hunk and an unreviewed middle hunk
    state.patch = createTwoFilesPatch("/dev/null", "only.ts", "", 'function first() {}\nfunction middle() {}\nfunction last() {}\n');
    await page.goto(`${url}/workspaces/project`);
    await page.locator("[data-biff-focused]").waitFor();
    await page.keyboard.press("Space");
    await page.locator('[data-biff-focused]').filter({ hasText: "function middle()" }).waitFor();
    // And the reader has skipped to the last hunk
    await page.keyboard.press("n");
    await page.locator('[data-biff-focused]').filter({ hasText: "function last()" }).waitFor();

    // When completing that last hunk
    await page.keyboard.press("Space");

    // Then wrapping selects the first unreviewed hunk, not the already reviewed first one
    await browserExpect(page.locator("[data-biff-focused]")).toHaveText("function middle() {}");
  });

  test("approval advances to the next file once the current file has no pending hunks", async () => {
    // Given the first file's earlier hunk is already complete
    state.patch = hunkProgressPatch();
    await page.goto(`${url}/workspaces/project`);
    await page.locator("[data-biff-focused]").waitFor();
    await page.keyboard.press("Space");
    await page.locator('[data-biff-focused]').filter({ hasText: "function firstB()" }).waitFor();

    // When approving its final pending hunk
    await page.keyboard.press("Space");

    // Then navigation can advance to the next file
    await browserExpect(page.locator("[data-biff-focused]")).toHaveText("function secondA() {}");
  });

  test("manual next-hunk navigation remains directional rather than wrapping", async () => {
    // Given earlier pending work in the current file and its last hunk selected
    state.patch = hunkProgressPatch();
    await page.goto(`${url}/workspaces/project`);
    await page.locator("[data-biff-focused]").waitFor();
    await page.keyboard.press("n");
    await page.locator('[data-biff-focused]').filter({ hasText: "function firstB()" }).waitFor();

    // When navigating forward without approving the current hunk
    await page.keyboard.press("n");

    // Then explicit forward navigation still reaches the next file
    await browserExpect(page.locator("[data-biff-focused]")).toHaveText("function secondA() {}");
  });

  test("overall hunk totals exclude every auto-reviewed file pattern", async () => {
    // Given one business hunk and changes in all supported generated-file patterns
    state.patch = autoReviewedFilesPatch();

    // When loading a review with no saved approvals
    await page.goto(`${url}/workspaces/project`);

    // Then generated files inflate neither the reviewed numerator nor the total
    await browserExpect(page.getByRole("progressbar", { name: "Overall review progress" })).toHaveAttribute("aria-valuetext", "0 of 1 hunks reviewed");
  });

  test("manually reviewed business hunks still count toward overall completion", async () => {
    // Given one business hunk beside auto-reviewed generated files
    state.patch = autoReviewedFilesPatch();
    await page.goto(`${url}/workspaces/project`);
    await page.locator("[data-biff-focused]").waitFor();

    // When approving the business hunk
    await page.keyboard.press("Space");

    // Then its approval contributes to the same one-hunk total
    await browserExpect(page.getByRole("progressbar", { name: "Overall review progress" })).toHaveAttribute("aria-valuetext", "1 of 1 hunks reviewed");
  });

  test("file picker labels auto-reviewed files instead of counting their hunks", async () => {
    // Given ordinary and auto-reviewed files with real text changes
    state.patch = autoReviewedFilesPatch();
    await page.goto(`${url}/workspaces/project`);
    await page.locator("[data-biff-focused]").waitFor();

    // When opening the file picker
    await page.keyboard.press("Control+p");

    // Then only the business file has a hunk count
    await browserExpect(page.locator(".file-picker-hunks")).toHaveText(["0/1 hunk", "Auto-reviewed", "Auto-reviewed", "Auto-reviewed", "Auto-reviewed", "Auto-reviewed", "Auto-reviewed"]);
  });

  test("new metadata patterns are actually reviewed without a saved approval", async () => {
    // Given a changed metadata file and no saved marks
    state.patch = createTwoFilesPatch("/dev/null", "nested/metadata.ts", "", 'export const first = 1;\nexport const second = 2;\n');

    // When viewing the generated file directly
    await page.goto(`${url}/workspaces/project`);

    // Then the file-level review flag is already checked
    await browserExpect(page.getByRole("checkbox", { name: "File reviewed", exact: true })).toBeChecked();
  });

  test("auto-reviewed file controls explain why there is no per-file hunk total", async () => {
    // Given a changed generated file
    state.patch = createTwoFilesPatch("/dev/null", "nested/AuthorCodegen.ts", "", 'export const first = 1;\nexport const second = 2;\n');

    // When opening its review controls
    await page.goto(`${url}/workspaces/project`);

    // Then the file shows its automatic status rather than a misleading completed-hunk count
    await browserExpect(page.locator(".change-progress")).toHaveText("Auto-reviewed");
  });

  test("a review containing only auto-reviewed files has zero reviewable hunks", async () => {
    // Given a generated schema enum file with multiple chunks
    state.patch = createTwoFilesPatch("/dev/null", "schema/enums.graphql", "", 'enum First { ONE }\n\nenum Second { TWO }\n');

    // When loading its overall progress
    await page.goto(`${url}/workspaces/project`);

    // Then no generated chunks enter the total
    await browserExpect(page.getByRole("progressbar", { name: "Overall review progress" })).toHaveAttribute("aria-valuetext", "0 of 0 hunks reviewed");
  });

  test("single-commit file pickers also exclude auto-reviewed hunk counts", async () => {
    // Given a single-commit view without saved hunk progress
    state.patch = autoReviewedFilesPatch();
    await page.goto(`${url}/pr/example/project/12?commit=${previous}`);
    await page.locator("[data-biff-focused]").waitFor();

    // When opening its file picker
    await page.keyboard.press("Control+p");

    // Then raw diff counts do not reintroduce generated hunks
    await browserExpect(page.locator(".file-picker-hunks")).toHaveText(["1 hunk", "Auto-reviewed", "Auto-reviewed", "Auto-reviewed", "Auto-reviewed", "Auto-reviewed", "Auto-reviewed"]);
  });

  test("highlighting is prepared for unvisited files without rendering their DOM", async () => {
    // Given a review containing two files, with only the first open
    state.patch = hunkProgressPatch();
    await page.goto(`${url}/workspaces/project`);
    await page.locator("[data-biff-focused]").waitFor();

    // When background preparation reaches the unvisited second file
    await browserExpect.poll(async () => (await diffTimingSnapshot(page)).flatMap((review) => review.samples).filter((sample) => sample.file === "second.ts" && sample.phase === "highlight prewarm (inclusive)").map((sample) => sample.outcome)).toEqual(["ready"]);

    // Then it has not mounted a second interactive pane or performed DOM post-processing
    const samples = (await diffTimingSnapshot(page)).flatMap((review) => review.samples);
    expect(samples.filter((sample) => sample.file === "second.ts" && sample.phase === "DOM post-processing")).toEqual([]);
  });

  test("returning to a prepared file reuses its highlighted tokens", async () => {
    // Given a review whose two files have finished background preparation
    state.patch = hunkProgressPatch();
    await page.goto(`${url}/workspaces/project`);
    await page.locator("[data-biff-focused]").waitFor();
    await browserExpect.poll(async () => (await diffTimingSnapshot(page)).flatMap((review) => review.samples).some((sample) => sample.file === "second.ts" && sample.phase === "highlight prewarm (inclusive)" && sample.outcome === "ready")).toBe(true);
    const before = (await diffTimingSnapshot(page)).flatMap((review) => review.samples).filter((sample) => sample.file === "first.ts" && sample.phase === "highlight pipeline (inclusive)");

    // When switching to the other file and back
    await page.keyboard.press("l");
    await page.locator('[data-biff-focused]').filter({ hasText: "function secondA()" }).waitFor();
    await page.keyboard.press("h");
    await page.locator('[data-biff-focused]').filter({ hasText: "function firstA()" }).waitFor();

    // Then no comparison or syntax-highlighting passes have been added for the first file
    const after = (await diffTimingSnapshot(page)).flatMap((review) => review.samples).filter((sample) => sample.file === "first.ts" && sample.phase === "highlight pipeline (inclusive)");
    expect(after).toEqual(before);
  });

  test("large cached file switches expose DOM and layout work separately from highlighting", async () => {
    // Given a large diff with many separated hunks, prepared before navigation
    const oldSource = Array.from({ length: 1200 }, (_, index) => `export const item${index} = { amount: ${index}, description: "Item ${index}" };\n`).join("");
    const newSource = oldSource.split("\n").map((line, index) => index % 16 === 0 ? line.replace(`amount: ${index}`, `amount: ${index + 1}`) : line).join("\n");
    state.patch = createTwoFilesPatch("large.ts", "large.ts", oldSource, newSource) + createTwoFilesPatch("/dev/null", "neighbor.ts", "", 'export const neighbor = 1;\n');
    await page.goto(`${url}/workspaces/project`);
    await page.locator("[data-biff-focused]").waitFor();
    await browserExpect.poll(async () => (await diffTimingSnapshot(page)).flatMap((review) => review.samples).some((sample) => sample.file === "neighbor.ts" && sample.phase === "highlight prewarm (inclusive)")).toBe(true);
    const before = (await diffTimingSnapshot(page)).at(-1)!.samples.length;

    // When navigating away and returning to the cached large file
    await page.keyboard.press("l");
    await page.locator('[data-biff-focused]').filter({ hasText: "export const neighbor" }).waitFor();
    await page.keyboard.press("h");
    await page.locator('.file-stage[aria-busy="false"]').waitFor();
    await browserExpect.poll(async () => (await diffTimingSnapshot(page)).at(-1)!.samples.slice(before).some((sample) => sample.file === "large.ts" && sample.phase === "file switch to paint opportunity (inclusive)")).toBe(true);

    // Then all expensive switch stages are visible even without a new highlighting pass
    const phases = new Set((await diffTimingSnapshot(page)).at(-1)!.samples.slice(before).filter((sample) => sample.file === "large.ts").map((sample) => sample.phase));
    const required = ["DOM commit (inclusive)", "HTML serialization", "renderer manager setup", "renderer render (inclusive)", "review and follow-up markers", "moved-line markers", "deletion grouping", "deletion visibility", "comment markers", "search painting", "scroll and layout (inclusive)", "selected-row layout read", "file-start layout reads", "file ready latency (inclusive)", "file switch to paint opportunity (inclusive)"];
    expect([...phases].filter((phase) => required.includes(phase)).sort()).toEqual([...required].sort());
  });

  test("slide diagnostics distinguish transition preparation from incoming animation playback", async () => {
    // Given normal motion and two prepared files
    await page.emulateMedia({ reducedMotion: "no-preference" });
    state.patch = hunkProgressPatch();
    await page.goto(`${url}/workspaces/project`);
    await page.locator("[data-biff-focused]").waitFor();

    // When the next file slides into view
    await page.keyboard.press("l");
    await page.locator('[data-biff-focused]').filter({ hasText: "function secondA()" }).waitFor();
    await page.locator("[data-file-snapshot]").waitFor({ state: "detached" });

    // Then transition preparation belongs to the outgoing file and playback to the incoming file
    await browserExpect.poll(async () => (await diffTimingSnapshot(page)).flatMap((review) => review.samples).some((sample) => sample.phase === "file slide playback")).toBe(true);
    const samples = (await diffTimingSnapshot(page)).flatMap((review) => review.samples).filter((sample) => sample.phase === "file transition preparation" || sample.phase === "file slide playback");
    expect(samples).toMatchObject([{ file: "first.ts", phase: "file transition preparation", durationMs: expect.any(Number) }, { file: "second.ts", phase: "file slide playback", durationMs: expect.any(Number) }]);
  });
});

/** Read the same diagnostic buffer that Settings exports, without changing app state. */
async function diffTimingSnapshot(page: Page): Promise<ReviewTimings[]> {
  return page.evaluate(async () => {
    const path = "/src/diffMetrics.ts";
    const module: { diffMetrics: { snapshot(): ReviewTimings[] } } = await import(path);
    return module.diffMetrics.snapshot();
  });
}

/** Include real hunks for each generated-file rule beside one manually reviewable edit. */
function autoReviewedFilesPatch(): string {
  const generated = [
    ["schema.graphql", 'type First { id: ID! }\n\ntype Second { id: ID! }\n'],
    ["yarn.lock", 'first@1:\n  version "1"\n\nsecond@2:\n  version "2"\n'],
    ["nested/.history.json", '{ "events": [] }\n'],
    ["nested/metadata.ts", 'export const first = 1;\nexport const second = 2;\n'],
    ["nested/AuthorCodegen.ts", 'export const first = 1;\nexport const second = 2;\n'],
    ["schema/enums.graphql", 'enum First { ONE }\n\nenum Second { TWO }\n'],
  ];
  return createTwoFilesPatch("/dev/null", "package.json", "", '{ "version": "2.0.0" }\n')
    + generated.map((entry) => createTwoFilesPatch("/dev/null", entry[0], "", entry[1])).join("");
}

/** Put multiple semantic hunks inside each native Git hunk so picker counts match review stops. */
function hunkProgressPatch(): string {
  return createTwoFilesPatch("/dev/null", "first.ts", "", 'function firstA() {}\n\nfunction firstB() {}\n')
    + createTwoFilesPatch("/dev/null", "second.ts", "", 'function secondA() {}\n\nfunction secondB() {}\n\nfunction secondC() {}\n');
}

/** Distinguish new/deleted files from an existing file whose patch contains only additions. */
function fileStatusPatch(): string {
  return 'diff --git a/added.ts b/added.ts\nnew file mode 100644\n--- /dev/null\n+++ b/added.ts\n@@ -0,0 +1 @@\n+export const added = 1;\n'
    + 'diff --git a/deleted.ts b/deleted.ts\ndeleted file mode 100644\n--- a/deleted.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-export const deleted = 1;\n'
    + 'diff --git a/updated.ts b/updated.ts\n--- a/updated.ts\n+++ b/updated.ts\n@@ -1 +1,2 @@\n export const existing = 1;\n+export const added = 2;\n';
}

/** Open two changed files with complete source available for the file-local search tests. */
async function openFileSearchFixture(page: Page, state: FixtureState): Promise<void> {
  const source = 'const foo = 1;\nconsume(foo, foo);\n';
  const other = 'const foo = 2;\n';
  state.patch = createTwoFilesPatch("/dev/null", "file.ts", "", source) + createTwoFilesPatch("/dev/null", "other.ts", "", other);
  await page.route("**/contents", (route) => {
    const path = (route.request().postDataJSON() as { path: string }).path;
    return route.fulfill({ json: { oldFile: { name: path, contents: "" }, newFile: { name: path, contents: path === "file.ts" ? source : other } } });
  });
  await page.goto("http://127.0.0.1:5175/workspaces/project");
  await page.locator("[data-biff-focused]").waitFor();
}

/** Inspect the browser's real highlight ranges, including ranges across syntax spans. */
async function highlightedFileSearchText(page: Page): Promise<string[]> {
  return page.evaluate(() => Array.from(CSS.highlights.get("biff-file-search") ?? [], (range) => range.toString()));
}

/** Read the rail's reviewed styling for either the current file or a neighboring file. */
function viewedFile(page: Page, path: string) {
  return page.locator(".file-tile").filter({ has: page.getByTitle(path, { exact: true }) }).locator(".viewed-file");
}

/** Select the demo's added line before invoking the comment shortcut. */
async function composeComment(page: Page): Promise<void> {
  await page.locator('[data-content] > [data-line-index="3,2"]').click();
  await page.keyboard.press("c");
}

/** Locate the line's count regardless of whether its messages have been read. */
function commentBadge(page: Page) { return page.getByRole("button", { name: /^\d+ (unread )?comments? on line 3$/ }); }

/** Supply explicit per-message publication state for browser label/action coverage. */
async function localDiscussionFixture(page: Page): Promise<void> {
  const discussion: Discussion = {
    identity: { id: "local-fixture", pr: "example/project/12", closed: false }, version: 0,
    threads: [{ id: "local-thread", resolved: false, humanSequence: 1, anchor: { path: "src/reviews.ts", side: "RIGHT", line: 3, endLine: 3, commitId: head, baseCommitId: previous, excerpt: "review code" }, messages: [{ id: "local-message", author: "user", body: "A private review note.", createdAt: "2026-10-17T00:00:00Z", sequence: 1 }] }],
  };
  await page.route("**/api/**/discussion**", async (route) => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON() as { action: string; body?: string };
      const thread = discussion.threads[0];
      if (body.action === "publish") thread.messages[0].published = { pr: "example/project/12", id: 99, url: "https://github.com/example/project/pull/12#discussion_r99", publishedAt: "2026-10-17T00:00:00Z" };
      if (body.action === "reply") thread.messages.push({ id: "local-reply", author: "user", body: body.body!, createdAt: "2026-10-17T00:00:01Z", sequence: 2 });
      discussion.version++;
    }
    const events = new URL(route.request().url()).searchParams.has("events");
    await route.fulfill({ contentType: events ? "text/event-stream" : "application/json", body: events ? `data: ${JSON.stringify(discussion)}\n\n` : JSON.stringify(discussion) });
  });
}

/** Build a published comment at a real coordinate in the demo patch. */
function inlineComment(id: number, body: string): DiscussionComment {
  return { id, body, user: { login: "reviewer" }, html_url: `https://github.com/example/project/pull/12#discussion_r${id}`, path: "src/reviews.ts", line: 3, side: "RIGHT" };
}

/** Serve deterministic API responses; browser tests never post to a real PR. */
async function fixtureResponse(route: Route, state: FixtureState) {
  const url = new URL(route.request().url());
  const workspace = { id: "project", name: "project", path: "/repositories/project" };
  const revision = { commit_id: head, change_id: "qwertyui", description: "Update project", author: { name: "Reviewer", email: "reviewer@example.com", timestamp: "2026-10-15T00:00:00Z" } };
  let body: unknown;
  let status = 200;
  if (url.pathname === "/api/workspaces") body = [workspace];
  else if (url.pathname === "/api/inbox") body = { updatedAt: Date.now(), refreshing: false, truncated: false, items: [{ id: "example/project/12", number: 12, title: "Improve the viewer", url: "https://github.com/example/project/pull/12", repository: { nameWithOwner: "example/project" }, author: { login: "reviewer" }, isDraft: false, updatedAt: "2026-10-15T00:00:00Z", personal: { archived: false, restoredUntil: 0, pinned: false, snoozeUntil: 0 }, unread: false, needsReview: true, followUpCount: 0, activity: state.approvalActivity }] };
  else if (url.pathname.endsWith("/inbox")) body = {};
  else if (url.pathname.endsWith("/track")) body = { ok: true };
  else if (url.pathname.endsWith("/comment-reads")) body = [];
  else if (url.pathname === "/api/workspaces/project/review") body = { workspace, revisions: [revision], selected: revision, patch: state.empty ? "" : state.patch };
  else if (url.pathname.endsWith("/progress")) {
    if (route.request().method() === "POST") {
      const update = route.request().postDataJSON();
      state.progress = state.progress.filter((entry) => !matchesChange(entry, update));
      if (update.reviewed) state.progress.push({ ...update, reviewedAt: new Date().toISOString() });
    }
    body = state.progress;
  }
  else if (url.pathname.endsWith("/conversation")) body = { viewer: "reviewer", comments: [], inline: state.inline, reviews: [] };
  else if (url.pathname.endsWith("/discussion")) {
    body = { identity: { id: "fixture", closed: false }, version: 0, threads: [] };
    if (url.searchParams.has("events")) {
      await route.fulfill({ contentType: "text/event-stream", body: `data: ${JSON.stringify(body)}\n\n` });
      return;
    }
  }
  else if (url.pathname.endsWith("/stack")) body = null;
  else if (url.pathname.endsWith("/mentions")) {
    const query = (url.searchParams.get("q") || "").toLowerCase();
    body = [{ login: "alice", name: "Alice Reviewer" }, { login: "albert", name: "Albert Reviewer" }].filter((user) => `${user.login} ${user.name}`.toLowerCase().includes(query));
  }
  else if (url.pathname.endsWith("/inline-comment") && route.request().method() === "POST") {
    if (state.rejectInline) { status = 400; body = { error: "GitHub rejected this line comment" }; }
    else { state.lineWrites.push(route.request().postDataJSON()); body = { id: 99 }; }
  }
  else if (url.pathname.endsWith("/thread") && route.request().method() === "POST") {
    const update = route.request().postDataJSON() as { id: string; resolved: boolean };
    for (const comment of state.inline) if (comment.reviewThread?.id === update.id) comment.reviewThread.resolved = update.resolved;
    body = { saved: true };
  }
  else if (url.pathname.endsWith("/comment-edit") && route.request().method() === "POST") {
    const update = route.request().postDataJSON() as { id: number; action: string; body?: string };
    if (state.rejectInline) { status = 400; body = { error: "GitHub rejected this comment change" }; }
    else {
      if (update.action === "delete") state.inline = state.inline.filter((entry) => entry.id !== update.id);
      else state.inline.find((entry) => entry.id === update.id)!.body = update.body!;
      body = { saved: true };
    }
  }
  else if (url.pathname.endsWith("/comment") && route.request().method() === "POST") {
    state.replies.push(route.request().postDataJSON()); body = { id: 100 };
  }
  else if (url.pathname.endsWith("/viewed") && route.request().method() === "POST") {
    const update = route.request().postDataJSON() as { path: string; viewed: boolean };
    if (state.rejectViewed) { status = 400; body = { error: "GitHub rejected this Viewed update" }; }
    else {
      state.viewedFiles[update.path] = update.viewed ? "VIEWED" : "UNVIEWED";
      body = { state: state.viewedFiles[update.path] };
    }
  }
  else if (url.pathname.endsWith("/viewed")) body = { files: state.viewedFiles };
  else if (url.pathname.endsWith("/review") && route.request().method() === "POST") {
    if (state.rejectReview) { status = 400; body = { error: "GitHub rejected this review" }; }
    else { state.writes.push(route.request().postDataJSON()); body = { id: 42 }; }
  } else if (url.pathname.endsWith("/review")) body = {
    pr: { number: 12, title: "Improve the viewer", body: "A useful change.", html_url: "https://github.com/example/project/pull/12", state: "open", draft: false, user: { login: "reviewer" }, head: { sha: state.prHead ?? head, ref: "feature" }, base: { sha: previous, ref: "main" } },
    commits: [{ sha: previous, commit: { message: "First commit", author: { name: "Reviewer", date: "2026-10-15" } } }, { sha: head, commit: { message: "Second commit", author: { name: "Reviewer", date: "2026-10-15" } } }],
    patch: state.patch, commit: url.searchParams.get("commit") || "all",
  };
  else { status = 404; body = { error: "Unknown fixture route" }; }
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}
