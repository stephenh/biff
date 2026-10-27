import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Storage } from "../server/storage";
import { Reviews, appendMessage } from "../server/reviews";
import { updateDiscussion } from "../server/discussionThreads";
import { reviewIdentity } from "../server/reviewStore";
import { readSnapshot } from "../server/reviewSnapshots";
import type { LocalReview } from "../shared/types";
import type { ReviewThread } from "../shared/localReview";

describe("agentSessions", () => {
  let storage: Storage;
  let reviews: Reviews;
  beforeEach(() => { storage = new Storage(); reviews = new Reviews(storage); });
  afterEach(async () => { await storage.close(); });

  test("identical paths on different workspace identities do not resume the same session", async () => {
    // Given a conversation on a desktop workspace
    await reviews.start(snapshot("desktop"), "conversation");

    // When the same conversation identifier starts on a laptop at the same path
    const laptop = await reviews.start(snapshot("laptop"), "conversation");

    // Then lookup is scoped by central workspace identity
    expect((await reviews.list("laptop")).map((session) => session.id)).toEqual([laptop.id]);
  });

  test("moving a workspace path does not create a new agent conversation", async () => {
    // Given a session on a stable workspace identity
    const original = await reviews.start(snapshot("workspace"), "conversation");
    // And a new provider location for the same workspace
    const moved = snapshot("workspace");
    moved.workspace.path = "/moved/project";

    // When the conversation resumes
    const resumed = await reviews.start(moved, "conversation");

    // Then the path is not its identity
    expect(resumed.id).toBe(original.id);
  });

  test("acknowledging feedback does not rewrite the accepted snapshot", async () => {
    // Given a captured review and a database rejecting snapshot writes
    const session = await reviews.start(snapshot("workspace"), "conversation");
    storage.db.exec(`CREATE TRIGGER immutable_snapshot BEFORE UPDATE ON review_snapshots BEGIN SELECT RAISE(ABORT,'immutable'); END;
      CREATE TRIGGER no_extra_snapshot BEFORE INSERT ON review_snapshots BEGIN SELECT RAISE(ABORT,'unexpected capture'); END;`);

    // When the agent acknowledges its current delivery cursor
    await reviews.update(session.id, false, (current) => { current.acknowledged = current.humanSequence; });

    // Then it still refers to the original capture
    expect((await reviews.get(session.id)).snapshot.snapshotId).toBe(session.snapshot.snapshotId);
  });

  test("a held refresh permits comments and cannot replace a newer refresh", async () => {
    // Given a review with an older capture held at the provider
    const session = await reviews.start(snapshot("workspace"), "conversation");
    const held = Promise.withResolvers<LocalReview>();
    const entered = Promise.withResolvers<void>();
    const older = reviews.refresh(session.id, async () => { entered.resolve(); return held.promise; });
    const outcome = older.catch((error: Error) => error.message);
    await entered.promise;

    // When a comment and a newer capture finish before that provider response
    await reviews.update(session.id, true, (current) => {
      const posted = thread();
      appendMessage(current, posted, "user", "Keep this feedback");
      current.threads.push(posted);
    });
    await reviews.refresh(session.id, async () => ({ ...snapshot("workspace"), patch: "newest capture" }));
    held.resolve({ ...snapshot("workspace"), patch: "superseded capture" });
    await outcome;

    // Then the latest capture and independently saved feedback remain visible
    expect(await reviews.get(session.id)).toMatchObject({ snapshot: { patch: "newest capture" }, threads: [{ messages: [{ body: "Keep this feedback" }] }] });
  });

  test("a failed capture leaves the accepted snapshot intact", async () => {
    // Given an accepted snapshot
    const session = await reviews.start(snapshot("workspace"), "conversation");

    // When the provider disconnects during refresh
    await reviews.refresh(session.id, async () => { throw new Error("Provider offline"); }).catch(() => {});

    // Then the previous immutable capture remains selected
    expect((await reviews.get(session.id)).snapshot).toEqual(session.snapshot);
  });

  test("refresh retains the previous immutable capture", async () => {
    // Given a session referencing a captured patch
    const session = await reviews.start(snapshot("workspace"), "conversation");

    // When a new snapshot is accepted
    await reviews.refresh(session.id, async () => ({ ...snapshot("workspace"), patch: "new patch" }));

    // Then the original snapshot is independently readable
    expect(readSnapshot(storage.db, session.snapshot.snapshotId!)).toEqual(session.snapshot);
  });

  test("agents share canonical messages but acknowledge feedback independently", async () => {
    // Given two agents attached to the same durable review
    const captured = snapshot("workspace");
    captured.identity = await reviewIdentity(storage, "jj/workspace/shared");
    captured.progressScope = "shared";
    const first = await reviews.start(captured, "first");
    const second = await reviews.start(captured, "second");
    // And a browser comment in the shared discussion
    await updateDiscussion(storage, first.discussionScope!, (discussion) => { discussion.threads.push(thread("Feedback")); });

    // When only the first agent acknowledges it
    const delivered = await reviews.get(first.id);
    await reviews.update(first.id, false, (current) => { current.acknowledged = delivered.humanSequence; });
    const pending = await reviews.get(second.id);

    // Then the other agent still has pending feedback from the one canonical message
    expect(pending).toMatchObject({ acknowledged: 0, humanSequence: 1, threads: [{ messages: [{ id: "message", body: "Feedback" }] }] });
    expect(storage.db.query("SELECT id,body FROM review_messages").all()).toEqual([{ id: "message", body: "Feedback" }]);
  });

  test("message edits and deletions advance feedback without copying message bodies", async () => {
    // Given delivered canonical feedback
    const session = await reviews.start(snapshot("workspace"), "conversation");
    await updateDiscussion(storage, session.discussionScope!, (discussion) => { discussion.threads.push(thread("Original")); });
    await reviews.get(session.id);
    // And an edit delivered before deletion
    await updateDiscussion(storage, session.discussionScope!, (discussion) => { discussion.threads[0].messages[0].body = "Revised"; });
    const edited = await reviews.get(session.id);

    // When the browser deletes the last message
    await updateDiscussion(storage, session.discussionScope!, (discussion) => { discussion.threads = []; });
    const deleted = await reviews.get(session.id);

    // Then deletion remains deliverable despite no remaining message row
    expect(deleted.humanSequence).toBeGreaterThan(edited.humanSequence);
    expect(deleted.threads).toEqual([]);
  });

  test("finished sessions retain their historical discussion", async () => {
    // Given a finished conversation with feedback
    const session = await reviews.start(snapshot("workspace"), "conversation");
    await updateDiscussion(storage, session.discussionScope!, (discussion) => { discussion.threads.push(thread("Original")); });
    const finished = await reviews.update(session.id, true, (current) => { current.finished = true; });

    // When the underlying shared discussion changes later
    await updateDiscussion(storage, session.discussionScope!, (discussion) => { discussion.threads[0].messages[0].body = "Later edit"; });

    // Then reopening the ended conversation retains its frozen view
    expect((await reviews.get(session.id)).threads).toEqual(finished.threads);
  });
});

/** Two providers may use the same filesystem path; the central ID distinguishes them. */
function snapshot(workspace: string): LocalReview {
  const selected = { commit_id: "a".repeat(40), change_id: "change", description: "Review", author: { name: "Author", email: "author@example.com", timestamp: "2026-10-26T00:00:00Z" } };
  return { workspace: { id: workspace, name: "Project", path: "/home/stephen/project" }, selected, revisions: [selected], patch: "captured patch" };
}

/** Supply a canonical comment with stable IDs for independent delivery projections. */
function thread(body?: string): ReviewThread {
  return { id: "thread", humanSequence: 0, resolved: false,
    anchor: { path: "file.ts", line: 1, endLine: 1, side: "RIGHT", commitId: "a".repeat(40), excerpt: "code" },
    messages: body ? [{ id: "message", author: "user", body, createdAt: "today", sequence: 1 }] : [] };
}
