import type { Database } from "bun:sqlite";
import type { FollowUp, ThreadFollowUp } from "../shared/followUps";
import { hunkIdentity, type LogicalHunk } from "./logicalHunks";

/** Use the same source-specific presence for sidebar lists and inbox counts. */
export function readFollowUps(db: Database, review: string, source: "local" | "pr"): FollowUp[] {
  const head = source === "local" ? "local_head" : "pr_head";
  const hunks: FollowUp[] = db.query<LogicalHunk, [string]>(`SELECT * FROM logical_hunks WHERE review_id=? AND follow_up=1 AND ${head} IS NOT NULL ORDER BY rowid`).all(review)
    .map((row) => ({ ...hunkIdentity(row), type: "hunk", source, head: row[head]! }));
  const threads = db.query<{ id: string; kind: string | null; thread_key: string | null; github_id: number | null; label: string | null; path: string; side: "LEFT" | "RIGHT"; line: number }, [string]>(`SELECT t.id,t.kind,t.thread_key,
    (SELECT github_id FROM review_messages WHERE thread_id=t.id AND github_kind='inline_comment' ORDER BY sequence,rowid LIMIT 1) AS github_id,
    COALESCE((SELECT body FROM review_messages WHERE thread_id=t.id AND body_known=1 ORDER BY sequence,rowid LIMIT 1),a.excerpt) AS label,
    COALESCE(p.path,a.path) AS path,COALESCE(p.side,a.side) AS side,COALESCE(p.line,a.line) AS line
    FROM review_threads t JOIN thread_anchors a ON a.id=(SELECT max(id) FROM thread_anchors WHERE thread_id=t.id)
    LEFT JOIN thread_attachments p ON p.thread_id=t.id WHERE t.review_id=? AND t.follow_up=1 ORDER BY t.rowid`).all(review);
  return [...hunks, ...threads.map((row): ThreadFollowUp => {
    const githubId = row.github_id ?? (row.thread_key?.startsWith("inline:") ? Number(row.thread_key.slice(7)) : undefined);
    return { type: "thread", id: row.kind === "github" && githubId !== undefined ? `github:${githubId}` : `local:${row.id}`,
      label: row.label?.slice(0, 120) || "Thread", location: { path: row.path, side: row.side, line: row.line },
      ...(githubId === undefined ? {} : { githubId }) };
  })];
}

/**
 * Attach a flag to canonical discussion identity, preserving anchor evidence if hydration is pending.
 *
 * A placeholder has no invented message body. GitHub hydration reuses its thread key and supplies real messages.
 */
export function flagThread(db: Database, review: string, flag: ThreadFollowUp, enabled: boolean): void {
  const local = flag.id.startsWith("local:");
  const remoteId = local ? null : Number(flag.id.slice(7));
  let row = local
    ? db.query<{ id: string }, [string, string]>("SELECT id FROM review_threads WHERE review_id=? AND id=?").get(review, flag.id.slice(6))
    : db.query<{ id: string }, [string, number, string]>(`SELECT t.id FROM review_threads t WHERE t.review_id=? AND
      (EXISTS (SELECT 1 FROM review_messages m WHERE m.thread_id=t.id AND m.github_kind='inline_comment' AND m.github_id=?) OR t.thread_key=?) LIMIT 1`).get(review, remoteId!, `inline:${remoteId}`);
  if (!row && !enabled) return;
  if (!row && local) throw new Error("Thread not found");
  if (!row) {
    row = { id: crypto.randomUUID() };
    db.query("INSERT INTO review_threads (id,review_id,kind,resolved,human_sequence,thread_key) VALUES (?,?,'github',0,0,?)")
      .run(row.id, review, `inline:${remoteId}`);
  }
  if (!db.query("SELECT id FROM thread_anchors WHERE thread_id=?").get(row.id)) {
    db.query("INSERT INTO thread_anchors (thread_id,path,side,line,end_line,commit_id,excerpt) VALUES (?,?,?,?,?,'',?)")
      .run(row.id, flag.location.path, flag.location.side, flag.location.line, flag.location.line, flag.label);
  }
  db.query("UPDATE review_threads SET follow_up=? WHERE id=?").run(Number(enabled), row.id);
}
