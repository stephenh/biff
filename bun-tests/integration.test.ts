import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { chromium, expect as browserExpect, type Browser, type BrowserContext, type Page, type Route } from "@playwright/test";
import type { DiscussionComment, DraftComment, FileViewedState, ReviewSubmission } from "../shared/types";
import { matchesChange, type ReviewedChange } from "../shared/progress";

const head = "a".repeat(40);
const previous = "b".repeat(40);
interface FixtureState { progress: ReviewedChange[]; patch: string; writes: ReviewSubmission[]; rejectReview: boolean; empty: boolean; viewedFiles: Record<string, FileViewedState>; rejectViewed: boolean; inline: DiscussionComment[]; lineWrites: { commitId: string; comment: DraftComment }[]; replies: { body: string; replyTo?: number }[]; rejectInline: boolean }

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
    state = { progress: [], patch: await Bun.file(new URL("../fixtures/demo.diff", import.meta.url)).text(), writes: [], rejectReview: false, empty: false, viewedFiles: { "src/reviews.ts": "UNVIEWED" }, rejectViewed: false, inline: [], lineWrites: [], replies: [], rejectInline: false };
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
    await browserExpect(page).toHaveTitle("project / @- · qwertyui — Biff");
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
    await browserExpect(page).toHaveTitle("example/project / feature · bbbbbbbb — Biff");
    await browserExpect(page.locator("[data-biff-focused]")).toBeVisible();
  });

  test("a review submits the selected new-file line and summary", async () => {
    // Given the first added line in a PR's full diff
    await page.goto(`${url}/pr/example/project/12`);
    await page.locator("[data-biff-focused]").waitFor();

    // When the reader adds an inline comment and submits a review
    await page.getByRole("button", { name: "Add comment on line 3 (new)", exact: true }).click();
    await page.getByLabel("Inline comment", { exact: true }).fill("Please explain this constant.");
    await page.getByRole("button", { name: "Save as Review Comment", exact: true }).click();
    await page.getByRole("button", { name: "Discussion & review", exact: true }).click();
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

  test("marking a file Viewed persists across a PR refresh", async () => {
    // Given an unviewed file in the full PR diff
    await page.goto(`${url}/pr/example/project/12`);

    // When the reader marks it viewed and refreshes the PR
    await page.getByRole("checkbox", { name: "Viewed", exact: true }).click();
    await page.getByRole("option", { name: "src/reviews.ts ✓", exact: true, includeHidden: true }).waitFor({ state: "attached" });
    await page.getByRole("button", { name: "Refresh", exact: true }).click();

    // Then the saved GitHub mark is loaded again
    await browserExpect(page.getByRole("checkbox", { name: "Viewed", exact: true })).toBeChecked();
  });

  test("a saved Viewed mark can be cleared", async () => {
    // Given a file already marked viewed on GitHub
    state.viewedFiles["src/reviews.ts"] = "VIEWED";
    await page.goto(`${url}/pr/example/project/12`);
    await browserExpect(page.getByRole("checkbox", { name: "Viewed", exact: true })).toBeChecked();

    // When the reader clears its mark
    await page.getByRole("checkbox", { name: "Viewed", exact: true }).click();
    await page.getByRole("option", { name: "src/reviews.ts", exact: true, includeHidden: true }).waitFor({ state: "attached" });

    // Then the GitHub state is unviewed
    expect<FileViewedState>(state.viewedFiles["src/reviews.ts"]).toBe("UNVIEWED");
  });

  test("a failed Viewed update leaves the saved mark intact", async () => {
    // Given a viewed file whose next update will fail
    state.viewedFiles["src/reviews.ts"] = "VIEWED";
    // And GitHub rejects viewed updates
    state.rejectViewed = true;
    await page.goto(`${url}/pr/example/project/12`);
    await page.getByRole("checkbox", { name: "Viewed", exact: true }).waitFor();
    await browserExpect(page.getByRole("checkbox", { name: "Viewed", exact: true })).toBeEnabled();

    // When the reader tries to clear its mark
    await page.getByRole("checkbox", { name: "Viewed", exact: true }).click();
    await page.getByRole("alert").waitFor();

    // Then the checkbox still reflects the saved state
    await browserExpect(page.getByRole("checkbox", { name: "Viewed", exact: true })).toBeChecked();
  });

  test("opening an inline thread does not reflow the code", async () => {
    // Given a published thread with a reply on the first added line
    state.inline = [inlineComment(42, "Please explain this constant before merging."), { ...inlineComment(43, "Here is the explanation."), in_reply_to_id: 42 }];
    await page.goto(`${url}/pr/example/project/12`);
    const line = page.locator("[data-biff-focused]");
    await line.waitFor();
    const before = await line.boundingBox();

    // When the short author preview is opened
    await page.getByRole("button", { name: "Open comment thread on line 3: reviewer", exact: true }).click();
    await page.getByRole("dialog", { name: "Comment thread", exact: true }).waitFor();
    await page.getByText("Here is the explanation.", { exact: true }).waitFor();

    // Then the code line retains exactly the same position and size
    expect(await line.boundingBox()).toEqual(before);
  });

  test("Save as Comment publishes a new line thread immediately", async () => {
    // Given the full PR diff
    await page.goto(`${url}/pr/example/project/12`);

    // When a new thread is saved as a comment
    await page.getByRole("button", { name: "Add comment on line 3 (new)", exact: true }).click();
    await page.getByLabel("Inline comment", { exact: true }).fill("Publish this now.");
    await page.getByRole("button", { name: "Save as Comment", exact: true }).click();
    await page.getByRole("dialog").waitFor({ state: "detached" });

    // Then the API receives the current head and exact line coordinate
    expect(state.lineWrites).toEqual([{ commitId: head, comment: { path: "src/reviews.ts", line: 3, side: "RIGHT", body: "Publish this now." } }]);
  });

  test("an inline thread reply is posted to its root comment", async () => {
    // Given an existing inline thread
    state.inline = [inlineComment(42, "Please explain this constant.")];
    await page.goto(`${url}/pr/example/project/12`);

    // When the reader replies in the floating overlay
    await page.getByRole("button", { name: "Open comment thread on line 3: reviewer", exact: true }).click();
    await page.getByLabel("Thread reply", { exact: true }).fill("Here is why.");
    await page.getByRole("button", { name: "Save as Comment", exact: true }).click();
    await page.getByRole("dialog").waitFor({ state: "detached" });

    // Then the reply targets the existing root rather than creating a new thread
    expect(state.replies).toEqual([{ body: "Here is why.", replyTo: 42 }]);
  });

  test("a rejected inline comment keeps its text in the overlay", async () => {
    // Given GitHub rejects the next line comment
    state.rejectInline = true;
    await page.goto(`${url}/pr/example/project/12`);

    // When immediate publication fails
    await page.getByRole("button", { name: "Add comment on line 3 (new)", exact: true }).click();
    await page.getByLabel("Inline comment", { exact: true }).fill("Keep my explanation.");
    await page.getByRole("button", { name: "Save as Comment", exact: true }).click();
    await page.getByText("GitHub rejected this line comment", { exact: true }).waitFor();

    // Then the reader can correct or retry the same text
    await browserExpect(page.getByLabel("Inline comment", { exact: true })).toHaveValue("Keep my explanation.");
  });

  test("saved review comments survive reload without publishing", async () => {
    // Given a new comment in the line overlay
    await page.goto(`${url}/pr/example/project/12`);
    await page.getByRole("button", { name: "Add comment on line 3 (new)", exact: true }).click();
    await page.getByLabel("Inline comment", { exact: true }).fill("Save for the review.");

    // When the reader saves it as a review comment and reloads
    await page.getByRole("button", { name: "Save as Review Comment", exact: true }).click();
    await page.reload();
    await page.getByRole("button", { name: "Open comment thread on line 3: You (draft)", exact: true }).click();

    // Then the local review comment is available for editing
    await browserExpect(page.getByLabel("Inline comment", { exact: true })).toHaveValue("Save for the review.");
  });

  test("Escape closes the overlay without losing unsaved text", async () => {
    // Given an unsaved line comment
    await page.goto(`${url}/pr/example/project/12`);
    await page.getByRole("button", { name: "Add comment on line 3 (new)", exact: true }).click();
    await page.getByLabel("Inline comment", { exact: true }).fill("Still composing.");

    // When the reader dismisses and reopens the composer
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Add comment on line 3 (new)", exact: true }).click();

    // Then the unsaved text is retained
    await browserExpect(page.getByLabel("Inline comment", { exact: true })).toHaveValue("Still composing.");
  });

  test("multiple threads on one line can each receive a reply", async () => {
    // Given two separate root comments at the same coordinate
    state.inline = [inlineComment(42, "First thread."), inlineComment(44, "Second thread.")];
    await page.goto(`${url}/pr/example/project/12`);

    // When the second thread is selected in the overlay and answered
    await page.getByRole("button", { name: "Open comment thread on line 3: reviewer", exact: true }).click();
    await page.getByRole("button", { name: "reviewer · Second thread.", exact: true }).click();
    await page.getByLabel("Thread reply", { exact: true }).fill("Answer for the second thread.");
    await page.getByRole("button", { name: "Save as Comment", exact: true }).click();
    await page.getByRole("dialog").waitFor({ state: "detached" });

    // Then the reply targets the selected root comment
    expect(state.replies).toEqual([{ body: "Answer for the second thread.", replyTo: 44 }]);
  });

  test("edited review comments reopen with their saved text", async () => {
    // Given a saved inline review comment
    await page.goto(`${url}/pr/example/project/12`);
    await page.getByRole("button", { name: "Add comment on line 3 (new)", exact: true }).click();
    await page.getByLabel("Inline comment", { exact: true }).fill("Initial draft.");
    await page.getByRole("button", { name: "Save as Review Comment", exact: true }).click();

    // When the draft is edited, saved, and opened again
    await page.getByRole("button", { name: "Open comment thread on line 3: You (draft)", exact: true }).click();
    await page.getByLabel("Inline comment", { exact: true }).fill("Revised draft.");
    await page.getByRole("button", { name: "Save as Review Comment", exact: true }).click();
    await page.getByRole("button", { name: "Open comment thread on line 3: You (draft)", exact: true }).click();

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
    expect(state.lineWrites).toEqual([{ commitId: head, comment: { path: "src/reviews.ts", line: 4, side: "RIGHT", body: "On the next line." } }]);
  });

  test("c opens an existing thread on the focused line", async () => {
    // Given a published comment on the initial focused line
    state.inline = [inlineComment(42, "Please explain this constant.")];
    await page.goto(`${url}/pr/example/project/12`);
    await page.getByRole("button", { name: "Open comment thread on line 3: reviewer", exact: true }).waitFor();

    // When the reader presses c
    await page.keyboard.press("c");

    // Then the existing thread opens with its reply composer ready for typing
    await browserExpect(page.getByLabel("Thread reply", { exact: true })).toBeFocused();
  });

  test("Shift+N saves the current file as viewed and advances", async () => {
    // Given an unviewed PR file
    await page.goto(`${url}/pr/example/project/12`);
    await browserExpect(page.getByRole("checkbox", { name: "Viewed", exact: true })).toBeEnabled();

    // When the reader marks it done with Shift+N
    await page.keyboard.press("Shift+N");

    // Then GitHub has the mark and the next file is selected
    await browserExpect(page.getByLabel("Current file")).toHaveValue("1");
    await page.getByRole("option", { name: "src/reviews.ts ✓", exact: true, includeHidden: true }).waitFor({ state: "attached" });
    expect<FileViewedState>(state.viewedFiles["src/reviews.ts"]).toBe("VIEWED");
  });

  test("Shift+N advances even when the background save fails", async () => {
    // Given GitHub will reject the viewed update
    state.rejectViewed = true;
    await page.goto(`${url}/pr/example/project/12`);
    await browserExpect(page.getByRole("checkbox", { name: "Viewed", exact: true })).toBeEnabled();

    // When the reader presses Shift+N
    await page.keyboard.press("Shift+N");

    // Then the failed file is identified while navigation stays on the next file
    await browserExpect(page.getByRole("alert")).toHaveText("src/reviews.ts: GitHub rejected this Viewed updateRetry");
    await browserExpect(page.getByLabel("Current file")).toHaveValue("1");
  });

  test("Shift+N advances past an already-viewed file without clearing its mark", async () => {
    // Given a file already viewed, with further writes unavailable
    state.viewedFiles["src/reviews.ts"] = "VIEWED";
    // And GitHub would reject a redundant write
    state.rejectViewed = true;
    await page.goto(`${url}/pr/example/project/12`);
    await browserExpect(page.getByRole("checkbox", { name: "Viewed", exact: true })).toBeChecked();

    // When the reader presses Shift+N
    await page.keyboard.press("Shift+N");

    // Then navigation advances and the saved mark remains viewed
    await browserExpect(page.getByLabel("Current file")).toHaveValue("1");
    expect<FileViewedState>(state.viewedFiles["src/reviews.ts"]).toBe("VIEWED");
  });

  test("Shift+N marks the final file without wrapping to the beginning", async () => {
    // Given the final PR file is selected and unviewed
    state.viewedFiles["settings.json"] = "UNVIEWED";
    await page.goto(`${url}/pr/example/project/12`);
    await browserExpect(page.getByRole("checkbox", { name: "Viewed", exact: true })).toBeEnabled();
    await page.keyboard.press("n");
    await page.keyboard.press("n");

    // When the reader finishes the last file
    await page.keyboard.press("Shift+N");

    // Then that file stays selected with its viewed mark saved
    await browserExpect(page.getByRole("checkbox", { name: "Viewed", exact: true })).toBeChecked();
    await browserExpect(page.getByLabel("Current file")).toHaveValue("2");
    expect<FileViewedState>(state.viewedFiles["settings.json"]).toBe("VIEWED");
  });

  test("browser reload restores the selected PR file", async () => {
    // Given the reader navigated to the last file
    await page.goto(`${url}/pr/example/project/12`);
    await page.getByLabel("Current file").selectOption("2");

    // When the tab reloads
    await page.reload();

    // Then it returns to that file
    await browserExpect(page.getByLabel("Current file")).toHaveValue("2");
  });

  test("Refresh restores a working-copy file by path after reordering", async () => {
    // Given the reader selected settings.json
    await page.goto(`${url}/workspaces/project`);
    await page.getByLabel("Current file").selectOption("2");
    // And the refreshed patch moves that file to the front
    const patches = state.patch.split(/(?=^diff --git )/m);
    state.patch = [patches[2], patches[0], patches[1]].join("");

    // When the review is refreshed
    await page.getByRole("button", { name: "Refresh", exact: true }).click();

    // Then selection follows the file rather than its previous index
    await browserExpect(page.getByLabel("Current file").locator("option:checked")).toHaveText("settings.json");
    await browserExpect(page.getByLabel("Current file")).toHaveValue("0");
  });

  test("inline mention suggestions support keyboard selection and continued typing", async () => {
    // Given a new inline comment on a PR
    await page.goto(`${url}/pr/example/project/12`);
    await page.getByRole("button", { name: "Add comment on line 3 (new)", exact: true }).click();

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
    expect(state.lineWrites).toEqual([{ commitId: head, comment: { path: "src/reviews.ts", line: 3, side: "RIGHT", body: "Please ask @albert to check." } }]);
  });

  test("discussion comments accept mention suggestions by mouse", async () => {
    // Given the PR discussion composer
    await page.goto(`${url}/pr/example/project/12`);
    await page.getByRole("button", { name: "Discussion & review", exact: true }).click();

    // When a suggested repository user is clicked and the comment is posted
    await page.getByLabel("Discussion comment", { exact: true }).fill("Thanks @ali");
    await page.getByRole("option", { name: "@alice Alice Reviewer", exact: true }).click();
    await page.getByRole("button", { name: "Post comment", exact: true }).click();
    await page.getByText("Comment posted to GitHub.", { exact: true }).waitFor();

    // Then the general comment contains the literal GitHub mention
    expect(state.replies).toEqual([{ body: "Thanks @alice " }]);
  });

  test("thread replies support repository-user mentions", async () => {
    // Given an existing inline thread
    state.inline = [inlineComment(42, "Who can check this?")];
    await page.goto(`${url}/pr/example/project/12`);
    await page.getByRole("button", { name: "Open comment thread on line 3: reviewer", exact: true }).click();

    // When a reply mentions a repository user
    await page.getByLabel("Thread reply", { exact: true }).fill("Ask @ali");
    await page.getByRole("option", { name: "@alice Alice Reviewer", exact: true }).click();
    await page.getByRole("button", { name: "Save as Comment", exact: true }).click();
    await page.getByRole("dialog").waitFor({ state: "detached" });

    // Then the mention is sent as part of the existing thread reply
    expect(state.replies).toEqual([{ body: "Ask @alice ", replyTo: 42 }]);
  });

  test("Escape dismisses mention suggestions without closing the comment overlay", async () => {
    // Given an inline composer showing repository-user suggestions
    await page.goto(`${url}/pr/example/project/12`);
    await page.getByRole("button", { name: "Add comment on line 3 (new)", exact: true }).click();
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
    await page.getByRole("button", { name: "Add comment on line 3 (new)", exact: true }).click();

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
    await browserExpect(page.locator(".pr-title .muted")).toHaveText("example/project #12 2 / 3");
  });

  test("switching stacked PRs opens the selected PR's complete diff", async () => {
    // Given an individual commit selected within a stacked PR
    await page.route("**/stack", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ position: 2, total: 2, pulls: [{ number: 11, title: "Base change" }, { number: 12, title: "Improve the viewer" }] }) }));
    await page.goto(`${url}/pr/example/project/12?commit=${previous}`);
    // When another PR is chosen from the stack
    await page.getByRole("button", { name: "Stack position 2 of 2", exact: true }).click();
    await page.getByLabel("Stack PR", { exact: true }).selectOption("11");
    // Then navigation drops the previous PR's commit selection
    await browserExpect(page).toHaveURL(`${url}/pr/example/project/11`);
  });

  test("Shift+N advances through multiple files while their saves are pending", async () => {
    // Given saves are held until the reader has moved through the review
    const held = Promise.withResolvers<void>();
    await page.route("**/viewed", async (route) => {
      if (route.request().method() === "POST") await held.promise;
      await fixtureResponse(route, state);
    });
    await page.goto(`${url}/pr/example/project/12`);
    await browserExpect(page.getByRole("checkbox", { name: "Viewed", exact: true })).toBeEnabled();

    try {
      // When two files are marked before GitHub finishes either save
      await page.keyboard.press("Shift+N");
      await browserExpect(page.getByLabel("Current file")).toHaveValue("1");
      await page.keyboard.press("Shift+N");

      // Then the last file is selected without waiting for either network response
      await browserExpect(page.getByLabel("Current file")).toHaveValue("2");
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
    await browserExpect(page.getByRole("checkbox", { name: "Viewed", exact: true })).toBeEnabled();

    try {
      // When the reader moves ahead twice and both saves then finish
      await page.keyboard.press("Shift+N");
      await browserExpect(page.getByLabel("Current file")).toHaveValue("1");
      await page.keyboard.press("Shift+N");
      held.resolve();
      await page.getByRole("option", { name: "schema/review.graphql ✓", exact: true, includeHidden: true }).waitFor({ state: "attached" });
      await page.getByRole("option", { name: "src/reviews.ts ✓", exact: true, includeHidden: true }).waitFor({ state: "attached" });

      // Then both previous files have their own saved GitHub marks
      expect(state.viewedFiles).toEqual({ "src/reviews.ts": "VIEWED", "schema/review.graphql": "VIEWED" });
    } finally { held.resolve(); }
  });

  test("a failed background Viewed save can be retried from the next file", async () => {
    // Given GitHub rejects the previous file's Viewed mark
    state.rejectViewed = true;
    await page.goto(`${url}/pr/example/project/12`);
    await browserExpect(page.getByRole("checkbox", { name: "Viewed", exact: true })).toBeEnabled();
    await page.keyboard.press("Shift+N");
    await page.getByRole("alert").waitFor();
    // And GitHub becomes available again
    state.rejectViewed = false;

    // When the failed mark is retried without going back
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await page.getByRole("option", { name: "src/reviews.ts ✓", exact: true, includeHidden: true }).waitFor({ state: "attached" });

    // Then the original file's mark is saved
    expect<FileViewedState>(state.viewedFiles["src/reviews.ts"]).toBe("VIEWED");
  });

  test("jumping to a comment inside folded imports expands its stanza", async () => {
    // Given a published thread on an import replacement
    state.patch = 'diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n@@ -1,3 +1,3 @@\n-import Old from "old";\n+import New from "new";\n \n const body = true;\n';
    state.inline = [{ ...inlineComment(42, "Please check this import."), path: "file.ts", line: 1 }];
    await page.goto(`${url}/pr/example/project/12`);
    await page.getByRole("button", { name: "2 Import changes · 1 thread", exact: true }).waitFor();

    // When the reader jumps to that comment's line from discussion
    await page.getByRole("button", { name: "Discussion & review", exact: true }).click();
    await page.getByRole("button", { name: "View line", exact: true }).click();

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

  test("K skips reviewed edits", async () => {
    // Given a completed first edit and the next edit selected
    await page.goto(`${url}/pr/example/project/12`);
    await page.locator("[data-biff-focused]").waitFor();
    await page.keyboard.press("Space");
    await browserExpect(page.locator("[data-biff-focused]")).toHaveAttribute("data-line", "8");
    // When change navigation goes backwards
    await page.keyboard.press("Shift+K");
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
});

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
  else if (url.pathname === "/api/workspaces/project/review") body = { workspace, revisions: [revision], selected: revision, patch: state.empty ? "" : state.patch };
  else if (url.pathname === "/api/github/prs") body = [{ number: 12, title: "Improve the viewer", url: "https://github.com/example/project/pull/12", repository: { nameWithOwner: "example/project" }, author: { login: "reviewer" }, isDraft: false, updatedAt: "2026-10-15T00:00:00Z" }];
  else if (url.pathname.endsWith("/progress")) {
    if (route.request().method() === "POST") {
      const update = route.request().postDataJSON();
      state.progress = state.progress.filter((entry) => !matchesChange(entry, update));
      if (update.reviewed) state.progress.push({ ...update, reviewedAt: new Date().toISOString() });
    }
    body = state.progress;
  }
  else if (url.pathname.endsWith("/conversation")) body = { comments: [], inline: state.inline, reviews: [] };
  else if (url.pathname.endsWith("/stack")) body = null;
  else if (url.pathname.endsWith("/mentions")) {
    const query = (url.searchParams.get("q") || "").toLowerCase();
    body = [{ login: "alice", name: "Alice Reviewer" }, { login: "albert", name: "Albert Reviewer" }].filter((user) => `${user.login} ${user.name}`.toLowerCase().includes(query));
  }
  else if (url.pathname.endsWith("/inline-comment") && route.request().method() === "POST") {
    if (state.rejectInline) { status = 400; body = { error: "GitHub rejected this line comment" }; }
    else { state.lineWrites.push(route.request().postDataJSON()); body = { id: 99 }; }
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
    pr: { number: 12, title: "Improve the viewer", body: "A useful change.", html_url: "https://github.com/example/project/pull/12", state: "open", draft: false, user: { login: "reviewer" }, head: { sha: head, ref: "feature" }, base: { sha: previous, ref: "main" } },
    commits: [{ sha: previous, commit: { message: "First commit", author: { name: "Reviewer", date: "2026-10-15" } } }, { sha: head, commit: { message: "Second commit", author: { name: "Reviewer", date: "2026-10-15" } } }],
    patch: state.patch, commit: url.searchParams.get("commit") || "all",
  };
  else { status = 404; body = { error: "Unknown fixture route" }; }
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}
