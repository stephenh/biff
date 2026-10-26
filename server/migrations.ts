import type { Database } from "bun:sqlite";
import type { ReviewedChange } from "../shared/progress";
import { HunkApprovals } from "./hunkApprovals";

/** Apply ordered, transactional upgrades after the original base schema exists. */
export function migrate(db: Database) {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY)");
  // Version 2 briefly introduced comparison receipts. Keep its number retired on existing databases.
  const migrations = [{ version: 1, apply: extractHunkApprovals }, { version: 3, apply: removeComparisonKey }, { version: 4, apply: extractPreferences }, { version: 5, apply: extractInboxState }, { version: 6, apply: renameInboxPreferences }, { version: 7, apply: extractRepositoryUsers }];
  for (const migration of migrations) db.transaction(() => {
    const { version } = migration;
    if (db.query("SELECT version FROM schema_migrations WHERE version=?").get(version)) return;
    migration.apply(db);
    db.query("INSERT INTO schema_migrations(version) VALUES (?)").run(version);
  })();
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

/** Keep legacy file evidence until an exact loaded comparison can translate it safely. */
function extractHunkApprovals(db: Database) {
  db.exec(`CREATE TABLE hunk_approvals (
    review_id TEXT NOT NULL REFERENCES review_records(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    path TEXT NOT NULL, hash TEXT NOT NULL, old_line INTEGER NOT NULL, new_line INTEGER NOT NULL,
    duplicate INTEGER NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('', 'metadata')),
    head TEXT NOT NULL, reviewed_at TEXT NOT NULL,
    PRIMARY KEY(review_id,path,hash,old_line,new_line,kind)
  )`);
  const approvals = new HunkApprovals(db);
  for (const row of db.query<{ id: string; value: string }, []>("SELECT id,value FROM review_records").all()) {
    const value = JSON.parse(row.value) as { records?: ReviewedChange[] };
    for (const record of value.records ?? []) if (record.kind !== "file") approvals.insert(row.id, record);
    value.records = (value.records ?? []).filter((record) => record.kind === "file");
    db.query("UPDATE review_records SET value=? WHERE id=?").run(JSON.stringify(value), row.id);
  }
}
