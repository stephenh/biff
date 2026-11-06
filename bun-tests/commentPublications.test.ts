import { describe, expect, it } from "bun:test";
import type { Conversation, DiscussionComment } from "../shared/types";
import { CommentPublications } from "../src/commentPublications";
import { buildDiscussionThreads, buildThreads } from "../src/githubCommentThreads";
import { BackgroundSaveRegistry } from "../src/optimisticSave";

const endpoint = "/api/github/pr/example/repo/1";
const empty: Conversation = { viewer: "me", comments: [], inline: [], reviews: [] };
const comment: DiscussionComment = { id: 99, body: "Submitted text", user: { login: "me" }, html_url: "https://github.com/comment/99", path: "file.ts", line: 1, side: "RIGHT" };

describe("commentPublications", () => {
  it("projects a submitted comment before publication completes", () => {
    // Given an empty cached conversation
    const publications = new CommentPublications();
    // When a general comment is submitted
    publications.add(endpoint, "first", "comments", comment);
    // Then it is visible as pending rather than published
    expect(publications.project(endpoint, empty, [])?.comments).toEqual([{ ...comment, id: -1_000_000, publication: { localId: -1_000_000, draftId: undefined, status: "saving" } }]);
  });

  it("bridges a successful receipt while cached reads still omit the comment", () => {
    // Given a comment published after the last cached read
    const publications = new CommentPublications();
    publications.add(endpoint, "first", "inline", comment);
    // When GitHub acknowledges publication
    publications.acknowledge(endpoint, "first", comment);
    // Then the receipt stays visible through the stale cache
    expect(publications.project(endpoint, empty, [])?.inline).toEqual([{ ...comment, publication: { localId: -1_000_000, draftId: undefined, status: "saved" } }]);
  });

  it("uses the cached comment without duplicating or overwriting newer server text", () => {
    // Given an acknowledged publication
    const publications = new CommentPublications();
    publications.add(endpoint, "first", "inline", comment);
    publications.acknowledge(endpoint, "first", comment);
    // When the cached read contains a later edit
    const projected = publications.project(endpoint, { ...empty, inline: [{ ...comment, body: "Edited on GitHub" }] }, []);
    // Then only that newer comment is rendered
    expect(projected?.inline.map((entry) => entry.body)).toEqual(["Edited on GitHub"]);
  });

  it("does not resurrect a comment deleted after the cache observed it", () => {
    // Given a publication already present in the cache
    const publications = new CommentPublications();
    publications.add(endpoint, "first", "inline", comment);
    publications.acknowledge(endpoint, "first", comment);
    publications.project(endpoint, { ...empty, inline: [comment] }, []);
    // When a later snapshot no longer contains it
    const projected = publications.project(endpoint, empty, []);
    // Then the publication overlay does not restore the deleted message
    expect(projected?.inline).toEqual([]);
  });

  it("keeps a stable selected thread identity through acknowledgement", () => {
    // Given an opened optimistic inline thread
    const publications = new CommentPublications();
    publications.add(endpoint, "first", "inline", comment);
    const before = buildThreads(publications.project(endpoint, empty, []), [])[0].id;
    // When the temporary comment receives its GitHub ID
    publications.acknowledge(endpoint, "first", comment);
    // Then the same thread remains selected
    expect(buildThreads(publications.project(endpoint, empty, []), [])[0].id).toEqual(before);
  });

  it("replaces the corresponding review draft rather than rendering a duplicate", () => {
    // Given an inline submission also retained as a durable review draft
    const publications = new CommentPublications();
    publications.add(endpoint, "first", "inline", comment, "draft-id");
    // When both sources are projected together
    const threads = buildThreads(publications.project(endpoint, empty, []), [{ id: "draft-id", body: comment.body, path: "file.ts", line: 1, side: "RIGHT" }]);
    // Then only one thread represents the submitted text
    expect(threads.map((thread) => thread.comments[0].body)).toEqual([comment.body]);
  });

  it("does not hide a newer draft with the same durable ID", () => {
    // Given an older immutable publication for a draft
    const publications = new CommentPublications();
    publications.add(endpoint, "first", "inline", comment, "draft-id");
    // When the draft has newer unsent text
    const threads = buildThreads(publications.project(endpoint, empty, []), [{ id: "draft-id", body: "Newer text", path: "file.ts", line: 1, side: "RIGHT" }]);
    // Then both distinct intents remain visible
    expect(threads.map((thread) => thread.comments[0].body)).toEqual([comment.body, "Newer text"]);
  });

  it("retains failed text and replaces it exactly once on Retry", async () => {
    // Given a failed append with an optimistic projection
    const publications = new CommentPublications();
    const registry = new BackgroundSaveRegistry();
    publications.add(endpoint, "first", "comments", comment);
    await registry.submit(`github-comments:${endpoint}`, "general", "first", "PR comment", async () => { throw new Error("Offline"); });
    // When Retry acknowledges the same submission
    await registry.submit(`github-comments:${endpoint}`, "general", "first", "PR comment", async () => { publications.acknowledge(endpoint, "first", comment); });
    // Then one published comment remains
    expect(publications.project(endpoint, empty, registry.getSnapshot())?.comments).toEqual([{ ...comment, publication: { localId: -1_000_000, draftId: undefined, status: "saved" } }]);
  });

  it("does not count pending comments as unread GitHub messages or allow resolution", () => {
    // Given a general comment still waiting for publication
    const publications = new CommentPublications();
    publications.add(endpoint, "first", "comments", comment);
    // When conversation threads are built
    const threads = buildDiscussionThreads(publications.project(endpoint, empty, []), [], "author");
    // Then remote read and resolution actions are unavailable
    expect(threads[0]).toMatchObject({ readKeys: [], canResolve: false, canReopen: false });
  });

  it("keeps separate append intents without leaking them into another PR", () => {
    // Given two submissions for one PR
    const publications = new CommentPublications();
    publications.add(endpoint, "first", "comments", comment);
    publications.add(endpoint, "second", "comments", { ...comment, body: "Another comment" });
    // When another PR reads its conversation
    const projected = publications.project(`${endpoint}0`, empty, []);
    // Then that PR has no optimistic comments
    expect(projected).toEqual(empty);
  });

  it("keeps failed submissions visible without claiming publication", async () => {
    // Given an optimistic PR comment
    const publications = new CommentPublications();
    const registry = new BackgroundSaveRegistry();
    publications.add(endpoint, "first", "comments", comment);
    // When its publication fails
    await registry.submit(`github-comments:${endpoint}`, "general", "first", "PR comment", async () => { throw new Error("Offline"); });
    // Then its original text remains with a failed status
    expect(publications.project(endpoint, empty, registry.getSnapshot())?.comments[0]).toMatchObject({ body: comment.body, publication: { status: "error" } });
  });

  it("does not coalesce separate comments with identical submitted text", () => {
    // Given one pending append
    const publications = new CommentPublications();
    publications.add(endpoint, "first", "comments", comment);
    // When another explicit append uses the same text
    publications.add(endpoint, "second", "comments", comment);
    // Then both intents are retained
    expect(publications.project(endpoint, empty, [])?.comments.map((entry) => entry.body)).toEqual([comment.body, comment.body]);
  });
});
