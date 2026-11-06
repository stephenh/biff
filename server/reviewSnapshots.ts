import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { GitWorkingTree, LocalReview } from "../shared/types";

/** Accept complete captures only; subsequent session saves reference rather than rewrite them. */
export function acceptSnapshot(db: Database, snapshot: LocalReview): LocalReview {
  const captured = { ...snapshot };
  delete captured.snapshotId;
  // Historical captures are already prepared; a live polling subscription cannot
  // survive a restart or describe a different snapshot of the same review.
  delete captured.reconciliation;
  const json = JSON.stringify(captured);
  const digest = createHash("sha256").update(json).digest("hex");
  const existing = db.query<{ id: string }, [string]>("SELECT id FROM review_snapshots WHERE digest=?").get(digest);
  if (existing) return { ...captured, snapshotId: existing.id };
  const id = crypto.randomUUID();
  db.query("INSERT INTO review_snapshots (id,digest,workspace_id,captured_at,snapshot_json) VALUES (?,?,?,?,?)")
    .run(id, digest, snapshot.workspace.id, new Date().toISOString(), json);
  return { ...captured, snapshotId: id };
}

/** Read an accepted capture without needing a live provider or its old commits. */
export function readSnapshot(db: Database, id: string): LocalReview {
  const row = db.query<{ snapshot_json: string }, [string]>("SELECT snapshot_json FROM review_snapshots WHERE id=?").get(id);
  if (!row) throw new Error("Review snapshot not found");
  return { ...JSON.parse(row.snapshot_json), snapshotId: id };
}

/** Recover server-recorded freshness stamps, never caller-supplied filesystem coordinates. */
export function readWorkingTree(db: Database, workspace: string, version: string): GitWorkingTree | undefined {
  const row = db.query<{ snapshot_json: string }, [string, string]>(`SELECT snapshot_json FROM review_snapshots
    WHERE workspace_id=? AND json_extract(snapshot_json,'$.selected.commit_id')=? LIMIT 1`).get(workspace, version);
  return row ? (JSON.parse(row.snapshot_json) as LocalReview).workingTree : undefined;
}
