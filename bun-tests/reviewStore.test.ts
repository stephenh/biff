import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { Storage } from "../server/storage";
import { Progress } from "../server/progress";
import { ReviewStore } from "../server/reviewStore";

describe("reviewStore", () => {
  let directory: string;
  let storage: Storage;
  const id = "a".repeat(64);
  const payload = { records: [], followUps: [], followUpHeads: { pr: "head" }, githubFileReview: { repo: "example/repo", number: "1", head: "head", files: [] } };
  const metadata = { id, pr: "example/repo/1", local: { workspace: "workspace", bookmark: "" }, closed: true,
    discussionVersion: 7, commits: ["second", "first"], changes: ["change-two", "change-one"],
    bookmarkTips: ["outside-range", "first"], prHeads: ["first", "second"], commentReads: ["inline:42", "review:9", "general:1"] };

  beforeEach(async () => {
    directory = await mkdtemp("/tmp/opencode/biff-review-metadata-");
    // Start with the original schema to exercise every historical migration too.
    const db = new Database(`${directory}/biff.sqlite`);
    db.exec("CREATE TABLE review_records (id TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE review_aliases (alias TEXT PRIMARY KEY, review_id TEXT NOT NULL)");
    db.query("INSERT INTO review_records VALUES (?,?)").run(id, JSON.stringify({ ...metadata, ...payload }));
    db.query("INSERT INTO review_aliases VALUES (?,?)").run(metadata.pr, id);
    db.close();
    storage = new Storage(`${directory}/biff.sqlite`);
  });
  afterEach(async () => { await storage.close(); await rm(directory, { recursive: true, force: true }); });

  test("migration preserves identity and independent history membership across restart", async () => {
    // Given migrated local and PR history with a bookmark tip outside the selected range
    // When another startup reads the relational metadata
    await reopen();

    // Then every history retains its original membership and ordering
    expect(new ReviewStore(storage.db).get(id)).toEqual(metadata);
  });

  test("migration removes extracted fields while preserving the remaining JSON", () => {
    // Given migrated review metadata
    // When the remaining payload is inspected
    const row = storage.db.query<{ value: string }, [string]>("SELECT value FROM reviews WHERE id=?").get(id)!;

    // Then only the deferred collections remain in JSON
    expect(JSON.parse(row.value)).toEqual({ records: payload.records, githubFileReview: payload.githubFileReview });
  });

  test("read acknowledgements use relational receipts after restart", async () => {
    // Given existing receipts for inline comments, submitted reviews, and general comments
    const progress = new Progress(storage);

    // When a duplicate and a new acknowledgement are saved through the PR alias
    await progress.commentReads(metadata.pr, ["inline:42", "general:2"]);
    await reopen();

    // Then the synchronous dashboard projection sees each receipt exactly once
    expect(new Progress(storage).commentReadSnapshot(metadata.pr)).toEqual([...metadata.commentReads, "general:2"]);
  });

  test("unrelated saves preserve synthetic history and receipt IDs", async () => {
    // Given migrated child rows
    const before = storage.db.query("SELECT * FROM review_commits ORDER BY id").all();
    const receipts = storage.db.query("SELECT * FROM review_comment_reads ORDER BY id").all();

    // When an unrelated viewed-file retry state changes
    await new Progress(storage).saveGitHubFileReview(metadata.pr, { ...payload.githubFileReview, head: "new-head" });

    // Then the existing relational identities remain stable
    expect(storage.db.query("SELECT * FROM review_commits ORDER BY id").all()).toEqual(before);
    expect(storage.db.query("SELECT * FROM review_comment_reads ORDER BY id").all()).toEqual(receipts);
  });

  test("a receipt failure rolls back newly allocated review identity and alias", async () => {
    // Given a rejected receipt write
    storage.db.exec("CREATE TRIGGER reject_receipt BEFORE INSERT ON review_comment_reads BEGIN SELECT RAISE(ABORT, 'rejected'); END");
    const progress = new Progress(storage);

    // When a new review cannot persist its first acknowledgement
    await progress.commentReads("example/repo/2", ["general:2"]).catch(() => {});

    // Then no partial lifetime or alias is committed
    expect(storage.db.query("SELECT id FROM reviews").all()).toEqual([{ id }]);
    expect(storage.db.query("SELECT alias FROM review_aliases ORDER BY alias").all()).toEqual([{ alias: metadata.pr }]);
  });

  /** Reopen the physical database to verify durable state rather than cached service objects. */
  async function reopen() {
    await storage.close();
    storage = new Storage(`${directory}/biff.sqlite`);
  }
});
