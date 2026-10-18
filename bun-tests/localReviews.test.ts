import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, expect as browserExpect, type Browser } from "@playwright/test";
import { createApi } from "../server/api";
import { GitHub } from "../server/github";
import { Reviews } from "../server/reviews";
import { Progress } from "../server/progress";
import { Workspaces } from "../server/workspaces";
import { runCommand } from "../server/commands";
import type { ReviewSession } from "../shared/localReview";
import { forwardReview, type FeedbackPrompt } from "../integrations/feedback";

describe("localReviews", () => {
  let directory: string;
  let repo: string;
  let reviews: Reviews;
  let workspaces: Workspaces;
  let server: ReturnType<typeof Bun.serve>;
  let uiServer: ReturnType<typeof Bun.spawn>;
  const uiOrigin = "http://127.0.0.1:5176";
  let browser: Browser;
  let review: ReviewSession;

  beforeAll(async () => {
    directory = await mkdtemp("/tmp/opencode/biff-reviews-");
    repo = join(directory, "workspace");
    await mkdir(repo);
    await runCommand(["jj", "git", "init"], { cwd: repo });
    await writeFile(join(repo, "example.ts"), "export const value = 1;\n");
    await runCommand(["jj", "new"], { cwd: repo });
    reviews = new Reviews(join(directory, "reviews"));
    workspaces = new Workspaces(join(directory, "workspaces.json"));
    const api = createApi({ reviews, workspaces, github: new GitHub(), progress: new Progress(join(directory, "progress")) });
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 60, fetch: api });
    // Serve source through Vite so fresh checkouts do not need a pre-existing dist/.
    uiServer = Bun.spawn(["bun", "node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "5176", "--strictPort"], { cwd: new URL("..", import.meta.url).pathname, env: { ...process.env, BIFF_PORT: String(server.port) }, stdout: "ignore", stderr: "inherit" });
    for (let attempt = 0; attempt < 100; attempt++) {
      if (uiServer.exitCode !== null) throw new Error("Review test UI exited");
      try { if ((await fetch(uiOrigin)).ok) break; } catch { /* Vite is starting. */ }
      await Bun.sleep(50);
    }
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium" });
  });
  beforeEach(async () => {
    await writeFile(join(repo, "example.ts"), "export const value = 2;\n");
    await rm(join(repo, "other.ts"), { force: true });
    // Agent sessions now share durable threads within a lifetime; each test starts independent work.
    const workspace = await workspaces.add(repo);
    const reset = await fetch(`${server.url}api/workspaces/${workspace.id}/review`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ bookmark: "" }) });
    if (!reset.ok) throw new Error(await reset.text());
    review = await api("", { path: repo, agentSession: crypto.randomUUID() });
  });
  afterAll(async () => { await browser?.close(); uiServer?.kill(); await uiServer?.exited; await server?.stop(true); await rm(directory, { recursive: true, force: true }); });

  /** Exercise the public JSON protocol rather than store implementation details. */
  async function api(path: string, body?: unknown): Promise<ReviewSession> {
    const response = await fetch(`${server.url}api/reviews${path}`, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    return result;
  }

  /** Post an anchored comment through real JJ content lookup. */
  async function comment(body = "Please explain this value") {
    return api(`/${review.id}/threads`, { path: "example.ts", side: "RIGHT", line: 1, commitId: review.snapshot.selected.commit_id, baseCommitId: review.snapshot.base?.commit_id, body });
  }

  test("posted comments survive daemon restart with their original code excerpt", async () => {
    // Given a posted comment
    await comment();
    // When the store is reopened
    const restored = await new Reviews(join(directory, "reviews")).get(review.id);
    // Then the original immutable anchor and message remain available
    expect(restored.threads[0]).toMatchObject({ anchor: { path: "example.ts", side: "RIGHT", line: 1, commitId: review.snapshot.selected.commit_id, excerpt: "export const value = 2;\n" }, messages: [{ author: "user", body: "Please explain this value" }] });
  });

  test("concurrent replies do not overwrite one another", async () => {
    // Given a posted thread
    const posted = await comment();
    // When two clients reply concurrently
    await Promise.all(["One", "Two"].map((body) => api(`/${review.id}/reply`, { threadId: posted.threads[0].id, body, author: "agent" })));
    // Then both messages are persisted
    expect((await api(`/${review.id}`)).threads[0].messages.map((message) => message.body).sort()).toEqual(["One", "Please explain this value", "Two"]);
  });

  test("waiting delivers a newly posted comment without consuming it", async () => {
    // Given a waiting agent
    const waiting = api(`/${review.id}/wait`);
    // When the user posts feedback
    await comment("Change this");
    const delivered = await waiting;
    // Then delivery has not acknowledged the feedback
    expect(delivered).toMatchObject({ acknowledged: 0, humanSequence: 1, threads: [{ messages: [{ body: "Change this" }] }] });
  });

  test("acknowledging an older batch does not skip a concurrent user reply", async () => {
    // Given an agent handling the first feedback batch
    const first = await comment();
    // And a user reply arriving before the agent acknowledges that batch
    await api(`/${review.id}/reply`, { threadId: first.threads[0].id, author: "user", body: "Also check zero" });
    // When the original batch is acknowledged
    await api(`/${review.id}/ack`, { sequence: first.humanSequence });
    // Then the newer feedback is still delivered
    expect(await api(`/${review.id}/wait`)).toMatchObject({ acknowledged: 1, humanSequence: 2 });
  });

  test("agent replies do not wake the agent as new user feedback", async () => {
    // Given an acknowledged user comment
    const first = await comment();
    await api(`/${review.id}/ack`, { sequence: first.humanSequence });
    // When the agent replies
    const replied = await api(`/${review.id}/reply`, { threadId: first.threads[0].id, author: "agent", body: "Fixed" });
    // Then the user-feedback cursor stays acknowledged
    expect(replied.humanSequence).toBe(replied.acknowledged);
  });

  test("refreshing preserves threads on their original snapshot", async () => {
    // Given a thread on the old snapshot
    const first = await comment();
    // And edits in the working copy
    await writeFile(join(repo, "example.ts"), "// added context\nexport const value = 3;\n");
    // When the diff refreshes
    const refreshed = await api(`/${review.id}/refresh`, {});
    // Then the original thread is unchanged
    expect(refreshed.threads).toEqual(first.threads);
  });

  test("a stale composer cannot attach its comment to refreshed code", async () => {
    // Given edits after the browser captured a snapshot
    await writeFile(join(repo, "example.ts"), "export const value = 3;\n");
    await api(`/${review.id}/refresh`, {});
    // When the old composer posts
    const pending = comment();
    // Then the server rejects the stale anchor
    await expect(pending).rejects.toThrow("The diff changed");
  });

  test("starting again resumes only the same workspace and conversation", async () => {
    // Given an existing review with feedback
    await comment();
    // When the same conversation starts again
    const resumed = await api("", { path: repo, agentSession: review.agentSession });
    // Then it retains the review identity
    expect(resumed.id).toBe(review.id);
  });

  test("finishing wakes a waiting agent and remains readable after restart", async () => {
    // Given a waiting agent
    const waiting = api(`/${review.id}/wait`);
    // When the user finishes
    await api(`/${review.id}/finish`, {});
    await waiting;
    // Then completion is persisted
    expect((await new Reviews(join(directory, "reviews")).get(review.id)).finished).toBe(true);
  });

  test("browser comments and CLI replies share a live thread", async () => {
    // Given the real UI connected to a review
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    try {
      await page.goto(`${uiOrigin}/workspaces/${review.snapshot.workspace.id}?review=${review.id}`);
      await page.locator("[data-biff-focused]").click();
      await page.keyboard.press("c");
      // When the user posts and the agent replies through the CLI
      await page.getByLabel("Inline comment", { exact: true }).fill("Explain the new value");
      await page.getByRole("button", { name: "Save locally", exact: true }).click();
      await browserExpect(page.getByRole("dialog")).toHaveCount(0);
      const posted = await api(`/${review.id}`);
      await page.getByRole("button", { name: /^\d+ (unread )?comments? on line 1$/ }).click();
      const cli = new URL("../bin/biff.ts", import.meta.url).pathname;
      const child = Bun.spawn(["bun", cli, "review", "reply", review.id, posted.threads[0].id, "--body", "It is the new default"], { env: { ...process.env, BIFF_PORT: String(server.port) }, stdout: "pipe", stderr: "pipe" });
      await new Response(child.stdout).text();
      if (await child.exited !== 0) throw new Error(await new Response(child.stderr).text());
      // Then the reply appears through the live event stream without a page reload
      await browserExpect(page.getByText("It is the new default", { exact: true })).toBeVisible();
    } finally { await page.close(); }
  }, 20_000);

  test("old review files are pruned when another review starts", async () => {
    // Given an abandoned review
    const file = join(directory, "reviews", `${review.id}.json`);
    const abandoned = JSON.parse(await readFile(file, "utf8"));
    abandoned.updatedAt = new Date(Date.now() - 8 * 86400_000).toISOString();
    await writeFile(file, JSON.stringify(abandoned));
    // When a fresh review starts
    await api("", { path: repo });
    // Then the expired file is gone
    expect(await Bun.file(file).exists()).toBe(false);
  });

  test("a rejected host admission leaves feedback available for retry", async () => {
    // Given posted feedback for an OpenCode conversation
    await comment();
    // When host admission fails
    await forwardReview({ review, signal: new AbortController().signal, read: () => api(`/${review.id}`), acknowledge: (sequence) => api(`/${review.id}/ack`, { sequence }), deliver: async () => { throw new Error("Host disconnected"); } }).catch(() => {});
    // Then the batch remains unacknowledged
    expect((await api(`/${review.id}`)).acknowledged).toBe(0);
  });

  test("retrying delivery uses the same host prompt identity", async () => {
    // Given finished feedback, so a successful delivery terminates the bridge
    await api(`/${review.id}/finish`, {});
    const prompts: FeedbackPrompt[] = [];
    // When admission succeeds but its response is lost, followed by retry
    for (let attempt = 0; attempt < 2; attempt++) {
      await forwardReview({ review, signal: new AbortController().signal, read: () => api(`/${review.id}`), acknowledge: (sequence) => api(`/${review.id}/ack`, { sequence }), deliver: async (prompt) => {
        prompts.push(prompt);
        if (attempt === 0) throw new Error("Response lost after admission");
      } }).catch(() => {});
    }
    // Then the host can deduplicate the retry by ID
    expect(prompts.map((prompt) => prompt.id)).toEqual([`msg_biff_${review.id}_1`, `msg_biff_${review.id}_1`]);
  });

  test("the bridge acknowledges only its admitted batch when more feedback arrives", async () => {
    // Given a batch ready for the host
    const posted = await comment();
    const controller = new AbortController();
    // When another user reply arrives during admission
    await forwardReview({ review, signal: controller.signal, read: () => api(`/${review.id}`), acknowledge: (sequence) => api(`/${review.id}/ack`, { sequence }), deliver: async () => {
      await api(`/${review.id}/reply`, { threadId: posted.threads[0].id, body: "One more thing" });
      controller.abort();
    } });
    // Then the next batch is still unacknowledged
    expect(await api(`/${review.id}`)).toMatchObject({ acknowledged: 1, humanSequence: 2 });
  });

  test("attached collaboration uses workspace revision navigation", async () => {
    // Given a workspace with an attached collaboration session
    const page = await browser.newPage();
    try {
      // When the link is opened
      await page.goto(`${uiOrigin}/workspaces/${review.snapshot.workspace.id}?review=${review.id}`);
      // Then the shared workspace revision picker is available
      await browserExpect(page.getByRole("combobox", { name: "Changes", exact: true })).toHaveValue("all");
    } finally { await page.close(); }
  });

  test("completion in a workspace is shared with its attached collaboration session", async () => {
    // Given a workspace review without collaboration attached
    const page = await browser.newPage();
    const workspace = `${uiOrigin}/workspaces/${review.snapshot.workspace.id}`;
    try {
      await page.goto(workspace);
      await page.locator("[data-biff-focused]").waitFor();
      await page.keyboard.press("Space");
      await browserExpect(page.getByLabel("Change review progress")).toHaveText("1 / 1 changes reviewed");

      // When the same workspace is opened with collaboration attached
      await page.goto(`${workspace}?review=${review.id}`);

      // Then both entry points use the same durable completion
      await browserExpect(page.getByLabel("Change review progress")).toHaveText("1 / 1 changes reviewed");
    } finally { await page.close(); }
  });

  test("reloading collaboration picks up edits and preserves completion", async () => {
    // Given a reviewed edit in an attached collaboration session
    const page = await browser.newPage();
    try {
      await page.goto(`${uiOrigin}/workspaces/${review.snapshot.workspace.id}?review=${review.id}`);
      await page.locator("[data-biff-focused]").waitFor();
      await page.keyboard.press("Space");
      await browserExpect(page.getByLabel("Change review progress")).toHaveText("1 / 1 changes reviewed");

      // And another file is edited while the reviewed edit stays unchanged
      await writeFile(join(repo, "other.ts"), "export const other = true;\n");

      // When the browser tab is reloaded
      await page.reload();
      await browserExpect.poll(async () => (await api(`/${review.id}`)).snapshot.selected.commit_id).not.toBe(review.snapshot.selected.commit_id);
      const refreshed = await api(`/${review.id}`);
      await page.getByTitle(refreshed.snapshot.selected.commit_id, { exact: true }).waitFor();

      // Then completion remains visible in the shared workspace viewer
      await browserExpect(page.getByLabel("Change review progress")).toHaveText("1 / 1 changes reviewed");
    } finally { await page.close(); }
  });

  test("reviewing a local file persists all of its blocks across reload", async () => {
    // Given a local review with an unreviewed file
    await fetch(`${server.url}api/workspaces/${review.snapshot.workspace.id}/review`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ bookmark: "" }) });
    const page = await browser.newPage();
    try {
      await page.goto(`${uiOrigin}/workspaces/${review.snapshot.workspace.id}`);
      await browserExpect(page.getByRole("checkbox", { name: "File reviewed" })).toBeEnabled();

      // When the whole file is reviewed and the page reloads
      await page.getByRole("checkbox", { name: "File reviewed" }).click();
      await browserExpect(page.getByLabel("Change review progress")).toHaveText("1 / 1 changes reviewed");
      await page.reload();

      // Then every block remains reviewed
      await browserExpect(page.getByLabel("Change review progress")).toHaveText("1 / 1 changes reviewed");
    } finally { await page.close(); }
  });

  test("unmarking a reviewed file clears its block approvals", async () => {
    // Given a file completed through its individual block
    await fetch(`${server.url}api/workspaces/${review.snapshot.workspace.id}/review`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ bookmark: "" }) });
    const page = await browser.newPage();
    try {
      await page.goto(`${uiOrigin}/workspaces/${review.snapshot.workspace.id}`);
      await page.locator("[data-biff-focused]").waitFor();
      await browserExpect(page.getByRole("checkbox", { name: "File reviewed" })).toBeEnabled();
      await page.keyboard.press("Space");
      await browserExpect(page.getByRole("checkbox", { name: "File reviewed" })).toBeChecked();

      // When the file is marked unreviewed
      await page.getByRole("checkbox", { name: "File reviewed" }).click();

      // Then its blocks need review again
      await browserExpect(page.getByLabel("Change review progress")).toHaveText("0 / 1 changes reviewed");
    } finally { await page.close(); }
  });

  test("ordinary bookmark reviews can save visibly local comments", async () => {
    // Given a bookmark review without an agent-session query parameter
    const page = await browser.newPage();
    try {
      await page.goto(`${uiOrigin}/workspaces/${review.snapshot.workspace.id}`);
      await page.locator("[data-biff-focused]").waitFor();

      // When a local inline comment is saved and the page reloads
      await page.locator("[data-biff-focused]").click();
      await page.keyboard.press("c");
      await page.getByRole("textbox", { name: "Inline comment" }).fill("Keep this note local.");
      await page.getByRole("button", { name: "Save locally", exact: true }).click();
      await browserExpect(page.getByRole("dialog")).toHaveCount(0);
      await page.reload();
      await page.getByRole("button", { name: "Local comments (1)", exact: true }).click();
      await page.getByRole("button", { name: "example.ts:1 · Open", exact: true }).click();

      // Then the saved thread explicitly says it has not been published
      await browserExpect(page.getByRole("dialog").getByText("Local", { exact: true }).first()).toBeVisible();
    } finally { await page.close(); }
  });

  test("a local comment edit survives reloading the bookmark", async () => {
    // Given a saved local comment
    await comment("Original local note.");
    const page = await browser.newPage();
    try {
      await page.goto(`${uiOrigin}/workspaces/${review.snapshot.workspace.id}`);
      await page.getByRole("button", { name: "Local comments (1)", exact: true }).click();
      await page.getByRole("button", { name: "example.ts:1 · Open", exact: true }).click();

      // When the user edits it and reloads
      await page.getByRole("button", { name: "Edit", exact: true }).click();
      await page.getByRole("textbox", { name: "Edit comment", exact: true }).fill("Updated local note.");
      await page.getByRole("button", { name: "Save changes", exact: true }).click();
      await page.getByRole("textbox", { name: "Edit comment", exact: true }).waitFor({ state: "detached" });
      await page.reload();
      await page.getByRole("button", { name: "Local comments (1)", exact: true }).click();

      // Then the saved thread contains the revised body
      await browserExpect(page.getByText("Updated local note.", { exact: true })).toBeVisible();
    } finally { await page.close(); }
  });

  test("an agent-session comment can be deleted from its dialog", async () => {
    // Given a saved comment in an attached review
    await comment("Remove this note.");
    const page = await browser.newPage();
    try {
      await page.goto(`${uiOrigin}/workspaces/${review.snapshot.workspace.id}?review=${review.id}`);
      await page.getByRole("button", { name: /^\d+ (unread )?comments? on line 1$/ }).click();

      // When the user deletes the comment
      await page.getByRole("button", { name: "Delete", exact: true }).click();
      await page.getByRole("dialog").waitFor({ state: "detached" });

      // Then the agent's saved discussion no longer contains the thread
      expect((await api(`/${review.id}`)).threads).toEqual([]);
    } finally { await page.close(); }
  });
});
