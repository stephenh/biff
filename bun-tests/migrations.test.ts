import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { Storage } from "../server/storage";
import { migrate } from "../server/migrations";
import { Database } from "bun:sqlite";
import { createSchema } from "../server/schema";
import { createHash } from "node:crypto";
import { identifyChanges } from "../shared/changeProgress";
import { parseInput } from "../src/patches";
import { captureHunkTexts } from "../shared/hunkText";
import { hunkApprovals, logicalHunk } from "../server/logicalHunks";
import { ensureReview } from "../server/reviewStore";

describe("migrations", () => {
  let directory: string;
  let storage: Storage;

  beforeEach(async () => {
    directory = await mkdtemp("/tmp/opencode/biff-migrations-");
    storage = new Storage(`${directory}/state.sqlite`);
  });
  afterEach(async () => { await storage.close(); await rm(directory, { recursive: true, force: true }); });

  test("fresh databases start at the consolidated baseline", () => {
    // Given a freshly initialized database
    // When its schema version is read
    const versions = storage.db.query("SELECT version FROM schema_migrations ORDER BY version").all();

    // Then historical upgrade bodies are unnecessary
    expect(versions).toEqual([{ version: 19 }, { version: 20 }, { version: 21 }, { version: 22 }, { version: 23 }, { version: 24 }, { version: 25 }, { version: 26 }, { version: 27 }, { version: 28 }, { version: 29 }, { version: 30 }, { version: 31 }]);
  });

  test("future migrations run once across restarts", async () => {
    // Given existing data and a future column migration
    storage.db.exec("INSERT INTO inbox_preferences VALUES ('authored','example/repo')");
    const migrations = [{ version: 999, apply: (db: Storage["db"]) => { db.exec("ALTER TABLE inbox_preferences ADD COLUMN extra TEXT NOT NULL DEFAULT 'retained'"); } }];
    migrate(storage.db, migrations);

    // When the daemon reopens the database and encounters the same migration
    await storage.close();
    storage = new Storage(`${directory}/state.sqlite`);
    migrate(storage.db, migrations);

    // Then the column was added once and existing data survived
    expect(storage.db.query("SELECT * FROM inbox_preferences").all()).toEqual([{ queue_view: "authored", repository: "example/repo", extra: "retained" }]);
  });

  test("failed migrations roll back their schema changes and can retry", () => {
    // Given a migration that fails after its first schema change
    const migration = { version: 999, apply: (db: Storage["db"]) => {
      db.exec("ALTER TABLE inbox_preferences ADD COLUMN extra TEXT");
      throw new Error("Interrupted upgrade");
    } };
    try { migrate(storage.db, [migration]); } catch { /* Retry the same version below. */ }

    // When a corrected migration retries the same column change
    migrate(storage.db, [{ version: 999, apply: (db) => { db.exec("ALTER TABLE inbox_preferences ADD COLUMN extra TEXT"); } }]);

    // Then only the completed upgrade is recorded
    expect(storage.db.query("SELECT version FROM schema_migrations ORDER BY version").all()).toEqual([{ version: 19 }, { version: 20 }, { version: 21 }, { version: 22 }, { version: 23 }, { version: 24 }, { version: 25 }, { version: 26 }, { version: 27 }, { version: 28 }, { version: 29 }, { version: 30 }, { version: 31 }, { version: 999 }]);
  });

  test("startup does not recreate a table retired by a future migration", async () => {
    // Given a future migration retires a baseline table
    migrate(storage.db, [{ version: 999, apply: (db) => { db.exec("DROP TABLE inbox_preferences"); } }]);

    // When the daemon restarts
    await storage.close();
    storage = new Storage(`${directory}/state.sqlite`);

    // Then baseline creation does not undo that migration
    expect(storage.db.query("SELECT name FROM sqlite_master WHERE name='inbox_preferences'").all()).toEqual([]);
  });

  test("the snapshot upgrade discards old agent sessions while retaining durable reviews", () => {
    // Given a version-19 database with a disposable session and a durable review
    const db = new Database(":memory:");
    try {
      createSchema(db);
      db.exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY);
        INSERT INTO schema_migrations VALUES (19);
        INSERT INTO reviews (id) VALUES ('review');
        INSERT INTO workspaces VALUES ('workspace','Project','/project');
        INSERT INTO agent_sessions VALUES ('old-session','/project','today','{}');`);

      // When the new schema is applied
      migrate(db);

      // Then durable ownership survives while old session URLs are intentionally retired
      expect(db.query("SELECT id FROM reviews").all()).toEqual([{ id: "review" }]);
      expect(db.query("SELECT * FROM workspaces").all()).toEqual([{ id: "workspace", name: "Project", path: "/project" }]);
      expect(db.query("SELECT id FROM agent_sessions").all()).toEqual([]);
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally { db.close(); }
  });

  test("change-ID upgrades recover old bookmark-tip evidence from accepted snapshots", () => {
    // Given a version-20 database with an old local tip and its immutable capture
    const db = new Database(":memory:");
    try {
      createSchema(db);
      db.exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY);
        INSERT INTO schema_migrations VALUES (19),(20);
        CREATE TABLE review_snapshots (id TEXT PRIMARY KEY,snapshot_json TEXT NOT NULL);
        INSERT INTO reviews (id,local_workspace) VALUES ('local','workspace');
        INSERT INTO review_commits (id,review_id,commit_sha,bookmark_tip_position) VALUES (42,'local','old-head',0);`);
      db.query("INSERT INTO review_snapshots VALUES (?,?)").run("capture", JSON.stringify({ bookmarkTip: { commit_id: "old-head", change_id: "k".repeat(32) }, tip: { commit_id: "newer-head", change_id: "l".repeat(32) } }));

      // When the upgrade runs without consulting the now-amended working copy
      migrate(db);

      // Then the original row gains the original tip's stable identity
      expect(db.query("SELECT id,commit_sha,change_id FROM review_commits").all()).toEqual([{ id: 42, commit_sha: "old-head", change_id: "k".repeat(32) }]);
    } finally { db.close(); }
  });

  test("the waiting upgrade preserves old personal state without inventing a handoff", () => {
    // Given a database from before Waiting with an archived, snoozed PR
    const db = new Database(":memory:");
    try {
      createSchema(db);
      db.exec("INSERT INTO pr_user_state (id,archived,snooze_until) VALUES ('example/repo/1',1,123)");
      // When all outstanding migrations run
      migrate(db);
      // Then Waiting defaults to false without changing the user's choices
      expect(db.query("SELECT archived,snooze_until,waiting_on_author FROM pr_user_state").get()).toEqual({ archived: 1, snooze_until: 123, waiting_on_author: 0 });
    } finally { db.close(); }
  });

  test("the seen upgrade preserves legacy history without retaining untouched local hunks", () => {
    // Given a pre-upgrade capture and a local hunk with no encounter evidence
    storage.db.exec(`ALTER TABLE logical_hunks DROP COLUMN seen_at;
      DELETE FROM schema_migrations WHERE version=29;
      INSERT INTO reviews (id) VALUES ('review');
      INSERT INTO logical_hunks (id,review_id,path,hash,old_line,new_line,duplicate) VALUES
        ('captured','review','file.ts','old',1,1,0),('untouched','review','file.ts','local',2,2,0);
      INSERT INTO logical_hunk_observations (logical_hunk_id,comparison_head_sha,comparison_base_sha,observed_at,old_line,new_line)
        VALUES ('captured','head','base','2026-11-01T12:00:00Z',1,1);`);
    // When the encounter upgrade runs
    migrate(storage.db);
    // Then old history remains retained without inventing local encounters
    expect(storage.db.query("SELECT id,seen_at FROM logical_hunks ORDER BY id").all()).toEqual([
      { id: "captured", seen_at: "2026-11-01T12:00:00Z" }, { id: "untouched", seen_at: null },
    ]);
  });

  test("the indentation upgrade preserves captured hunk IDs and review state", async () => {
    // Given an approved, seen, flagged edit with its original exact-text fingerprint
    const scope = "example/repo/1";
    const review = ensureReview(storage.db, scope);
    const oldHash = legacyHash(["  before();\n"], ["  after();\n"]);
    storage.db.query(`INSERT INTO logical_hunks
      (id,review_id,path,hash,old_line,new_line,duplicate,diff_text,reviewed_head,reviewed_at,follow_up,seen_at,since_review)
      VALUES ('captured',?,'file.ts',?,1,1,0,?,'head','2026-11-01',1,'2026-10-31','existing')`)
      .run(review.id, oldHash, "-  before();\n+  after();\n");
    // When the upgrade runs and the same edit is subsequently re-indented
    rerunIndentationMigration(storage.db);
    const [current] = await identifyChanges(parseInput(migrationPatch("\t")));
    const id = logicalHunk(storage.db, review.id, current);
    // Then the existing entity and all its review evidence survive
    expect(storage.db.query("SELECT id,reviewed_head,reviewed_at,follow_up,seen_at,since_review FROM logical_hunks WHERE id=?").get(id))
      .toEqual({ id: "captured", reviewed_head: "head", reviewed_at: "2026-11-01", follow_up: 1, seen_at: "2026-10-31", since_review: "existing" });
  });

  test("the indentation upgrade leaves legacy missing text and metadata alone", () => {
    // Given a legacy textless hunk and a metadata review unit
    storage.db.exec(`INSERT INTO reviews (id) VALUES ('review');
      INSERT INTO logical_hunks (id,review_id,path,hash,old_line,new_line,duplicate,kind,diff_text) VALUES
      ('legacy','review','file.ts','legacy-hash',1,1,0,'',NULL),
      ('metadata','review','file.ts','metadata-hash',0,0,0,'metadata','old mode 100644\\nnew mode 100755\\n');`);
    // When captured text fingerprints are upgraded
    rerunIndentationMigration(storage.db);
    // Then neither unsupported record is reinterpreted
    expect(storage.db.query("SELECT id,hash FROM logical_hunks ORDER BY id").all())
      .toEqual([{ id: "legacy", hash: "legacy-hash" }, { id: "metadata", hash: "metadata-hash" }]);
  });

  test("the indentation upgrade does not spread approvals across newly identical edits", async () => {
    // Given two differently indented occurrences, only one approved
    const scope = "example/repo/1";
    const review = ensureReview(storage.db, scope);
    for (const [index, indent] of ["  ", "\t"].entries()) {
      storage.db.query(`INSERT INTO logical_hunks
        (id,review_id,path,hash,old_line,new_line,duplicate,diff_text,reviewed_head,reviewed_at)
        VALUES (?,?, 'file.ts',?,?,?,0,?,?,?)`)
        .run(`hunk-${index}`, review.id, legacyHash([`${indent}before();\n`], [`${indent}after();\n`]),
          1 + index * 19, 1 + index * 19, `-${indent}before();\n+${indent}after();\n`,
          index === 0 ? "head" : null, index === 0 ? "2026-11-01" : null);
    }
    // When normalization makes both occurrences share a fingerprint
    rerunIndentationMigration(storage.db);
    const patch = migrationPatch("") + "@@ -20 +20 @@\n-    before();\n+    after();\n";
    const blocks = await identifyChanges(parseInput(patch));
    const ids = blocks.map((block) => logicalHunk(storage.db, review.id, block));
    // Then each occurrence still has its own entity and approval
    expect(storage.db.query("SELECT id,duplicate,reviewed_at FROM logical_hunks ORDER BY old_line").all())
      .toEqual([{ id: ids[0], duplicate: 1, reviewed_at: "2026-11-01" }, { id: ids[1], duplicate: 1, reviewed_at: null }]);
  });

  test("the indentation upgrade merges same-position variants without dropping anchors or observations", async () => {
    // Given two historical indentation variants at the same coordinates
    const review = ensureReview(storage.db, "example/repo/1");
    for (const [index, indent] of ["  ", "\t"].entries()) {
      storage.db.query(`INSERT INTO logical_hunks
        (id,review_id,path,hash,old_line,new_line,duplicate,diff_text,reviewed_head,reviewed_at)
        VALUES (?,?, 'file.ts',?,1,1,0,?,?,?)`)
        .run(`hunk-${index}`, review.id, legacyHash([`${indent}before();\n`], [`${indent}after();\n`]),
          `-${indent}before();\n+${indent}after();\n`, index === 1 ? "head" : null, index === 1 ? "2026-11-01" : null);
      storage.db.query(`INSERT INTO logical_hunk_observations
        (logical_hunk_id,comparison_head_sha,comparison_base_sha,old_line,new_line) VALUES (?,?,'base',1,1)`)
        .run(`hunk-${index}`, `head-${index}`);
    }
    // And a comment references the later variant
    storage.db.query("INSERT INTO review_threads (id,review_id,resolved,human_sequence) VALUES ('thread',?,0,0)").run(review.id);
    storage.db.exec(`INSERT INTO thread_anchors (thread_id,hunk_id,path,side,line,end_line,commit_id,excerpt)
      VALUES ('thread','hunk-1','file.ts','RIGHT',1,1,'head','excerpt');`);
    // When the identities converge
    rerunIndentationMigration(storage.db);
    // Then the comment still references the canonical surviving hunk
    expect(storage.db.query("SELECT hunk_id FROM thread_anchors").all()).toEqual([{ hunk_id: "hunk-0" }]);
    expect(storage.db.query("SELECT logical_hunk_id,comparison_head_sha FROM logical_hunk_observations ORDER BY comparison_head_sha").all())
      .toEqual([{ logical_hunk_id: "hunk-0", comparison_head_sha: "head-0" }, { logical_hunk_id: "hunk-0", comparison_head_sha: "head-1" }]);
    expect(await hunkApprovals(storage, review.id)).toMatchObject([{ head: "head", reviewedAt: "2026-11-01" }]);
    expect(storage.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  test("the indentation upgrade preserves absent-final-newline fingerprints", async () => {
    // Given a captured replacement without a final newline on either side
    const files = parseInput(migrationPatch("  ").replace("-  before();\n", "-  before();\n\\ No newline at end of file\n")
      .replace("+  after();\n", "+  after();\n\\ No newline at end of file\n"));
    const blocks = await identifyChanges(files);
    const text = captureHunkTexts(files, blocks).get(blocks[0])!;
    storage.db.exec("INSERT INTO reviews (id) VALUES ('review')");
    storage.db.query(`INSERT INTO logical_hunks (id,review_id,path,hash,old_line,new_line,duplicate,diff_text)
      VALUES ('captured','review','file.ts',?,1,1,0,?)`)
      .run(legacyHash(["  before();"], ["  after();"]), text.diffText);
    // When stored source lines are reconstructed for the new fingerprint
    rerunIndentationMigration(storage.db);
    // Then migration and live hashing agree on the EOF evidence
    expect(storage.db.query("SELECT hash FROM logical_hunks").get()).toEqual({ hash: blocks[0].hash });
  });

  test("the indentation upgrade preserves comparison and Viewed import receipts", () => {
    // Given cached comparison and remote Viewed import bookkeeping
    storage.db.exec(`INSERT INTO reviews
      (id,local_reconciled_head,pr_reconciled_head,pr_reconciled_base,viewed_sync_head,viewed_sync_base)
      VALUES ('review','local','head','base','head','base');
      INSERT INTO thread_comparisons VALUES ('review','head','base');`);
    // When fingerprint classification changes without a new PR head
    rerunIndentationMigration(storage.db);
    // Then historical PRs need no refetch and old remote Viewed state is not imported again
    expect(storage.db.query("SELECT local_reconciled_head,pr_reconciled_head,pr_reconciled_base,viewed_sync_head,viewed_sync_base FROM reviews").get())
      .toEqual({ local_reconciled_head: "local", pr_reconciled_head: "head", pr_reconciled_base: "base", viewed_sync_head: "head", viewed_sync_base: "base" });
    expect(storage.db.query("SELECT * FROM thread_comparisons").all()).toEqual([{ review_id: "review", head: "head", base: "base" }]);
  });
});

/** Exercise the real upgrade against deliberately seeded pre-upgrade data. */
function rerunIndentationMigration(db: Database): void {
  db.exec("DELETE FROM schema_migrations WHERE version=31");
  migrate(db);
}

/** Reproduce the pre-upgrade hash without normalizing any characters. */
function legacyHash(deleted: string[], added: string[]): string {
  return createHash("sha256").update(JSON.stringify([deleted, added])).digest("hex");
}

/** Keep the changed-line grouping constant while varying indentation. */
function migrationPatch(indent: string): string {
  return `diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-${indent}before();\n+${indent}after();\n`;
}
