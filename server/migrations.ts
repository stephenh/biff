import type { Database } from "bun:sqlite";
import type { ReviewedChange } from "../shared/progress";
import { DiscussionThreads } from "./discussionThreads";
import type { ReviewThread } from "../shared/localReview";
import { PrActivity } from "./prActivity";
import type { PullActivity } from "../shared/inbox";
import { ReviewStore, reviewMetadataValue, type ReviewMetadata } from "./reviewStore";
import type { FollowUp } from "../shared/followUps";
import { logicalHunk, reviewHunk } from "./logicalHunks";
import { flagThread } from "./followUps";

/** Apply ordered, transactional upgrades after the original base schema exists. */
export function migrate(db: Database) {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY)");
  // Version 2 briefly introduced comparison receipts. Keep its number retired on existing databases.
  const migrations = [{ version: 1, apply: extractHunkApprovals }, { version: 3, apply: removeComparisonKey }, { version: 4, apply: extractPreferences }, { version: 5, apply: extractInboxState }, { version: 6, apply: renameInboxPreferences }, { version: 7, apply: extractRepositoryUsers }, { version: 8, apply: extractDiscussionThreads }, { version: 9, apply: extractInboxQueues }, { version: 10, apply: removeActivityViewer }, { version: 11, apply: extractPrActivity }, { version: 12, apply: renameAgentSessions }, { version: 13, apply: renameReviews }, { version: 14, apply: extractReviewMetadata }, { version: 15, apply: extractFollowUps }, { version: 16, apply: removeLegacyFileApprovals }, { version: 17, apply: unifyHunkApprovals }];
  for (const migration of migrations) db.transaction(() => {
    const { version } = migration;
    if (db.query("SELECT version FROM schema_migrations WHERE version=?").get(version)) return;
    migration.apply(db);
    db.query("INSERT INTO schema_migrations(version) VALUES (?)").run(version);
  })();
}

/** Move approval evidence onto canonical review units without changing their comment identities. */
function unifyHunkApprovals(db: Database) {
  db.exec(`ALTER TABLE logical_hunks ADD COLUMN kind TEXT NOT NULL DEFAULT '' CHECK(kind IN ('','metadata'));
    ALTER TABLE logical_hunks ADD COLUMN reviewed_head TEXT;
    ALTER TABLE logical_hunks ADD COLUMN reviewed_at TEXT CHECK((reviewed_at IS NULL)=(reviewed_head IS NULL));`);
  const rows = db.query<{ review_id: string; path: string; hash: string; old_line: number; new_line: number; duplicate: number; kind: string; head: string; reviewed_at: string }, []>(
    "SELECT * FROM hunk_approvals ORDER BY reviewed_at,rowid").all();
  for (const row of rows) reviewHunk(db, row.review_id, {
    path: row.path, hash: row.hash, oldLine: row.old_line, newLine: row.new_line, duplicate: Boolean(row.duplicate),
    ...(row.kind === "metadata" ? { kind: "metadata" as const } : {}),
  }, row.head, row.reviewed_at);
  db.exec(`DROP TABLE hunk_approvals;
    UPDATE reviews SET local_reconciled_head=NULL,pr_reconciled_head=NULL;`);
}

/** Retire whole-file marks; approvals already extracted into hunk_approvals remain authoritative. */
function removeLegacyFileApprovals(db: Database) {
  db.exec("UPDATE reviews SET value=json_remove(value, '$.records') WHERE json_type(value, '$.records') IS NOT NULL");
}

/**
 * Put personal flags on their canonical hunk or thread and retain known source observations.
 *
 * Old reconciliation cursors used pruning semantics, so reset them and observe each source again.
 */
function extractFollowUps(db: Database) {
  db.exec(`ALTER TABLE logical_hunks ADD COLUMN follow_up INTEGER NOT NULL DEFAULT 0 CHECK(follow_up IN (0,1));
    ALTER TABLE logical_hunks ADD COLUMN local_head TEXT;
    ALTER TABLE logical_hunks ADD COLUMN pr_head TEXT;
    ALTER TABLE review_threads ADD COLUMN follow_up INTEGER NOT NULL DEFAULT 0 CHECK(follow_up IN (0,1));
    ALTER TABLE reviews ADD COLUMN local_reconciled_head TEXT;
    ALTER TABLE reviews ADD COLUMN pr_reconciled_head TEXT;`);
  for (const row of db.query<{ id: string; value: string }, []>("SELECT id,value FROM reviews").all()) {
    const { followUps, followUpHeads, ...remaining } = JSON.parse(row.value) as { followUps?: FollowUp[]; followUpHeads?: Record<string, string> };
    for (const flag of followUps ?? []) {
      if (flag.type === "thread") flagThread(db, row.id, flag, true, true);
      else {
        const id = logicalHunk(db, row.id, flag);
        const column = flag.source === "local" ? "local_head" : "pr_head";
        db.query(`UPDATE logical_hunks SET follow_up=1,${column}=? WHERE id=?`).run(flag.head, id);
      }
    }
    db.query("UPDATE reviews SET value=? WHERE id=?").run(JSON.stringify(remaining), row.id);
  }
}

/**
 * Extract identity, linking history, and read receipts without changing the remaining payload.
 *
 * Each commit role has independent membership and order: a bookmark tip can be outside the selected range.
 */
function extractReviewMetadata(db: Database) {
  db.exec(`ALTER TABLE reviews ADD COLUMN pr TEXT;
    ALTER TABLE reviews ADD COLUMN local_workspace TEXT;
    ALTER TABLE reviews ADD COLUMN local_bookmark TEXT;
    ALTER TABLE reviews ADD COLUMN closed INTEGER NOT NULL DEFAULT 0 CHECK(closed IN (0,1));
    ALTER TABLE reviews ADD COLUMN discussion_version INTEGER NOT NULL DEFAULT 0;
    CREATE TABLE review_commits (
      id INTEGER PRIMARY KEY, review_id TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
      commit_sha TEXT NOT NULL, commit_position INTEGER, bookmark_tip_position INTEGER, pr_head_position INTEGER,
      UNIQUE(review_id,commit_sha), CHECK(commit_position IS NOT NULL OR bookmark_tip_position IS NOT NULL OR pr_head_position IS NOT NULL)
    );
    CREATE TABLE review_changes (
      id INTEGER PRIMARY KEY, review_id TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
      change_id TEXT NOT NULL, position INTEGER NOT NULL, UNIQUE(review_id,change_id)
    );
    CREATE TABLE review_comment_reads (
      id INTEGER PRIMARY KEY, review_id TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
      receipt_key TEXT NOT NULL, position INTEGER NOT NULL, UNIQUE(review_id,receipt_key)
    );`);
  const reviews = new ReviewStore(db);
  for (const row of db.query<{ id: string; value: string }, []>("SELECT id,value FROM reviews").all()) {
    const review = { ...JSON.parse(row.value), id: row.id } as ReviewMetadata;
    reviews.save(review, reviewMetadataValue(review));
  }
}

/** SQLite carries the parent rename through the existing child-table foreign keys. */
function renameReviews(db: Database) {
  db.exec("ALTER TABLE review_records RENAME TO reviews");
}

/** Name the persisted collaboration sessions explicitly without changing their payloads. */
function renameAgentSessions(db: Database) {
  db.exec(`ALTER TABLE sessions RENAME TO agent_sessions;
    DROP INDEX IF EXISTS sessions_workspace;
    CREATE INDEX agent_sessions_workspace ON agent_sessions(workspace);`);
}

/**
 * Replace cached event JSON with published comments, submitted reviews, and scalar status.
 *
 * Legacy events contain no bodies or review decisions. Keep those fields unknown until a full fetch,
 * preserving their unread evidence without fabricating human text or overwriting existing messages.
 */
function extractPrActivity(db: Database) {
  db.exec(`ALTER TABLE prs ADD COLUMN head_sha TEXT;
    ALTER TABLE prs ADD COLUMN head_author TEXT;
    ALTER TABLE prs ADD COLUMN review_decision TEXT;
    ALTER TABLE prs ADD COLUMN review_requested INTEGER CHECK(review_requested IN (0,1));
    ALTER TABLE prs ADD COLUMN checks TEXT;
    ALTER TABLE prs ADD COLUMN discussion_version INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE review_threads ADD COLUMN discussion_kind TEXT NOT NULL DEFAULT 'inline' CHECK(discussion_kind IN ('inline','general'));
    ALTER TABLE review_threads ADD COLUMN thread_key TEXT;
    CREATE INDEX review_threads_key ON review_threads(review_id,thread_key);
    CREATE TABLE review_messages_relational (
      id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES review_threads(id) ON DELETE CASCADE,
      author TEXT NOT NULL, login TEXT, body TEXT NOT NULL, created_at TEXT NOT NULL, sequence INTEGER NOT NULL,
      publication_pending INTEGER NOT NULL DEFAULT 0, github_pr TEXT,
      github_kind TEXT NOT NULL DEFAULT 'inline_comment' CHECK(github_kind IN ('inline_comment','issue_comment')),
      github_id INTEGER, github_url TEXT, published_at TEXT, remote_deleted_at TEXT,
      body_known INTEGER NOT NULL DEFAULT 1 CHECK(body_known IN (0,1)), UNIQUE(github_pr,github_kind,github_id)
    );
    INSERT INTO review_messages_relational (id,thread_id,author,login,body,created_at,sequence,publication_pending,github_pr,github_id,github_url,published_at)
      SELECT id,thread_id,author,login,body,created_at,sequence,publication_pending,github_pr,github_id,github_url,published_at FROM review_messages;
    DROP TABLE review_messages;
    ALTER TABLE review_messages_relational RENAME TO review_messages;
    CREATE INDEX review_messages_thread ON review_messages(thread_id,sequence);
    CREATE TABLE pr_reviews (
      id INTEGER PRIMARY KEY, pr_id TEXT NOT NULL REFERENCES prs(id) ON DELETE CASCADE,
      github_id INTEGER NOT NULL, login TEXT NOT NULL, state TEXT, body TEXT,
      has_body INTEGER CHECK(has_body IN (0,1)), submitted_at TEXT, commit_sha TEXT, url TEXT, remote_deleted_at TEXT,
      UNIQUE(pr_id,github_id)
    );
    CREATE TABLE pr_approvers (
      id INTEGER PRIMARY KEY, pr_id TEXT NOT NULL REFERENCES prs(id) ON DELETE CASCADE,
      login TEXT NOT NULL COLLATE NOCASE, UNIQUE(pr_id,login)
    );`);
  const activities = new PrActivity(db, "review_records");
  for (const row of db.query<{ id: string; activity: string }, []>("SELECT id,activity FROM prs WHERE activity IS NOT NULL").all()) {
    activities.save(row.id, JSON.parse(row.activity) as PullActivity, true);
  }
  // Force one complete discussion fetch to hydrate metadata-only legacy rows.
  db.exec("UPDATE prs SET activity_updated=NULL WHERE activity IS NOT NULL; ALTER TABLE prs DROP COLUMN activity;");
}

/** Authentication belongs to the running server, not to a cached PR snapshot. */
function removeActivityViewer(db: Database) {
  db.exec("UPDATE prs SET activity=json_remove(activity, '$.viewer') WHERE activity IS NOT NULL AND json_type(activity, '$.viewer') IS NOT NULL");
}

/**
 * Merge bot review requests into requested and normalize current queue membership.
 *
 * Keep durable tracking even for archived PRs absent from the discovery snapshot.
 * The older refresh timestamp ensures the merged queue is refreshed when either half was stale.
 */
function extractInboxQueues(db: Database) {
  db.exec(`CREATE TABLE inbox_queues (
      id INTEGER PRIMARY KEY, queue_view TEXT NOT NULL UNIQUE CHECK(queue_view IN ('authored', 'requested')),
      updated_at INTEGER NOT NULL, error TEXT
    );
    CREATE TABLE inbox_queue_prs (
      id INTEGER PRIMARY KEY, queue_id INTEGER NOT NULL REFERENCES inbox_queues(id) ON DELETE CASCADE,
      pr_id TEXT NOT NULL REFERENCES prs(id), UNIQUE(queue_id, pr_id)
    );
    INSERT INTO inbox_queues (queue_view, updated_at, error)
      SELECT CASE WHEN view='dependabot' THEN 'requested' ELSE view END, min(updated_at), group_concat(error, ' · ')
      FROM queues GROUP BY CASE WHEN view='dependabot' THEN 'requested' ELSE view END;
    INSERT INTO inbox_queue_prs (queue_id, pr_id)
      SELECT DISTINCT target.id, entry.value FROM queues, json_each(queues.ids) AS entry
      JOIN inbox_queues AS target ON target.queue_view=CASE WHEN queues.view='dependabot' THEN 'requested' ELSE queues.view END
      JOIN prs ON prs.id=entry.value;
    INSERT OR IGNORE INTO inbox_tracked_prs (id, view)
      SELECT entry.value, queues.view FROM queues, json_each(queues.ids) AS entry
      WHERE queues.view IN ('authored', 'requested', 'dependabot');
    UPDATE inbox_tracked_prs SET view='requested' WHERE view='dependabot';
    INSERT INTO inbox_preferences (queue_view, repository)
      SELECT 'requested', repository FROM inbox_preferences WHERE queue_view='dependabot'
      ON CONFLICT(queue_view) DO NOTHING;
    DELETE FROM inbox_preferences WHERE queue_view='dependabot';
    DROP TABLE queues;`);
}

/**
 * Move saved discussions into stable threads/messages; snapshot coordinates become anchor evidence.
 *
 * This runs in the migration transaction, so an incompatible legacy record cannot leave a half-migrated discussion.
 */
function extractDiscussionThreads(db: Database) {
  db.exec(`CREATE TABLE review_threads (
      id TEXT PRIMARY KEY, review_id TEXT NOT NULL REFERENCES review_records(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
      kind TEXT CHECK(kind IN ('review','github')), discarded INTEGER NOT NULL DEFAULT 0, resolved INTEGER NOT NULL, human_sequence INTEGER NOT NULL, forked_from TEXT
    );
    CREATE INDEX review_threads_review ON review_threads(review_id);
    CREATE TABLE logical_hunks (
      id TEXT PRIMARY KEY, review_id TEXT NOT NULL REFERENCES review_records(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
      path TEXT NOT NULL, hash TEXT NOT NULL, old_line INTEGER NOT NULL, new_line INTEGER NOT NULL, duplicate INTEGER NOT NULL
    );
    CREATE INDEX logical_hunks_identity ON logical_hunks(review_id,path,hash);
    CREATE TABLE thread_anchors (
      id INTEGER PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES review_threads(id) ON DELETE CASCADE,
      hunk_id TEXT REFERENCES logical_hunks(id), path TEXT NOT NULL, side TEXT NOT NULL CHECK(side IN ('LEFT','RIGHT')),
      line INTEGER NOT NULL, end_line INTEGER NOT NULL, commit_id TEXT NOT NULL, base_commit_id TEXT,
      excerpt TEXT NOT NULL, file_hash TEXT, old_path TEXT, line_offset INTEGER, selected_text TEXT, selected_line_count INTEGER,
      hunk_old_line INTEGER, hunk_new_line INTEGER, hunk_duplicate INTEGER
    );
    CREATE INDEX thread_anchors_thread ON thread_anchors(thread_id,id);
    CREATE TABLE thread_attachments (
      thread_id TEXT PRIMARY KEY REFERENCES review_threads(id) ON DELETE CASCADE,
      path TEXT NOT NULL, side TEXT NOT NULL CHECK(side IN ('LEFT','RIGHT')), line INTEGER NOT NULL, end_line INTEGER NOT NULL,
      commit_id TEXT NOT NULL, base_commit_id TEXT NOT NULL, matched INTEGER NOT NULL
    );
    CREATE TABLE review_messages (
      id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES review_threads(id) ON DELETE CASCADE,
      author TEXT NOT NULL, login TEXT, body TEXT NOT NULL, created_at TEXT NOT NULL, sequence INTEGER NOT NULL,
      publication_pending INTEGER NOT NULL DEFAULT 0, github_pr TEXT, github_id INTEGER, github_url TEXT, published_at TEXT,
      UNIQUE(github_pr,github_id)
    );
    CREATE INDEX review_messages_thread ON review_messages(thread_id,sequence);
    CREATE TABLE review_draft_state (
      review_id TEXT PRIMARY KEY REFERENCES review_records(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
      version INTEGER NOT NULL, body TEXT NOT NULL, commit_id TEXT NOT NULL
    );
    CREATE TABLE review_draft_receipts (
      review_id TEXT NOT NULL REFERENCES review_records(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
      kind TEXT NOT NULL CHECK(kind IN ('import','publication')), token TEXT NOT NULL, PRIMARY KEY(review_id,kind,token)
    );
    CREATE TABLE thread_comparisons (
      review_id TEXT PRIMARY KEY REFERENCES review_records(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
      head TEXT NOT NULL, base TEXT NOT NULL
    );`);
  const threads = new DiscussionThreads(db);
  for (const row of db.query<{ id: string; value: string }, []>("SELECT id,value FROM review_records").all()) {
    const value = JSON.parse(row.value) as { threads?: ReviewThread[] };
    threads.replace(row.id, value.threads ?? []);
    delete value.threads;
    db.query("UPDATE review_records SET value=? WHERE id=?").run(JSON.stringify(value), row.id);
  }
}

/**
 * Share repository identity between cached PRs and mentionable users.
 *
 * GitHub names are case-insensitive; the parent key lets PRs retain their display casing.
 * A fetched timestamp with no user rows represents a successfully fetched empty list.
 */
function extractRepositoryUsers(db: Database) {
  db.exec(`CREATE TABLE repositories (id TEXT PRIMARY KEY COLLATE NOCASE, users_fetched_at INTEGER);
    INSERT INTO repositories (id) SELECT DISTINCT lower(repository) FROM prs;
    INSERT INTO repositories (id, users_fetched_at) SELECT lower(repo), updated_at FROM repository_users WHERE true
      ON CONFLICT(id) DO UPDATE SET users_fetched_at=excluded.users_fetched_at;
    CREATE TABLE repository_users_relational (
      id INTEGER PRIMARY KEY,
      repository_id TEXT NOT NULL COLLATE NOCASE REFERENCES repositories(id) ON DELETE CASCADE,
      login TEXT NOT NULL COLLATE NOCASE, name TEXT,
      UNIQUE(repository_id, login)
    );
    INSERT INTO repository_users_relational (repository_id, login, name)
      SELECT lower(repo), json_extract(entry.value, '$.login'), json_extract(entry.value, '$.name')
      FROM repository_users, json_each(repository_users.users) AS entry WHERE true
      ON CONFLICT(repository_id, login) DO UPDATE SET name=excluded.name;
    DROP TABLE repository_users;
    ALTER TABLE repository_users_relational RENAME TO repository_users;

    CREATE TABLE prs_relational (
      id TEXT PRIMARY KEY, number INTEGER NOT NULL, title TEXT NOT NULL, url TEXT NOT NULL,
      repository TEXT NOT NULL COLLATE NOCASE REFERENCES repositories(id), author TEXT NOT NULL,
      is_draft INTEGER NOT NULL CHECK(is_draft IN (0, 1)), updated_at TEXT NOT NULL, created_at TEXT,
      activity TEXT, activity_updated TEXT, activity_error TEXT
    );
    INSERT INTO prs_relational SELECT id, number, title, url, repository, author, is_draft, updated_at, created_at,
      activity, activity_updated, activity_error FROM prs;
    DROP TABLE prs;
    ALTER TABLE prs_relational RENAME TO prs;
    CREATE INDEX prs_repository ON prs(repository);`);
}

/** Make the inbox scope explicit without changing saved repository filters. */
function renameInboxPreferences(db: Database) {
  db.exec(`ALTER TABLE preferences RENAME TO inbox_preferences;
    ALTER TABLE inbox_preferences RENAME COLUMN view TO queue_view;`);
}

/**
 * Normalize PR summaries and personal choices together with their outstanding undo receipts.
 *
 * Old Ignore intent remains Archive; retired read markers are not personal choices anymore.
 */
function extractInboxState(db: Database) {
  db.exec(`CREATE TABLE prs_relational (
      id TEXT PRIMARY KEY, number INTEGER NOT NULL, title TEXT NOT NULL, url TEXT NOT NULL,
      repository TEXT NOT NULL, author TEXT NOT NULL, is_draft INTEGER NOT NULL CHECK(is_draft IN (0, 1)),
      updated_at TEXT NOT NULL, created_at TEXT, activity TEXT, activity_updated TEXT, activity_error TEXT
    );
    INSERT INTO prs_relational
      SELECT id, json_extract(summary, '$.number'), json_extract(summary, '$.title'), json_extract(summary, '$.url'),
        json_extract(summary, '$.repository.nameWithOwner'), json_extract(summary, '$.author.login'), json_extract(summary, '$.isDraft'),
        json_extract(summary, '$.updatedAt'), json_extract(summary, '$.createdAt'), activity, activity_updated, activity_error FROM prs;
    DROP TABLE prs;
    ALTER TABLE prs_relational RENAME TO prs;

    CREATE TABLE pr_user_state_relational (
      id TEXT PRIMARY KEY, archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0, 1)),
      restored_until INTEGER NOT NULL DEFAULT 0, snooze_until INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO pr_user_state_relational
      SELECT id, COALESCE(json_extract(value, '$.archived'), json_extract(value, '$.ignored'), 0),
        COALESCE(json_extract(value, '$.restoredUntil'), 0), COALESCE(json_extract(value, '$.snoozeUntil'), 0) FROM pr_user_state;
    DROP TABLE pr_user_state;
    ALTER TABLE pr_user_state_relational RENAME TO pr_user_state;

    CREATE TABLE undo_relational (
      token TEXT PRIMARY KEY, id TEXT NOT NULL,
      before_archived INTEGER NOT NULL CHECK(before_archived IN (0, 1)), before_restored_until INTEGER NOT NULL, before_snooze_until INTEGER NOT NULL,
      after_archived INTEGER NOT NULL CHECK(after_archived IN (0, 1)), after_restored_until INTEGER NOT NULL, after_snooze_until INTEGER NOT NULL,
      expires INTEGER NOT NULL
    );
    INSERT INTO undo_relational
      SELECT token, id,
        COALESCE(json_extract(before_value, '$.archived'), json_extract(before_value, '$.ignored'), 0),
        COALESCE(json_extract(before_value, '$.restoredUntil'), 0), COALESCE(json_extract(before_value, '$.snoozeUntil'), 0),
        COALESCE(json_extract(after_value, '$.archived'), json_extract(after_value, '$.ignored'), 0),
        COALESCE(json_extract(after_value, '$.restoredUntil'), 0), COALESCE(json_extract(after_value, '$.snoozeUntil'), 0), expires FROM undo;
    DROP TABLE undo;
    ALTER TABLE undo_relational RENAME TO undo;`);
}

/** Replace the preference payload with its repository filter, retaining the all-repositories default. */
function extractPreferences(db: Database) {
  db.exec(`CREATE TABLE preferences_relational (view TEXT PRIMARY KEY, repository TEXT NOT NULL DEFAULT '');
    INSERT INTO preferences_relational (view, repository)
      SELECT view, COALESCE(json_extract(value, '$.repository'), '') FROM preferences;
    DROP TABLE preferences;
    ALTER TABLE preferences_relational RENAME TO preferences;`);
}

/** Remove the retired receipt key without changing review data or approvals. */
function removeComparisonKey(db: Database) {
  db.exec("DROP TABLE IF EXISTS comparison_key");
}

/** Extract hunk approvals from the original schema; migration 16 retires remaining whole-file evidence. */
function extractHunkApprovals(db: Database) {
  db.exec(`CREATE TABLE hunk_approvals (
    review_id TEXT NOT NULL REFERENCES review_records(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    path TEXT NOT NULL, hash TEXT NOT NULL, old_line INTEGER NOT NULL, new_line INTEGER NOT NULL,
    duplicate INTEGER NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('', 'metadata')),
    head TEXT NOT NULL, reviewed_at TEXT NOT NULL,
    PRIMARY KEY(review_id,path,hash,old_line,new_line,kind)
  )`);
  for (const row of db.query<{ id: string; value: string }, []>("SELECT id,value FROM review_records").all()) {
    const value = JSON.parse(row.value) as { records?: ReviewedChange[] };
    for (const record of value.records ?? []) if (record.kind !== "file") {
      db.query("INSERT OR REPLACE INTO hunk_approvals(review_id,path,hash,old_line,new_line,duplicate,kind,head,reviewed_at) VALUES (?,?,?,?,?,?,?,?,?)")
        .run(row.id, record.path, record.hash, record.oldLine, record.newLine, Number(record.duplicate), record.kind ?? "", record.head, record.reviewedAt);
    }
    value.records = (value.records ?? []).filter((record) => record.kind === "file");
    db.query("UPDATE review_records SET value=? WHERE id=?").run(JSON.stringify(value), row.id);
  }
}
