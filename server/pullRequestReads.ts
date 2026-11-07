import type { Conversation, PullRequest, PullRequestStatus, PullRequestSync } from "../shared/types";
import type { GitHub } from "./github";
import type { Storage } from "./storage";
import { PrActivity } from "./prActivity";
import { viewerReviewStatus } from "../shared/pullRequestStatus";
import { registerReviewChanges, observeReviewChanges, reviewChangesStatus } from "./reviewChanges";
import { autoReadComments } from "./commentReadsApi";
import { conversationActivity } from "../shared/commentActivity";
import { reconcileFollowUpThreads } from "./followUps";
import { invalidateSinceReview } from "./sinceReview";

type Resource = "metadata" | "status" | "conversation";
type Snapshot = PullRequest | PullRequestStatus | Conversation;
interface Row {
  metadata_json: string | null; metadata_refreshed_at: number | null; status_refreshed_at: number | null;
  conversation_refreshed_at: number | null; status_viewer: string | null; conversation_viewer: string | null; refresh_attempted_at: number | null; refresh_error: string | null;
}
const interval = 120_000;

/** Serve saved PR projections immediately; one background refresh owns each PR's remote reads. */
export class PullRequestReads {
  private pending = new Map<string, Promise<void>>();
  private failures = new Map<string, { error: string; at: number }>();

  constructor(private storage: Storage, private github: Pick<GitHub, "viewerLogin" | "pullRequest" | "status" | "fetchConversation" | "threadSync">, private now: () => number = Date.now) {}

  /** Read only committed SQLite state; an uncached resource is explicitly pending, never empty. */
  async read(repo: string, number: string, resource: Resource, force = false): Promise<Response> {
    const viewer = await this.github.viewerLogin();
    const scope = `${repo.toLowerCase()}/${number}`;
    const row = this.storage.db.query<Row, [string]>("SELECT * FROM prs WHERE id=?").get(scope);
    const activities = new PrActivity(this.storage.db);
    const failure = this.failures.get(scope);
    const sameViewer = (resource === "status" ? row?.status_viewer : row?.conversation_viewer)?.toLowerCase() === viewer.toLowerCase();
    const updatedAt = resource === "metadata" ? row?.metadata_refreshed_at : sameViewer ? row?.[`${resource}_refreshed_at`] : undefined;
    let data: Snapshot | undefined;
    if (resource === "metadata" && row?.metadata_json) data = JSON.parse(row.metadata_json) as PullRequest;
    if (resource === "status" && sameViewer) {
      const status = activities.status(scope);
      if (status) data = { ...status, ...viewerReviewStatus(status, viewer), ...reviewChangesStatus(this.storage.db, scope, viewer) };
    }
    if (resource === "conversation" && row?.conversation_refreshed_at) data = activities.readConversation(this.storage, scope, viewer, sameViewer);
    const due = updatedAt === undefined || updatedAt === null || this.now() - updatedAt >= interval;
    const error = row?.refresh_error ?? failure?.error;
    const coolingDown = error && this.now() - (row?.refresh_attempted_at ?? failure?.at ?? 0) < interval;
    if (force || due && !coolingDown) this.refresh(repo, number);
    const sync: PullRequestSync = { updatedAt: updatedAt ?? null, refreshing: this.pending.has(scope), ...(error ? { error } : {}) };
    return Response.json({ ...data, sync }, { status: data ? 200 : 202, headers: { "Cache-Control": "no-store" } });
  }

  /** Coalesce tabs and retry requests; the next local poll sees the committed result. */
  refresh(repo: string, number: string): Promise<void> {
    const scope = `${repo.toLowerCase()}/${number}`;
    const existing = this.pending.get(scope);
    if (existing) return existing;
    const task = this.storage.serialize(`github-read:${scope}`, () => this.fetch(repo, number)).catch((cause) => {
      // An invalid URL need not allocate a fake PR merely to show its first-load failure.
      const error = cause instanceof Error ? cause.message : String(cause);
      this.storage.db.query("UPDATE prs SET refresh_error=?,refresh_attempted_at=? WHERE id=?").run(error, this.now(), scope);
      this.failures.set(scope, { error, at: this.now() });
      if (this.failures.size > 128) this.failures.delete(this.failures.keys().next().value!);
    }).finally(() => this.pending.delete(scope));
    this.pending.set(scope, task);
    return task;
  }

  /** Finish admitted remote work before tests or shutdown close the database. */
  async drain(): Promise<void> { await Promise.all(this.pending.values()); }

  /**
   * Commit complete resources independently, without replacing an acknowledgment made during the read.
   *
   * A failed status request must not withhold a successful overview; a failed discussion page must
   * never turn the last complete conversation into an empty or partially fetched conversation.
   */
  private async fetch(repo: string, number: string): Promise<void> {
    const scope = `${repo.toLowerCase()}/${number}`;
    const activities = new PrActivity(this.storage.db);
    const version = activities.version(scope);
    const viewer = await this.github.viewerLogin();
    const [metadata, status, discussion] = await Promise.allSettled([
      this.github.pullRequest(repo, number), this.github.status(repo, number), this.github.fetchConversation(repo, number),
    ]);
    const saved = await this.storage.serialize("review", async () => this.storage.db.transaction(() => {
      if (activities.version(scope) !== version) return;
      const now = this.now();
      if (metadata.status === "fulfilled") {
        activities.metadata(repo, metadata.value, now);
        if (status.status === "fulfilled") {
          activities.save(scope, { ...status.value, head: metadata.value.head.sha, headAuthor: activities.status(scope)?.headAuthor ?? "", events: [], reuseDiscussion: true });
          this.storage.db.query("UPDATE prs SET status_refreshed_at=?,status_viewer=? WHERE id=?").run(now, viewer, scope);
        }
      }
      if (!this.storage.db.query("SELECT id FROM prs WHERE id=?").get(scope)) return;
      if (discussion.status === "fulfilled") {
        activities.conversation(scope, discussion.value);
        this.storage.db.query("UPDATE prs SET conversation_refreshed_at=?,conversation_viewer=? WHERE id=?").run(now, viewer, scope);
      }
      this.storage.db.query("UPDATE prs SET refresh_attempted_at=?,refresh_error=NULL WHERE id=?").run(now, scope);
      registerReviewChanges(this.storage.db, scope, viewer);
      observeReviewChanges(this.storage.db, scope, viewer);
      if (metadata.status === "fulfilled" && metadata.value.state === "closed") {
        this.storage.db.query("UPDATE pr_user_state SET waiting_on_author=0 WHERE id=?").run(scope);
      }
      invalidateSinceReview(this.storage.db, scope, viewer);
      return activities.version(scope);
    })());
    this.failures.delete(scope);
    if (saved !== undefined && discussion.status === "fulfilled") {
      await this.github.threadSync?.observe(repo, number, discussion.value.inline, undefined, saved);
      await autoReadComments(this.storage, scope, conversationActivity(discussion.value));
      await reconcileFollowUpThreads(this.storage, scope, discussion.value.inline.map((comment) => comment.id));
    }
    for (const result of [metadata, status, discussion]) if (result.status === "rejected") throw result.reason;
  }
}
