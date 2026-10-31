import type { Database } from "bun:sqlite";

interface Migration { version: number; apply: (db: Database) => void }

/** Apply future upgrades after schema.ts creates the version-19 baseline on fresh databases. */
export function migrate(db: Database, migrations: Migration[] = [
  { version: 20, apply: workspaceSnapshots },
  { version: 21, apply: reviewChangeIds },
  { version: 22, apply: reviewChanges },
  { version: 23, apply: viewedSyncErrors },
  { version: 24, apply: prCommentResolutions },
]): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY);
    INSERT OR IGNORE INTO schema_migrations (version) VALUES (19);`);
  for (const migration of migrations) db.transaction(() => {
    if (db.query("SELECT version FROM schema_migrations WHERE version=?").get(migration.version)) return;
    migration.apply(db);
    db.query("INSERT INTO schema_migrations (version) VALUES (?)").run(migration.version);
  })();
}

/** Keep personal resolution on canonical messages, separate from GitHub inline-thread state. */
function prCommentResolutions(db: Database): void {
  db.exec("ALTER TABLE review_messages ADD COLUMN biff_resolved INTEGER CHECK(biff_resolved IN (0,1));");
}

/** A comparison changing is pending work; PR-wide failures do not belong on every file. */
function viewedSyncErrors(db: Database): void {
  db.exec(`ALTER TABLE reviews ADD COLUMN viewed_sync_error TEXT;
    UPDATE review_files SET sync_error=NULL WHERE sync_error='PR changed while synchronizing Viewed flags; retrying on the next refresh';`);
}

/** Keep review attention separate from message receipts and per-hunk approvals. */
function reviewChanges(db: Database): void {
  db.exec(`ALTER TABLE pr_user_state ADD COLUMN new_changes INTEGER NOT NULL DEFAULT 0 CHECK(new_changes IN (0,1));
    ALTER TABLE pr_user_state ADD COLUMN changes_version INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE pr_user_state ADD COLUMN changes_viewer TEXT;
    ALTER TABLE pr_user_state ADD COLUMN last_review_id INTEGER REFERENCES pr_reviews(id);`);
}

/** Recover tip identities from accepted captures without reading or changing a working copy. */
function reviewChangeIds(db: Database): void {
  db.exec(`ALTER TABLE review_commits ADD COLUMN change_id TEXT;
    CREATE TABLE review_repositories (
      id INTEGER PRIMARY KEY, review_id TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
      repository TEXT NOT NULL COLLATE NOCASE, UNIQUE(review_id,repository)
    );
    CREATE INDEX review_commits_change ON review_commits(change_id) WHERE change_id IS NOT NULL;
    -- Captures contain full patches: extract and index their metadata once, not once per commit.
    CREATE TEMP TABLE observed_tip_changes (id INTEGER PRIMARY KEY,commit_sha TEXT NOT NULL UNIQUE,change_id TEXT NOT NULL);
    INSERT OR IGNORE INTO observed_tip_changes (commit_sha,change_id)
      SELECT json_extract(unit.value,'$.commit_id'), json_extract(unit.value,'$.change_id')
      FROM review_snapshots s, json_each(json_array(
        json_extract(s.snapshot_json,'$.bookmarkTip'), json_extract(s.snapshot_json,'$.tip'), json_extract(s.snapshot_json,'$.selected')
      )) unit
      WHERE json_extract(unit.value,'$.commit_id') IS NOT NULL
        AND length(json_extract(unit.value,'$.change_id'))=32 AND json_extract(unit.value,'$.change_id') NOT GLOB '*[^k-z]*';
    UPDATE review_commits SET change_id=(SELECT observed.change_id FROM observed_tip_changes observed WHERE observed.commit_sha=review_commits.commit_sha)
      WHERE commit_sha IN (SELECT commit_sha FROM observed_tip_changes);
    DROP TABLE observed_tip_changes;`);
}

/** Sessions are disposable during this upgrade; durable reviews and registrations remain intact. */
function workspaceSnapshots(db: Database): void {
  db.exec(`CREATE TABLE review_snapshots (
      id TEXT PRIMARY KEY, digest TEXT NOT NULL UNIQUE, workspace_id TEXT NOT NULL,
      captured_at TEXT NOT NULL, snapshot_json TEXT NOT NULL
    );
    CREATE INDEX review_snapshots_workspace ON review_snapshots(workspace_id);
    DROP TABLE agent_sessions;
    CREATE TABLE agent_sessions (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, agent_session TEXT NOT NULL,
      snapshot_id TEXT NOT NULL REFERENCES review_snapshots(id),
      review_id TEXT NOT NULL REFERENCES reviews(id), discussion_scope TEXT NOT NULL,
      sequence INTEGER NOT NULL, human_sequence INTEGER NOT NULL, acknowledged INTEGER NOT NULL,
      updated_at TEXT NOT NULL, finished INTEGER NOT NULL, finished_threads TEXT
    );
    CREATE INDEX agent_sessions_workspace ON agent_sessions(workspace_id,agent_session);
    CREATE TABLE agent_session_threads (
      id INTEGER PRIMARY KEY, session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
      thread_id TEXT NOT NULL, human_sequence INTEGER NOT NULL, fingerprint TEXT NOT NULL,
      UNIQUE(session_id,thread_id)
    );
    CREATE TABLE agent_session_messages (
      id INTEGER PRIMARY KEY, session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
      message_id TEXT NOT NULL, sequence INTEGER NOT NULL, body_hash TEXT NOT NULL,
      UNIQUE(session_id,message_id)
    );`);
}
