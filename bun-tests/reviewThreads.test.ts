import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { Storage } from "../server/storage";
import { Progress } from "../server/progress";
import { GitHub } from "../server/github";
import type { CommandOptions } from "../server/commands";
import type { DiscussionComment, ReviewDraft } from "../shared/types";
import { createApi } from "../server/api";
import { Workspaces } from "../server/workspaces";
import { PrActivity } from "../server/prActivity";
import { commentHunks } from "../shared/commentHunks";

const first = "a".repeat(40);
const second = "b".repeat(40);
const base = "c".repeat(40);
const id = "11111111-1111-4111-8111-111111111111";
const scope = "example/project/12";
interface Fixture { head: string; patches: Map<string, string>; writes: unknown[]; inline: DiscussionComment[]; reviews: DiscussionComment[]; holdPatch?: Promise<void>; patchStarted?: () => void; loseWriteResponse?: boolean; changedFiles?: number }

describe("reviewThreads", () => {
  let directory: string;
  let storage: Storage;
  let progress: Progress;
  let github: GitHub;
  let state: Fixture;

  beforeEach(async () => {
    directory = await mkdtemp("/tmp/opencode/biff-thread-anchors-");
    storage = new Storage(`${directory}/biff.sqlite`);
    progress = new Progress(storage);
    state = { head: first, patches: new Map([[first, patch(10)], [second, patch(40)]]), writes: [], inline: [], reviews: [] };
    github = new GitHub((args, options) => runFixture(state, args, options), storage);
  });
  afterEach(async () => { await storage.close(); await rm(directory, { recursive: true }); });

  test("saved review text survives a storage restart without browser state", async () => {
    // Given a durable review comment and summary
    await github.threadSync!.saveDraft("example/project", "12", draft());

    // When the daemon's storage is reopened
    await storage.close();
    storage = new Storage(`${directory}/biff.sqlite`);
    progress = new Progress(storage);
    const saved = await progress.reviewDraft(scope);

    // Then the independent comment remains recoverable from the relational store
    expect(saved).toMatchObject({ body: "A saved summary.", comments: [{ id, body: "Keep this comment.", line: 11, needsReanchoring: false }] });
  });

  test("a draft follows its logical hunk without replacing original anchor evidence", async () => {
    // Given a saved comment on the first head
    await github.threadSync!.saveDraft("example/project", "12", draft());
    // And the edit moved on a new head
    state.head = second;

    // When PR synchronization follows the hunk
    await github.syncThreads("example/project", "12");
    const saved = await progress.reviewDraft(scope);

    // Then the current attachment moved without changing the thread identity
    expect(saved.comments).toMatchObject([{ id, line: 41, commitId: second, needsReanchoring: false }]);
  });

  test("published GitHub threads follow in Biff without changing their remote identity", async () => {
    // Given a GitHub thread originally attached to the first head
    state.inline = [comment()];
    await github.threadSync!.observe("example/project", "12", state.inline);
    // And GitHub now calls it outdated while its unchanged edit moved
    state.head = second;
    state.inline[0] = { ...state.inline[0], line: null };

    // When Biff refreshes its attachment
    await github.syncThreads("example/project", "12");
    const attached = await github.threadSync!.attach("example/project", "12", state.inline);

    // Then the original GitHub link and ID point at the new Biff location
    expect(attached).toMatchObject([{ id: 42, html_url: "https://github.com/example/project/pull/12#discussion_r42", line: null, biffAttachment: { line: 41, commitId: second, matched: true } }]);
  });

  test("a changed edit remains in the review as needing re-anchoring", async () => {
    // Given a saved comment
    await github.threadSync!.saveDraft("example/project", "12", draft());
    // And its hunk's content changed
    state.head = second;
    state.patches.set(second, patch(40).replace("new first", "different first"));

    // When synchronizing the new comparison
    await github.syncThreads("example/project", "12");
    const saved = await progress.reviewDraft(scope);

    // Then no text is dropped or attached to the changed edit
    expect(saved.comments).toMatchObject([{ id, body: "Keep this comment.", line: 11, needsReanchoring: true }]);
  });

  test("a stale tab cannot replace a newer saved draft", async () => {
    // Given two tabs which both read version one
    const saved = await github.threadSync!.saveDraft("example/project", "12", draft());
    // And the first tab saves its edit
    await github.threadSync!.saveDraft("example/project", "12", { ...saved, body: "Newer summary." });

    // When the stale tab tries replacing the draft
    await expect(github.threadSync!.saveDraft("example/project", "12", { ...saved, body: "Stale summary." })).rejects.toThrow("changed in another tab");
    const current = await progress.reviewDraft(scope);

    // Then the newer summary remains durable
    expect(current.body).toEqual("Newer summary.");
  });

  test("manual re-anchoring appends evidence instead of erasing the first location", async () => {
    // Given a comment whose original edit was replaced
    const saved = await github.threadSync!.saveDraft("example/project", "12", draft());
    state.head = second;
    state.patches.set(second, patch(40).replace("new first", "different first"));

    // When the reviewer explicitly chooses its new line
    await github.threadSync!.saveDraft("example/project", "12", { ...saved, commitId: second, comments: [{ ...saved.comments[0], commitId: second, baseCommitId: base, line: 41, reanchor: true }] });

    // Then both original and explicitly chosen anchor evidence remain recorded
    expect(storage.db.query("SELECT commit_id,line FROM thread_anchors ORDER BY id").all()).toEqual([{ commit_id: first, line: 11 }, { commit_id: second, line: 41 }]);
  });

  test("repeating browser migration cannot resurrect an acknowledged review", async () => {
    // Given a browser-only draft imported into Biff and then submitted
    const source = draft();
    const imported = await github.threadSync!.saveDraft("example/project", "12", source, true);
    await progress.acknowledgeReview(scope, imported);

    // When an old browser repeats the same import
    const restored = await github.threadSync!.saveDraft("example/project", "12", source, true);

    // Then neither the old summary nor its submitted comment reappears as unsent
    expect(restored).toMatchObject({ body: "", comments: [] });
  });

  test("publication acknowledgement preserves edits made while the request was held", async () => {
    // Given an immutable review submission
    const sent = await github.threadSync!.saveDraft("example/project", "12", draft());
    // And a newer edit was saved before GitHub acknowledged it
    await github.threadSync!.saveDraft("example/project", "12", { ...sent, body: "Newer summary.", comments: [{ ...sent.comments[0], body: "Newer comment." }] });

    // When the older submission succeeds
    await progress.acknowledgeReview(scope, sent);
    const current = await progress.reviewDraft(scope);

    // Then the newer text remains in the draft
    expect(current).toMatchObject({ body: "Newer summary.", comments: [{ supersedes: id, body: "Newer comment." }] });
  });

  test("publication translates an old draft into current GitHub coordinates", async () => {
    // Given a draft whose unchanged hunk has moved since composing
    const sent = await github.threadSync!.saveDraft("example/project", "12", draft());
    state.head = second;
    const current = await github.review("example/project", "12", "all");

    // When translating its hunk-relative comments for publication
    const translated = await github.threadSync!.submission("example/project", "12", sent, current);

    // Then the publication uses the latest exact coordinate
    expect(translated).toMatchObject([{ id, line: 41, commitId: second, body: "Keep this comment." }]);
  });

  test("a changed head during synchronization cannot install an obsolete attachment", async () => {
    // Given a saved first-head comment and a held second-head diff request
    await github.threadSync!.saveDraft("example/project", "12", draft());
    const held = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    state.head = second;
    state.holdPatch = held.promise;
    state.patchStarted = started.resolve;

    // When the head changes back before the fetched second-head diff is committed
    const pending = github.syncThreads("example/project", "12");
    await started.promise;
    state.head = first;
    held.resolve();
    await pending;
    const saved = await progress.reviewDraft(scope);

    // Then the obsolete second-head attachment was not installed
    expect(saved.comments).toMatchObject([{ id, line: 11, commitId: first }]);
  });

  test("automatic hunk following never replaces original anchor evidence", async () => {
    // Given an original anchor saved on the first head
    await github.threadSync!.saveDraft("example/project", "12", draft());
    const original = storage.db.query("SELECT * FROM thread_anchors").all();
    // And the edit moves on another head
    state.head = second;

    // When synchronization moves its current attachment
    await github.syncThreads("example/project", "12");

    // Then its original anchor evidence is byte-for-byte unchanged
    expect(storage.db.query("SELECT * FROM thread_anchors").all()).toEqual(original);
  });

  test("review retry recovers remote success even after its hunk changes", async () => {
    // Given a saved draft and a response lost after GitHub accepts the review
    const sent = await github.threadSync!.saveDraft("example/project", "12", draft());
    const api = createApi({ github, progress, workspaces: new Workspaces(storage) });
    const requestId = "22222222-2222-4222-8222-222222222222";
    state.loseWriteResponse = true;
    await api(reviewRequest(sent, requestId));
    // And the original hunk no longer matches
    state.head = second;
    state.patches.set(second, patch(40).replace("new first", "changed first"));

    // When the same submission is retried
    const response = await api(reviewRequest(sent, requestId));
    if (!response.ok) throw new Error(await response.text());

    // Then remote success is recovered without another publication
    expect(state.writes.length).toEqual(1);
  });

  test("inline-comment retry recovers success before requiring its old anchor", async () => {
    // Given a durable line comment and a lost publication response
    const sent = await github.threadSync!.saveDraft("example/project", "12", draft());
    const api = createApi({ github, progress, workspaces: new Workspaces(storage) });
    const requestId = "22222222-2222-4222-8222-222222222222";
    const body = { commitId: first, comment: sent.comments[0] };
    state.loseWriteResponse = true;
    await api(new Request(`http://127.0.0.1/api/github/pr/${scope}/inline-comment`, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": requestId }, body: JSON.stringify(body) }));
    // And the hunk subsequently changes
    state.head = second;
    state.patches.set(second, patch(40).replace("new first", "changed first"));

    // When publication is retried with its original submission ID
    const response = await api(new Request(`http://127.0.0.1/api/github/pr/${scope}/inline-comment`, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": requestId }, body: JSON.stringify(body) }));
    if (!response.ok) throw new Error(await response.text());

    // Then the existing GitHub message is recovered rather than reposted
    expect(state.writes.length).toEqual(1);
  });

  test("an imported publication receipt preserves newer unsent text as its own draft", async () => {
    // Given an older submission and a newer saved edit on the same thread
    const sent = await github.threadSync!.saveDraft("example/project", "12", draft());
    await github.threadSync!.saveDraft("example/project", "12", { ...sent, comments: [{ ...sent.comments[0], body: "Newer, still unsent." }] });
    // And GitHub returns the older text with its publication marker
    const published = { ...comment(), body: `Keep this comment.\n\n<!-- biff:${id}:${id} -->` };

    // When importing the receipt
    await github.threadSync!.observe("example/project", "12", [published]);
    const current = await progress.reviewDraft(scope);

    // Then only the newer text remains an unsent comment
    expect(current.comments).toMatchObject([{ body: "Newer, still unsent." }]);
  });

  test("manual published-thread re-anchoring changes only Biff's evidence", async () => {
    // Given a published thread with a current Biff attachment
    await github.threadSync!.observe("example/project", "12", [comment()]);
    const attached = await github.threadSync!.attach("example/project", "12", [comment()]);

    // When explicitly choosing another line within that hunk
    await github.threadSync!.reanchor("example/project", "12", 42, { path: "file.txt", side: "RIGHT", line: 10 }, first, base, attached[0].biffAttachment!);

    // Then GitHub receives no writes and retains its original coordinates
    expect(state.writes).toEqual([]);
  });

  test("discussion message identities and publication receipts survive restart", async () => {
    // Given a review with a published local thread
    await github.threadSync!.saveDraft("example/project", "12", draft());
    await progress.updateDiscussion(scope, (discussion) => {
      discussion.threads[0].messages[0].published = { pr: scope, id: 42, url: comment().html_url, publishedAt: "2026-10-26T00:00:00Z" };
    });
    const discussion = await progress.discussion(scope);
    await storage.close();

    // When reopening the database
    storage = new Storage(`${directory}/biff.sqlite`);
    const restored = await new Progress(storage).discussion(scope);

    // Then the exact saved threads survive without needing the browser
    expect(restored.threads).toEqual(discussion.threads);
  });

  test("two comments on the same edit share one relational logical hunk", async () => {
    // Given two independently identified comments on different lines of one edit
    const source = draft();
    source.comments.push({ ...source.comments[0], id: "33333333-3333-4333-8333-333333333333", line: 10, body: "Another line in this hunk." });

    // When both comments are durably saved
    await github.threadSync!.saveDraft("example/project", "12", source);

    // Then both anchors reference one logical hunk, not duplicate per-comment hunk records
    expect(storage.db.query<{ count: number }, []>("SELECT count(DISTINCT hunk_id) AS count FROM thread_anchors").get()?.count).toEqual(1);
  });

  test("thread anchors store independent offsets within their shared logical hunk", async () => {
    // Given comments on the second and first lines of one edit
    const source = draft();
    source.comments.push({ ...source.comments[0], id: "33333333-3333-4333-8333-333333333333", line: 10, body: "Another line in this hunk." });

    // When storing their hunk-relative anchors
    await github.threadSync!.saveDraft("example/project", "12", source);

    // Then each thread retains its own offset rather than sharing an absolute coordinate
    expect(storage.db.query("SELECT line_offset FROM thread_anchors ORDER BY id").all()).toEqual([{ line_offset: 1 }, { line_offset: 0 }]);
  });

  test("replaying an acknowledged review cannot consume another identical summary", async () => {
    // Given an acknowledged review and another deliberately typed identical summary
    const sent = await github.threadSync!.saveDraft("example/project", "12", draft());
    await progress.acknowledgeReview(scope, sent, 42);
    const empty = await progress.reviewDraft(scope);
    await github.threadSync!.saveDraft("example/project", "12", { ...empty, body: sent.body });

    // When recovering the original review receipt again
    await progress.acknowledgeReview(scope, sent, 42);
    const current = await progress.reviewDraft(scope);

    // Then the later summary remains unsent
    expect(current.body).toEqual(sent.body);
  });

  test("separate publications originating from one draft retain independent GitHub attachments", async () => {
    // Given two GitHub roots which originated from successive immutable submissions of one draft
    await github.threadSync!.saveDraft("example/project", "12", draft());
    const original = { ...comment(), body: `Keep this comment.\n\n<!-- biff:${id}:${id} -->` };
    const later = { ...comment(), id: 43, body: `A later submitted edit.\n\n<!-- biff:${id}:${id} -->` };
    await github.threadSync!.observe("example/project", "12", [original, later]);
    // And their unchanged hunk moves
    state.head = second;

    // When synchronizing and reading both published roots again
    await github.syncThreads("example/project", "12");
    await github.threadSync!.observe("example/project", "12", [original, later]);
    const attached = await github.threadSync!.attach("example/project", "12", [original, later]);

    // Then neither publication overwrites the other's stable remote identity or Biff location
    expect(attached).toMatchObject([{ id: 42, biffAttachment: { line: 41, matched: true } }, { id: 43, biffAttachment: { line: 41, matched: true } }]);
  });
  test("hydrating an inbox comment reuses its message and thread identity", async () => {
    // Given a metadata-only inline comment
    const activities = new PrActivity(storage.db);
    activities.summary({ number: 12, title: "PR", url: "https://github.com/example/project/pull/12", repository: { nameWithOwner: "example/project" }, author: { login: "author" }, isDraft: false, updatedAt: "today" });
    activities.save(scope, { head: first, headAuthor: "author", checks: "Passing", reviewDecision: "REVIEW_REQUIRED", events: [{ key: "inline:42", thread: "inline:42", actor: "reviewer", at: "today", kind: "reply" }] });
    const saved = storage.db.query<{ id: string; thread_id: string }, []>("SELECT id,thread_id FROM review_messages").get()!;

    // When a full GitHub fetch supplies the comment body and original coordinates
    state.inline = [comment()];
    await github.threadSync!.observe("example/project", "12", state.inline);

    // Then the same publication becomes an anchored discussion rather than a second message
    expect(storage.db.query("SELECT id,thread_id,body,body_known FROM review_messages").all()).toEqual([{ ...saved, body: comment().body, body_known: 1 }]);
    expect((await progress.discussion(scope)).threads).toMatchObject([{ id: saved.thread_id, anchor: { path: comment().path }, messages: [{ id: saved.id }] }]);
  });
  test("a PR refresh observes flagged hunks even without any comment threads", async () => {
    // Given a local-only flag sharing the PR's review identity
    const identity = await progress.identity(scope);
    const local = `jj/workspace/${identity.id}`;
    storage.db.query("INSERT INTO review_aliases VALUES (?,?)").run(local, identity.id);
    const [block] = (await commentHunks(patch(10))).blocks;
    await progress.followUpHunk(local, block, first, true);
    state.changedFiles = 1;

    // When the full current PR comparison is refreshed
    await github.syncThreads("example/project", "12");

    // Then the PR list can expose the same flagged edit
    expect(progress.followUps(scope)).toMatchObject([{ type: "hunk", source: "pr", head: first, hash: block.hash }]);
  });

  test("an incomplete PR comparison cannot clear a flagged hunk", async () => {
    // Given a flagged edit and a remote response missing one advertised file
    const [block] = (await commentHunks(patch(10))).blocks;
    await progress.followUpHunk(scope, block, first, true);
    state.head = second;
    state.changedFiles = 2;
    state.patches.set(second, patch(40).replaceAll("new", "different"));

    // When attachment sync receives that truncated comparison
    await github.syncThreads("example/project", "12");

    // Then the flag and observation remain pending a complete comparison
    expect(progress.followUps(scope)).toMatchObject([{ head: first }]);
    expect(progress.needsFollowUpDiff(scope, second)).toEqual(true);
  });

  test("hydrating a follow-up placeholder keeps the flag on the imported thread", async () => {
    // Given preserved GitHub follow-up evidence without a cached message
    await progress.followUpThread(scope, { type: "thread", id: "github:42", label: "Old label", location: { path: "file.txt", side: "RIGHT", line: 11 } }, true);
    const before = storage.db.query<{ id: string }, []>("SELECT id FROM review_threads").get()!;

    // When GitHub supplies the actual root and the attachment is refreshed
    await github.threadSync!.observe("example/project", "12", [comment()]);

    // Then the same thread owns the flag and the current message label
    expect(storage.db.query("SELECT id,follow_up FROM review_threads").all()).toEqual([{ id: before.id, follow_up: 1 }]);
    expect(progress.followUps(scope)).toMatchObject([{ id: "github:42", label: comment().body }]);
  });
  test("opening a complete untouched PR registers text and metadata units", async () => {
    // Given a PR with a text edit and an executable-bit change, but no Biff interactions
    state.changedFiles = 1;
    state.patches.set(first, patch(10).replace("--- a/file.txt", "old mode 100644\nnew mode 100755\n--- a/file.txt"));

    // When the full review is loaded and processed
    const review = await github.review("example/project", "12", "all");
    await github.syncThreads("example/project", "12", review);

    // Then both kinds of review unit are present and unapproved
    expect(storage.db.query("SELECT path,kind,pr_head,reviewed_at FROM logical_hunks ORDER BY kind").all()).toEqual([
      { path: "file.txt", kind: "", pr_head: first, reviewed_at: null },
      { path: "file.txt", kind: "metadata", pr_head: first, reviewed_at: null },
    ]);
  });
});

/** Use the command boundary so the tested domain performs real persistence and matching. */
async function runFixture(state: Fixture, args: string[], options?: CommandOptions): Promise<string> {
  const endpoint = args[2];
  if (options?.input) {
    const body = JSON.parse(options.input);
    state.writes.push(body);
    const posted = { ...body, id: 100, user: { login: "reviewer" }, html_url: "https://github.com/review/100" };
    if (endpoint.endsWith("/reviews")) state.reviews.push(posted);
    else state.inline.push(posted);
    if (state.loseWriteResponse) { state.loseWriteResponse = false; throw new Error("Response lost after GitHub accepted the write"); }
    return JSON.stringify(posted);
  }
  if (endpoint === "repos/example/project/pulls/12") return JSON.stringify({ number: 12, title: "Review", state: "open", changed_files: state.changedFiles, head: { sha: state.head }, base: { sha: base } });
  if (endpoint === "repos/example/project/pulls/12/commits?per_page=100") return JSON.stringify([[{ sha: first }, { sha: second }]]);
  if (endpoint.startsWith("repos/example/project/compare/")) {
    const head = endpoint.split("...")[1];
    if (state.holdPatch) { state.patchStarted?.(); await state.holdPatch; }
    const patch = state.patches.get(head);
    if (patch === undefined) throw new Error("Comparison unavailable");
    return patch;
  }
  if (endpoint.endsWith("/reviews?per_page=100")) return JSON.stringify([state.reviews]);
  if (endpoint.endsWith("/comments?per_page=100")) return JSON.stringify([state.inline]);
  throw new Error(`Unexpected endpoint ${endpoint}`);
}

/** Keep coordinates explicit so original and current attachment evidence can be compared. */
function draft(): ReviewDraft {
  return { version: 0, commitId: first, body: "A saved summary.", comments: [{ id, path: "file.txt", line: 11, side: "RIGHT", body: "Keep this comment.", commitId: first, baseCommitId: base }] };
}

/** A published root can become outdated on GitHub without losing its original source evidence. */
function comment(): DiscussionComment {
  return { id: 42, body: "A published question.", path: "file.txt", line: 11, original_line: 11, side: "RIGHT", commit_id: first, original_commit_id: first, user: { login: "someone" }, html_url: "https://github.com/example/project/pull/12#discussion_r42" };
}

/** Exact text is identical across heads; only its file coordinates change. */
function patch(line: number): string {
  return `diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt\n@@ -${line},2 +${line},2 @@\n-old first\n-old second\n+new first\n+new second\n`;
}

/** Construct a retryable review write at the HTTP boundary, never against real GitHub. */
function reviewRequest(draft: ReviewDraft, requestId: string): Request {
  return new Request(`http://127.0.0.1/api/github/pr/${scope}/review`, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": requestId }, body: JSON.stringify({ ...draft, event: "COMMENT" }) });
}
