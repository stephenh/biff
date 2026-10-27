import type { Database } from "bun:sqlite";

/** Create the version-19 baseline directly; subsequent schema changes belong in migrations.ts. */
export function createSchema(db: Database): void {
  db.transaction(() => db.exec(`
    CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE);
    CREATE TABLE IF NOT EXISTS agent_sessions (id TEXT PRIMARY KEY, workspace TEXT NOT NULL, updated_at TEXT NOT NULL, value TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS agent_sessions_workspace ON agent_sessions(workspace);

    CREATE TABLE IF NOT EXISTS reviews (
      id TEXT PRIMARY KEY, pr TEXT, local_workspace TEXT, local_bookmark TEXT,
      closed INTEGER NOT NULL DEFAULT 0 CHECK(closed IN (0,1)), discussion_version INTEGER NOT NULL DEFAULT 0,
      local_reconciled_head TEXT, pr_reconciled_head TEXT, viewed_sync_head TEXT, viewed_sync_base TEXT, pr_reconciled_base TEXT
    );
    CREATE TABLE IF NOT EXISTS review_aliases (
      alias TEXT PRIMARY KEY, review_id TEXT NOT NULL REFERENCES reviews(id) DEFERRABLE INITIALLY DEFERRED
    );
    CREATE TABLE IF NOT EXISTS local_reviews (
      scope TEXT PRIMARY KEY, review_id TEXT NOT NULL REFERENCES reviews(id) DEFERRABLE INITIALLY DEFERRED
    );
    CREATE TABLE IF NOT EXISTS review_commits (
      id INTEGER PRIMARY KEY, review_id TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
      commit_sha TEXT NOT NULL, commit_position INTEGER, bookmark_tip_position INTEGER, pr_head_position INTEGER,
      UNIQUE(review_id,commit_sha), CHECK(commit_position IS NOT NULL OR bookmark_tip_position IS NOT NULL OR pr_head_position IS NOT NULL)
    );
    CREATE TABLE IF NOT EXISTS review_changes (
      id INTEGER PRIMARY KEY, review_id TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
      change_id TEXT NOT NULL, position INTEGER NOT NULL, UNIQUE(review_id,change_id)
    );
    CREATE TABLE IF NOT EXISTS review_comment_reads (
      id INTEGER PRIMARY KEY, review_id TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
      receipt_key TEXT NOT NULL, position INTEGER NOT NULL, UNIQUE(review_id,receipt_key)
    );
    CREATE TABLE IF NOT EXISTS review_files (
      id INTEGER PRIMARY KEY, review_id TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
      path TEXT NOT NULL, github_viewed INTEGER NOT NULL CHECK(github_viewed IN (0,1)), sync_error TEXT,
      UNIQUE(review_id,path)
    );
    CREATE TABLE IF NOT EXISTS logical_hunks (
      id TEXT PRIMARY KEY, review_id TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
      path TEXT NOT NULL, hash TEXT NOT NULL, old_line INTEGER NOT NULL, new_line INTEGER NOT NULL, duplicate INTEGER NOT NULL,
      follow_up INTEGER NOT NULL DEFAULT 0 CHECK(follow_up IN (0,1)), local_head TEXT, pr_head TEXT,
      kind TEXT NOT NULL DEFAULT '' CHECK(kind IN ('','metadata')), reviewed_head TEXT,
      reviewed_at TEXT CHECK((reviewed_at IS NULL)=(reviewed_head IS NULL)),
      pr_reviewable INTEGER NOT NULL DEFAULT 1 CHECK(pr_reviewable IN (0,1))
    );
    CREATE INDEX IF NOT EXISTS logical_hunks_identity ON logical_hunks(review_id,path,hash);

    CREATE TABLE IF NOT EXISTS review_threads (
      id TEXT PRIMARY KEY, review_id TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
      kind TEXT CHECK(kind IN ('review','github')), discarded INTEGER NOT NULL DEFAULT 0,
      resolved INTEGER NOT NULL, human_sequence INTEGER NOT NULL, forked_from TEXT,
      discussion_kind TEXT NOT NULL DEFAULT 'inline' CHECK(discussion_kind IN ('inline','general')), thread_key TEXT,
      follow_up INTEGER NOT NULL DEFAULT 0 CHECK(follow_up IN (0,1))
    );
    CREATE INDEX IF NOT EXISTS review_threads_review ON review_threads(review_id);
    CREATE INDEX IF NOT EXISTS review_threads_key ON review_threads(review_id,thread_key);
    CREATE TABLE IF NOT EXISTS review_messages (
      id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES review_threads(id) ON DELETE CASCADE,
      author TEXT NOT NULL, login TEXT, body TEXT NOT NULL, created_at TEXT NOT NULL, sequence INTEGER NOT NULL,
      publication_pending INTEGER NOT NULL DEFAULT 0, github_pr TEXT,
      github_kind TEXT NOT NULL DEFAULT 'inline_comment' CHECK(github_kind IN ('inline_comment','issue_comment')),
      github_id INTEGER, github_url TEXT, published_at TEXT, remote_deleted_at TEXT,
      body_known INTEGER NOT NULL DEFAULT 1 CHECK(body_known IN (0,1)), UNIQUE(github_pr,github_kind,github_id)
    );
    CREATE INDEX IF NOT EXISTS review_messages_thread ON review_messages(thread_id,sequence);
    CREATE TABLE IF NOT EXISTS thread_anchors (
      id INTEGER PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES review_threads(id) ON DELETE CASCADE,
      hunk_id TEXT REFERENCES logical_hunks(id), path TEXT NOT NULL, side TEXT NOT NULL CHECK(side IN ('LEFT','RIGHT')),
      line INTEGER NOT NULL, end_line INTEGER NOT NULL, commit_id TEXT NOT NULL, base_commit_id TEXT,
      excerpt TEXT NOT NULL, file_hash TEXT, old_path TEXT, line_offset INTEGER, selected_text TEXT, selected_line_count INTEGER,
      hunk_old_line INTEGER, hunk_new_line INTEGER, hunk_duplicate INTEGER
    );
    CREATE INDEX IF NOT EXISTS thread_anchors_thread ON thread_anchors(thread_id,id);
    CREATE TABLE IF NOT EXISTS thread_attachments (
      thread_id TEXT PRIMARY KEY REFERENCES review_threads(id) ON DELETE CASCADE,
      path TEXT NOT NULL, side TEXT NOT NULL CHECK(side IN ('LEFT','RIGHT')), line INTEGER NOT NULL, end_line INTEGER NOT NULL,
      commit_id TEXT NOT NULL, base_commit_id TEXT NOT NULL, matched INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS review_draft_state (
      review_id TEXT PRIMARY KEY REFERENCES reviews(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
      version INTEGER NOT NULL, body TEXT NOT NULL, commit_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS review_draft_receipts (
      review_id TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
      kind TEXT NOT NULL CHECK(kind IN ('import','publication')), token TEXT NOT NULL, PRIMARY KEY(review_id,kind,token)
    );
    CREATE TABLE IF NOT EXISTS thread_comparisons (
      review_id TEXT PRIMARY KEY REFERENCES reviews(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
      head TEXT NOT NULL, base TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS repositories (id TEXT PRIMARY KEY COLLATE NOCASE, users_fetched_at INTEGER);
    CREATE TABLE IF NOT EXISTS repository_users (
      id INTEGER PRIMARY KEY, repository_id TEXT NOT NULL COLLATE NOCASE REFERENCES repositories(id) ON DELETE CASCADE,
      login TEXT NOT NULL COLLATE NOCASE, name TEXT, UNIQUE(repository_id,login)
    );
    CREATE TABLE IF NOT EXISTS prs (
      id TEXT PRIMARY KEY, number INTEGER NOT NULL, title TEXT NOT NULL, url TEXT NOT NULL,
      repository TEXT NOT NULL COLLATE NOCASE REFERENCES repositories(id), author TEXT NOT NULL,
      is_draft INTEGER NOT NULL CHECK(is_draft IN (0,1)), updated_at TEXT NOT NULL, created_at TEXT,
      activity_updated TEXT, activity_error TEXT, head_sha TEXT, head_author TEXT, review_decision TEXT,
      review_requested INTEGER CHECK(review_requested IN (0,1)), checks TEXT, discussion_version INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS prs_repository ON prs(repository);
    CREATE TABLE IF NOT EXISTS pr_reviews (
      id INTEGER PRIMARY KEY, pr_id TEXT NOT NULL REFERENCES prs(id) ON DELETE CASCADE,
      github_id INTEGER NOT NULL, login TEXT NOT NULL, state TEXT, body TEXT,
      has_body INTEGER CHECK(has_body IN (0,1)), submitted_at TEXT, commit_sha TEXT, url TEXT, remote_deleted_at TEXT,
      UNIQUE(pr_id,github_id)
    );
    CREATE TABLE IF NOT EXISTS pr_approvers (
      id INTEGER PRIMARY KEY, pr_id TEXT NOT NULL REFERENCES prs(id) ON DELETE CASCADE,
      login TEXT NOT NULL COLLATE NOCASE, UNIQUE(pr_id,login)
    );
    CREATE TABLE IF NOT EXISTS pr_user_state (
      id TEXT PRIMARY KEY, archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)),
      restored_until INTEGER NOT NULL DEFAULT 0, snooze_until INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS undo (
      token TEXT PRIMARY KEY, id TEXT NOT NULL,
      before_archived INTEGER NOT NULL CHECK(before_archived IN (0,1)), before_restored_until INTEGER NOT NULL, before_snooze_until INTEGER NOT NULL,
      after_archived INTEGER NOT NULL CHECK(after_archived IN (0,1)), after_restored_until INTEGER NOT NULL, after_snooze_until INTEGER NOT NULL,
      expires INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS inbox_preferences (queue_view TEXT PRIMARY KEY, repository TEXT NOT NULL DEFAULT '');
    CREATE TABLE IF NOT EXISTS inbox_tracked_prs (
      id TEXT PRIMARY KEY, view TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'OPEN', closed_at INTEGER, archived_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS inbox_queues (
      id INTEGER PRIMARY KEY, queue_view TEXT NOT NULL UNIQUE CHECK(queue_view IN ('authored','requested')),
      updated_at INTEGER NOT NULL, error TEXT
    );
    CREATE TABLE IF NOT EXISTS inbox_queue_prs (
      id INTEGER PRIMARY KEY, queue_id INTEGER NOT NULL REFERENCES inbox_queues(id) ON DELETE CASCADE,
      pr_id TEXT NOT NULL REFERENCES prs(id), UNIQUE(queue_id,pr_id)
    );
  `))();
}
