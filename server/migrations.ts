import type { Database } from "bun:sqlite";

interface Migration { version: number; apply: (db: Database) => void }

/** Apply future upgrades after schema.ts creates the version-19 baseline on fresh databases. */
export function migrate(db: Database, migrations: Migration[] = [
  { version: 20, apply: workspaceSnapshots },
]): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY);
    INSERT OR IGNORE INTO schema_migrations (version) VALUES (19);`);
  for (const migration of migrations) db.transaction(() => {
    if (db.query("SELECT version FROM schema_migrations WHERE version=?").get(migration.version)) return;
    migration.apply(db);
    db.query("INSERT INTO schema_migrations (version) VALUES (?)").run(migration.version);
  })();
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
