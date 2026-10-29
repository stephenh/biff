import type { Database } from "bun:sqlite";
import type { ReviewIdentity } from "../shared/progress";
import { createHash } from "node:crypto";
import type { LocalReview } from "../shared/types";
import type { Storage } from "./storage";
import { mergeLogicalHunks } from "./logicalHunks";
import { mergeViewedSync } from "./viewedFiles";
import { invalidateReconciliations } from "./reconciliation";

export interface ReviewMetadata extends ReviewIdentity {
  commits: string[];
  changes: string[];
  bookmarkTips?: string[];
  prHeads?: string[];
  discussionVersion?: number;
  commentReads?: string[];
}
interface ReviewRow {
  id: string; pr: string | null; local_workspace: string | null; local_bookmark: string | null;
  closed: number; discussion_version: number;
}
interface CommitRow { commit_sha: string; commit_position: number | null; bookmark_tip_position: number | null; pr_head_position: number | null; change_id: string | null }
export interface PrHeadChange { scope: string; head: string; changeId: string; workspaces: string[] }

/** Persist identity and linking evidence in the caller's atomic review transaction. */
export class ReviewStore {
  constructor(private db: Database) {}

  /** Reconstruct history in its original order, including tips outside the selected commit range. */
  get(id: string): ReviewMetadata {
    const row = this.db.query<ReviewRow, [string]>("SELECT * FROM reviews WHERE id=?").get(id)!;
    const commits = this.db.query<CommitRow, [string]>("SELECT * FROM review_commits WHERE review_id=?").all(id);
    return { id: row.id, closed: Boolean(row.closed), ...(row.pr === null ? {} : { pr: row.pr }),
      ...(row.local_workspace === null ? {} : { local: { workspace: row.local_workspace, bookmark: row.local_bookmark! } }),
      discussionVersion: row.discussion_version,
      commits: commitHistory(commits, "commit_position"), bookmarkTips: commitHistory(commits, "bookmark_tip_position"), prHeads: commitHistory(commits, "pr_head_position"),
      changes: this.db.query<{ change_id: string }, [string]>("SELECT change_id FROM review_changes WHERE review_id=? ORDER BY position").all(id).map((entry) => entry.change_id),
      commentReads: this.reads(id) };
  }

  /** Receipts remain valid even when their remote message has not been fetched or was deleted. */
  reads(id: string): string[] {
    return this.db.query<{ receipt_key: string }, [string]>("SELECT receipt_key FROM review_comment_reads WHERE review_id=? ORDER BY position").all(id).map((row) => row.receipt_key);
  }

  /**
   * Keep synthetic child IDs stable while replacing each collection's current membership.
   *
   * The caller owns the transaction so metadata, aliases, and discussion changes commit together.
   */
  save(review: ReviewMetadata): void {
    this.db.query(`INSERT INTO reviews (id,pr,local_workspace,local_bookmark,closed,discussion_version) VALUES (?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET pr=excluded.pr,local_workspace=excluded.local_workspace,
      local_bookmark=excluded.local_bookmark,closed=excluded.closed,discussion_version=excluded.discussion_version`)
      .run(review.id, review.pr ?? null, review.local?.workspace ?? null, review.local?.bookmark ?? null, Number(review.closed), review.discussionVersion ?? 0);

    const commits = new Set([...review.commits, ...(review.bookmarkTips ?? []), ...(review.prHeads ?? [])]);
    for (const sha of commits) this.db.query(`INSERT INTO review_commits (review_id,commit_sha,commit_position,bookmark_tip_position,pr_head_position) VALUES (?,?,?,?,?)
      ON CONFLICT(review_id,commit_sha) DO UPDATE SET commit_position=excluded.commit_position,bookmark_tip_position=excluded.bookmark_tip_position,pr_head_position=excluded.pr_head_position`)
      .run(review.id, sha, position(review.commits, sha), position(review.bookmarkTips ?? [], sha), position(review.prHeads ?? [], sha));
    for (const row of this.db.query<{ id: number; commit_sha: string }, [string]>("SELECT id,commit_sha FROM review_commits WHERE review_id=?").all(review.id)) {
      if (!commits.has(row.commit_sha)) this.db.query("DELETE FROM review_commits WHERE id=?").run(row.id);
    }
    this.saveKeys("review_changes", "change_id", review.id, review.changes);
    this.saveKeys("review_comment_reads", "receipt_key", review.id, review.commentReads ?? []);
  }

  /** Domain keys are unique within a review; row IDs survive unrelated saves. */
  private saveKeys(table: "review_changes" | "review_comment_reads", column: "change_id" | "receipt_key", review: string, keys: string[]): void {
    const unique = [...new Set(keys)];
    for (const [index, key] of unique.entries()) this.db.query(`INSERT INTO ${table} (review_id,${column},position) VALUES (?,?,?)
      ON CONFLICT(review_id,${column}) DO UPDATE SET position=excluded.position`).run(review, key, index);
    const retained = new Set(unique);
    for (const row of this.db.query<{ id: number; key: string }, [string]>(`SELECT id,${column} AS key FROM ${table} WHERE review_id=?`).all(review)) {
      if (!retained.has(row.key)) this.db.query(`DELETE FROM ${table} WHERE id=?`).run(row.id);
    }
  }
}

/** Resolve only the requested review; reads of absent scopes do not allocate rows. */
export function findReview(db: Database, scope: string): ReviewIdentity | undefined {
  const row = db.query<ReviewRow, [string, string]>("SELECT * FROM reviews WHERE id=? OR id=(SELECT review_id FROM review_aliases WHERE alias=?)").get(scope, scope);
  return row ? { id: row.id, closed: Boolean(row.closed), ...(row.pr === null ? {} : { pr: row.pr }),
    ...(row.local_workspace === null ? {} : { local: { workspace: row.local_workspace, bookmark: row.local_bookmark! } }) } : undefined;
}

/** Allocate inside the caller's transaction so alias failures cannot leave an orphan lifetime. */
export function ensureReview(db: Database, scope: string, id?: string): ReviewIdentity {
  const existing = findReview(db, scope);
  if (existing) return existing;
  id ??= newReviewId();
  db.query("INSERT INTO reviews (id) VALUES (?)").run(id);
  db.query("INSERT INTO review_aliases (alias,review_id) VALUES (?,?)").run(scope, id);
  return { id, closed: false };
}

/** Allocate a lifetime independently of mutable bookmark names and remote URLs. */
export function newReviewId(): string { return createHash("sha256").update(crypto.randomUUID()).digest("hex"); }

/** Return identity after earlier admitted review mutations have committed. */
export function reviewIdentity(storage: Storage, scope: string): Promise<ReviewIdentity> {
  return storage.serialize("review", async () => storage.db.transaction(() => ensureReview(storage.db, scope))());
}

/**
 * Follow exact JJ identities into later snapshots, retaining old snapshot aliases.
 *
 * A reused bookmark alone is not continuity: disjoint change/commit histories or an ended review
 * create a new lifetime. Only observed bookmark tips can establish a link to a PR head,
 * through either an exact commit ID or a repository-verified JJ change ID.
 */
export function localReview(storage: Storage, snapshot: LocalReview, fresh = false): Promise<ReviewIdentity> {
  return storage.serialize("review", async () => storage.db.transaction(() => {
    const db = storage.db;
    const key = JSON.stringify([snapshot.workspace.id, snapshot.bookmark || ""]);
    const previous = db.query<{ review_id: string }, [string]>("SELECT review_id FROM local_reviews WHERE scope=?").get(key);
    let review = previous ? new ReviewStore(db).get(previous.review_id) : undefined;
    const commits = snapshot.revisions.map((revision) => revision.commit_id);
    const changes = snapshot.revisions.map((revision) => revision.change_id);
    const unrelated = review && changes.length > 0 && review.changes.length > 0 && !changes.some((id) => review!.changes.includes(id)) && !commits.some((id) => review!.commits.includes(id));
    if (!review || fresh || review.closed || unrelated) {
      if (review) db.query("UPDATE reviews SET local_workspace=NULL,local_bookmark=NULL WHERE id=?").run(review.id);
      const id = newReviewId();
      review = { ...ensureReview(db, `jj/${snapshot.workspace.id}/${id}`, id), commits: [], changes: [] };
      db.query("INSERT INTO local_reviews (scope,review_id) VALUES (?,?) ON CONFLICT(scope) DO UPDATE SET review_id=excluded.review_id").run(key, id);
    }
    const observed = [...snapshot.revisions, snapshot.bookmarkTip ?? snapshot.tip ?? snapshot.selected];
    const changeIds = new Map(observed.map((revision) => [revision.commit_id, revision.change_id]));
    addCommits(db, review.id, "commit_position", commits, changeIds);
    // Range commits are not evidence of a bookmark tip, including unbookmarked agent extensions.
    addCommits(db, review.id, "bookmark_tip_position", [(snapshot.bookmarkTip ?? snapshot.tip ?? snapshot.selected).commit_id], changeIds);
    for (const change of changes) db.query(`INSERT INTO review_changes (review_id,change_id,position)
      SELECT ?,?,COALESCE(max(position)+1,0) FROM review_changes WHERE review_id=? ON CONFLICT(review_id,change_id) DO NOTHING`).run(review.id, change, review.id);
    db.query("UPDATE reviews SET local_workspace=?,local_bookmark=? WHERE id=?").run(snapshot.workspace.id, snapshot.bookmark || "", review.id);
    discoverLinks(storage);
    return findReview(db, review.id)!;
  })());
}

/** Record PR history and redirect aliases atomically when an exact, unambiguous local match exists. */
export function recordPullRequest(storage: Storage, scope: string, commits: string[], closed = false, head?: string): Promise<ReviewIdentity> {
  return storage.serialize("review", async () => storage.db.transaction(() => {
    const db = storage.db;
    const review = ensureReview(db, scope);
    db.query("UPDATE reviews SET pr=?,closed=closed OR ? WHERE id=?").run(scope, Number(closed), review.id);
    addCommits(db, review.id, "commit_position", commits);
    if (head) addCommits(db, review.id, "pr_head_position", [head]);
    discoverLinks(storage);
    return findReview(db, scope)!;
  })());
}

/** Admit explicit PR-head metadata only from local repositories verified against this GitHub repo. */
export function recordPrChangeIds(storage: Storage, observations: PrHeadChange[]): Promise<void> {
  return storage.serialize("review", async () => storage.db.transaction(() => {
    const db = storage.db;
    for (const entry of observations) {
      const review = findReview(db, entry.scope);
      if (!review?.pr || review.closed || !/^[k-z]{32}$/.test(entry.changeId)) continue;
      const observed = db.query("SELECT id FROM review_commits WHERE review_id=? AND commit_sha=? AND pr_head_position IS NOT NULL").get(review.id, entry.head);
      if (!observed) continue;

      const repository = entry.scope.slice(0, entry.scope.lastIndexOf("/"));
      db.query("UPDATE review_commits SET change_id=? WHERE review_id=? AND commit_sha=?").run(entry.changeId, review.id, entry.head);
      for (const workspace of entry.workspaces) db.query(`INSERT INTO review_repositories (review_id,repository)
        SELECT id,? FROM reviews WHERE local_workspace=? AND pr IS NULL AND closed=0 ON CONFLICT DO NOTHING`).run(repository, workspace);
    }
    // Resolve the entire batch before linking, so two known PRs cannot race to adopt one review.
    discoverLinks(storage);
  })());
}

/** Closing a PR ends its lifetime without changing old bookmark snapshot aliases. */
export function closeReview(storage: Storage, scope: string): Promise<void> {
  return storage.serialize("review", async () => storage.db.transaction(() => {
    storage.db.query("UPDATE reviews SET closed=1 WHERE id=?").run(ensureReview(storage.db, scope).id);
  })());
}

/** Reject comment anchors from snapshots never observed for this review. */
export function requireReviewSnapshot(storage: Storage, scope: string, commitId: string): Promise<void> {
  return storage.serialize("review", async () => {
    if (!storage.db.query("SELECT id FROM review_commits WHERE review_id=? AND commit_sha=? AND commit_position IS NOT NULL").get(findReview(storage.db, scope)?.id ?? "", commitId)) {
      throw new Error("This snapshot does not belong to the review. Refresh before commenting.");
    }
  });
}

/** Add read receipts without rewriting unrelated review metadata or existing receipt identities. */
export function addCommentReads(db: Database, review: string, keys: string[]): void {
  for (const key of keys) db.query(`INSERT INTO review_comment_reads (review_id,receipt_key,position)
    SELECT ?,?,COALESCE(max(position)+1,0) FROM review_comment_reads WHERE review_id=? ON CONFLICT(review_id,receipt_key) DO NOTHING`).run(review, key, review);
}

/** Remember individual messages so new replies never inherit a thread's read state. */
export function commentReads(storage: Storage, scope: string, keys: string[] = []): Promise<string[]> {
  return storage.serialize("review", async () => storage.db.transaction(() => {
    const review = ensureReview(storage.db, scope).id;
    addCommentReads(storage.db, review, keys);
    return new ReviewStore(storage.db).reads(review);
  })());
}

/** Dashboard reads do not allocate lifetimes for unseen PRs. */
export function commentReadSnapshot(storage: Storage, scope: string): string[] {
  return new ReviewStore(storage.db).reads(findReview(storage.db, scope)?.id ?? "");
}

/** Append observations without rewriting other commit roles or their synthetic IDs. */
function addCommits(db: Database, review: string, role: "commit_position" | "bookmark_tip_position" | "pr_head_position", commits: string[], changeIds?: Map<string, string>): void {
  for (const sha of commits) db.query(`INSERT INTO review_commits (review_id,commit_sha,${role},change_id)
    SELECT ?,?,COALESCE(max(${role})+1,0),? FROM review_commits WHERE review_id=?
    ON CONFLICT(review_id,commit_sha) DO UPDATE SET ${role}=COALESCE(review_commits.${role},excluded.${role}),
      change_id=COALESCE(review_commits.change_id,excluded.change_id)`).run(review, sha, changeIds?.get(sha) ?? null, review);
}

/**
 * Match only mutually unique PR heads and bookmark tips before merging any identities.
 *
 * A PR with JJ change history was previously linked. Detaching its bookmark must not rediscover it
 * as an unrelated remote review. Query only linking evidence, never all review discussions.
 */
function discoverLinks(storage: Storage): void {
  const db = storage.db;
  const pairs = db.query<{ local: string; remote: string }, []>(`SELECT DISTINCT l.id AS local,r.id AS remote
    FROM reviews r JOIN review_commits rh ON rh.review_id=r.id AND rh.pr_head_position IS NOT NULL
    JOIN review_commits lh ON lh.bookmark_tip_position IS NOT NULL AND (lh.commit_sha=rh.commit_sha OR (
      lh.change_id=rh.change_id AND EXISTS (SELECT 1 FROM review_repositories repo
        WHERE repo.review_id=lh.review_id AND repo.repository=substr(r.pr,1,length(rtrim(r.pr,'0123456789'))-1))
    ))
    JOIN reviews l ON l.id=lh.review_id
    WHERE r.pr IS NOT NULL AND r.local_workspace IS NULL AND r.closed=0
      AND NOT EXISTS (SELECT 1 FROM review_changes WHERE review_id=r.id)
      AND l.local_workspace IS NOT NULL AND l.pr IS NULL AND l.closed=0`).all();
  for (const pair of pairs) {
    if (pairs.filter((other) => other.local === pair.local).length !== 1 || pairs.filter((other) => other.remote === pair.remote).length !== 1) continue;
    mergeReviews(storage, pair.remote, pair.local);
  }
}

/**
 * Move dependent entities before deleting the remote lifetime; surviving rows retain their IDs.
 *
 * Only duplicate domain keys collapse. A remote candidate has no JJ changes, so its commit roles,
 * read receipts, draft state, threads, and file flags are the children that need transferring.
 */
function mergeReviews(storage: Storage, from: string, to: string): void {
  const db = storage.db;
  db.query(`UPDATE reviews SET pr=(SELECT pr FROM reviews WHERE id=?),
    discussion_version=max(discussion_version,(SELECT discussion_version FROM reviews WHERE id=?))+1 WHERE id=?`).run(from, from, to);
  const offsets = db.query<{ commits: number; tips: number; heads: number }, [string]>(`SELECT COALESCE(max(commit_position)+1,0) AS commits,
    COALESCE(max(bookmark_tip_position)+1,0) AS tips,COALESCE(max(pr_head_position)+1,0) AS heads FROM review_commits WHERE review_id=?`).get(to)!;
  for (const row of db.query<CommitRow & { id: number }, [string]>("SELECT * FROM review_commits WHERE review_id=?").all(from)) {
    const target = db.query<{ id: number }, [string, string]>("SELECT id FROM review_commits WHERE review_id=? AND commit_sha=?").get(to, row.commit_sha);
    const positions = [row.commit_position === null ? null : row.commit_position + offsets.commits,
      row.bookmark_tip_position === null ? null : row.bookmark_tip_position + offsets.tips, row.pr_head_position === null ? null : row.pr_head_position + offsets.heads];
    if (target) {
      db.query(`UPDATE review_commits SET commit_position=COALESCE(commit_position,?),bookmark_tip_position=COALESCE(bookmark_tip_position,?),
        pr_head_position=COALESCE(pr_head_position,?),change_id=COALESCE(change_id,?) WHERE id=?`).run(...positions, row.change_id, target.id);
      db.query("DELETE FROM review_commits WHERE id=?").run(row.id);
    } else db.query("UPDATE review_commits SET review_id=?,commit_position=?,bookmark_tip_position=?,pr_head_position=? WHERE id=?").run(to, ...positions, row.id);
  }
  db.query(`DELETE FROM review_comment_reads WHERE review_id=? AND receipt_key IN (SELECT receipt_key FROM review_comment_reads WHERE review_id=?)`).run(from, to);
  db.query(`UPDATE review_comment_reads SET review_id=?,position=position+(SELECT COALESCE(max(position)+1,0) FROM review_comment_reads WHERE review_id=?) WHERE review_id=?`).run(to, to, from);
  db.query(`INSERT INTO review_draft_state (review_id,version,body,commit_id) SELECT ?,version,body,commit_id FROM review_draft_state WHERE review_id=?
    ON CONFLICT(review_id) DO UPDATE SET version=excluded.version,body=excluded.body,commit_id=excluded.commit_id`).run(to, from);
  db.query(`INSERT INTO review_draft_receipts (review_id,kind,token) SELECT ?,kind,token FROM review_draft_receipts WHERE review_id=? ON CONFLICT DO NOTHING`).run(to, from);
  // General conversations and unanchored imports also belong to the surviving review.
  db.query("UPDATE review_threads SET review_id=? WHERE review_id=?").run(to, from);
  db.query("INSERT INTO review_repositories (review_id,repository) SELECT ?,repository FROM review_repositories WHERE review_id=? ON CONFLICT DO NOTHING").run(to, from);
  mergeLogicalHunks(db, from, to);
  mergeViewedSync(db, from, to);
  db.query("UPDATE review_aliases SET review_id=? WHERE review_id=?").run(to, from);
  db.query("UPDATE local_reviews SET review_id=? WHERE review_id=?").run(to, from);
  db.query("UPDATE agent_sessions SET review_id=? WHERE review_id=?").run(to, from);
  db.query("DELETE FROM reviews WHERE id=?").run(from);
  invalidateReconciliations(storage, from);
  invalidateReconciliations(storage, to);
}

/** NULL means this SHA was never observed in this particular history. */
function position(values: string[], value: string): number | null {
  const index = values.indexOf(value);
  return index < 0 ? null : index;
}

/** A bookmark tip can be outside a selected range, so membership cannot be inferred from another role. */
function commitHistory(rows: CommitRow[], column: "commit_position" | "bookmark_tip_position" | "pr_head_position"): string[] {
  return rows.filter((row) => row[column] !== null).sort((a, b) => a[column]! - b[column]!).map((row) => row.commit_sha);
}
