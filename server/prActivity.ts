import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { ReviewStore } from "./reviewStore";
import type { Activity, PullActivity } from "../shared/inbox";
import type { Conversation, DiscussionComment, PullRequestSummary } from "../shared/types";

export interface ActivitySnapshot extends PullActivity { conversation?: Conversation; reuseDiscussion?: boolean; discussionVersion?: number }
interface StatusRow { head_sha: string | null; head_author: string | null; review_decision: string | null; review_requested: number | null; checks: string | null }
interface MessageRow { github_id: number; github_kind: string; login: string; published_at: string; thread_key: string | null }

/** Store PR status and project inbox activity from the canonical published discussion rows. */
export class PrActivity {
  // Migration 11 runs before the review parent table was renamed.
  constructor(private db: Database, private reviewsTable: "reviews" | "review_records" = "reviews") {}

  /** A completed remote read must not overwrite a newer acknowledged comment or review. */
  version(pr: string): number {
    return this.db.query<{ discussion_version: number }, [string]>("SELECT discussion_version FROM prs WHERE id=?").get(pr)?.discussion_version ?? 0;
  }

  /** Discover a PR without replacing independently cached status or discussion. */
  summary(pr: PullRequestSummary) {
    this.db.query("INSERT INTO repositories (id) VALUES (?) ON CONFLICT(id) DO NOTHING").run(pr.repository.nameWithOwner.toLowerCase());
    this.db.query(`INSERT INTO prs (id, number, title, url, repository, author, is_draft, updated_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET number=excluded.number, title=excluded.title, url=excluded.url, repository=excluded.repository,
        author=excluded.author, is_draft=excluded.is_draft, updated_at=excluded.updated_at, created_at=excluded.created_at`)
      .run(`${pr.repository.nameWithOwner.toLowerCase()}/${pr.number}`, pr.number, pr.title, pr.url, pr.repository.nameWithOwner, pr.author.login, Number(pr.isDraft), pr.updatedAt, pr.createdAt ?? null);
  }

  /** Reconstruct the API snapshot without persisting another copy of its events. */
  get(pr: string): PullActivity | undefined {
    const row = this.db.query<StatusRow, [string]>("SELECT head_sha,head_author,review_decision,review_requested,checks FROM prs WHERE id=?").get(pr);
    if (row?.head_sha == null) return;
    const events: Activity[] = this.db.query<MessageRow, [string]>(`SELECT m.github_id,m.github_kind,m.login,m.published_at,t.thread_key
      FROM review_messages m JOIN review_threads t ON t.id=m.thread_id
      WHERE m.github_pr=? AND m.github_id IS NOT NULL AND m.remote_deleted_at IS NULL ORDER BY CASE m.github_kind WHEN 'issue_comment' THEN 0 ELSE 1 END,m.github_id`).all(pr).map((message) => ({
      key: `${message.github_kind === "issue_comment" ? "general" : "inline"}:${message.github_id}`,
      actor: message.login ?? "", at: message.published_at ?? "", kind: "reply",
      ...(message.thread_key ? { thread: message.thread_key } : {}),
    }));
    for (const review of this.db.query<{ github_id: number; login: string; submitted_at: string | null; has_body: number | null }, [string]>(`SELECT github_id,login,submitted_at,has_body FROM pr_reviews
      WHERE pr_id=? AND (state IS NULL OR state!='PENDING') AND remote_deleted_at IS NULL ORDER BY github_id`).all(pr)) {
      events.push({ key: `review:${review.github_id}`, actor: review.login, at: review.submitted_at ?? "", kind: "review", ...(review.has_body === null ? {} : { hasBody: Boolean(review.has_body) }) });
    }
    const approvers = this.db.query<{ login: string }, [string]>("SELECT login FROM pr_approvers WHERE pr_id=? ORDER BY login").all(pr).map((entry) => entry.login);
    return { head: row.head_sha, headAuthor: row.head_author ?? "", reviewDecision: row.review_decision ?? "", checks: row.checks ?? "", approvers, events,
      ...(row.review_requested === null ? {} : { reviewRequested: Boolean(row.review_requested) }) };
  }

  /** Replace a complete activity snapshot atomically, retaining stable message and review IDs. */
  save(pr: string, snapshot: ActivitySnapshot, legacy = false) {
    return this.db.transaction(() => {
      const fresh = snapshot.discussionVersion === undefined || snapshot.discussionVersion === this.version(pr);
      this.db.query("UPDATE prs SET head_sha=?,head_author=?,review_decision=?,review_requested=?,checks=? WHERE id=?")
        .run(snapshot.head, snapshot.headAuthor, snapshot.reviewDecision, snapshot.reviewRequested === undefined ? null : Number(snapshot.reviewRequested), snapshot.checks, pr);
      const approvers = new Set((snapshot.approvers ?? []).map((login) => login.toLowerCase()));
      for (const login of snapshot.approvers ?? []) this.db.query("INSERT INTO pr_approvers (pr_id,login) VALUES (?,?) ON CONFLICT(pr_id,login) DO UPDATE SET login=excluded.login").run(pr, login);
      for (const row of this.db.query<{ id: number; login: string }, [string]>("SELECT id,login FROM pr_approvers WHERE pr_id=?").all(pr)) {
        if (!approvers.has(row.login.toLowerCase())) this.db.query("DELETE FROM pr_approvers WHERE id=?").run(row.id);
      }
      if (fresh && snapshot.conversation) this.conversation(pr, snapshot.conversation);
      else if (fresh && !snapshot.reuseDiscussion) this.events(pr, snapshot.events, legacy);
      return fresh;
    })();
  }

  /** Import full comment text and review decisions after all remote pages were read successfully. */
  conversation(pr: string, conversation: Conversation) {
    this.db.transaction(() => {
      for (const comment of conversation.comments) this.comment(pr, comment, "issue_comment");
      for (const comment of conversation.inline) this.comment(pr, comment, "inline_comment");
      for (const review of conversation.reviews) this.review(pr, review);
      this.markMissing(pr, new Set([...conversation.comments.map((comment) => `general:${comment.id}`), ...conversation.inline.map((comment) => `inline:${comment.id}`), ...conversation.reviews.map((review) => `review:${review.id}`)]));
      this.db.query("UPDATE prs SET discussion_version=discussion_version+1 WHERE id=?").run(pr);
    })();
  }

  /** Save an acknowledged review without treating the receipt as a complete remote snapshot. */
  review(pr: string, review: DiscussionComment) {
    const body = cleanBody(review.body ?? "");
    this.db.query(`INSERT INTO pr_reviews (pr_id,github_id,login,state,body,has_body,submitted_at,commit_sha,url)
      VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(pr_id,github_id) DO UPDATE SET login=excluded.login,state=excluded.state,body=excluded.body,
      has_body=excluded.has_body,submitted_at=excluded.submitted_at,commit_sha=excluded.commit_sha,url=excluded.url,remote_deleted_at=NULL`)
      .run(pr, review.id, review.user.login, review.state ?? null, body, Number(Boolean(body.trim())), review.submitted_at ?? null, review.commit_id ?? null, review.html_url);
    this.db.query("UPDATE prs SET discussion_version=discussion_version+1 WHERE id=?").run(pr);
  }

  /**
   * Metadata-only legacy events preserve unread state until a complete discussion fetch fills in text.
   *
   * Known messages may be newer than the old inbox cache; retain their author and publication date.
   */
  private events(pr: string, events: Activity[], legacy: boolean) {
    for (const event of events) {
      const id = Number(event.key.slice(event.key.indexOf(":") + 1));
      if (event.kind === "review") {
        this.db.query(`INSERT INTO pr_reviews (pr_id,github_id,login,submitted_at,has_body) VALUES (?,?,?,?,?)
          ON CONFLICT(pr_id,github_id) DO UPDATE SET
          login=CASE WHEN pr_reviews.body IS NULL THEN excluded.login ELSE pr_reviews.login END,
          submitted_at=CASE WHEN pr_reviews.body IS NULL THEN excluded.submitted_at ELSE pr_reviews.submitted_at END,
          has_body=CASE WHEN pr_reviews.body IS NULL THEN excluded.has_body ELSE pr_reviews.has_body END,remote_deleted_at=NULL`)
          .run(pr, id, event.actor, event.at, event.hasBody === undefined ? null : Number(event.hasBody));
      } else {
        const kind = event.key.startsWith("general:") ? "issue_comment" : "inline_comment";
        const existing = this.db.query<{ id: string }, [string, string, number]>("SELECT id FROM review_messages WHERE github_pr=? AND github_kind=? AND github_id=?").get(pr, kind, id);
        const thread = this.thread(pr, kind === "issue_comment" ? "general" : event.thread ?? null, kind === "issue_comment" ? "general" : "inline", id);
        this.db.query(`INSERT INTO review_messages (id,thread_id,author,login,body,created_at,sequence,github_pr,github_kind,github_id,published_at,body_known)
          VALUES (?,?,'user',?,'',?,0,?,?,?,?,0) ON CONFLICT(id) DO UPDATE SET
          login=CASE WHEN review_messages.body_known=0 THEN excluded.login ELSE review_messages.login END,
          published_at=CASE WHEN review_messages.body_known=0 THEN excluded.published_at ELSE review_messages.published_at END,remote_deleted_at=NULL`)
          .run(existing?.id ?? crypto.randomUUID(), thread, event.actor, event.at, pr, kind, id, event.at);
      }
    }
    // The old inbox cache can be older than a locally acknowledged publication.
    if (!legacy) this.markMissing(pr, new Set(events.map((event) => event.key)));
  }

  /**
   * General conversations have no anchor; legacy inline metadata can wait for its original coordinates.
   *
   * Reuse a publication's local thread before resolving aliases, including threads linked to a working copy.
   */
  private thread(pr: string, key: string | null, kind: "inline" | "general", githubId: number): string {
    const existing = this.db.query<{ id: string }, [string, string, number]>(`SELECT t.id FROM review_threads t JOIN review_messages m ON m.thread_id=t.id
      WHERE m.github_pr=? AND m.github_kind=? AND m.github_id=?`).get(pr, kind === "general" ? "issue_comment" : "inline_comment", kind === "inline" && key ? Number(key.slice(7)) : githubId);
    if (existing) {
      this.db.query("UPDATE review_threads SET thread_key=? WHERE id=?").run(key, existing.id);
      return existing.id;
    }
    let review = this.db.query<{ id: string }, [string, string]>(`SELECT id FROM ${this.reviewsTable} WHERE id=? OR id=(SELECT review_id FROM review_aliases WHERE alias=?)`).get(pr, pr);
    if (!review) {
      review = { id: createHash("sha256").update(crypto.randomUUID()).digest("hex") };
      if (this.reviewsTable === "review_records") {
        this.db.query("INSERT INTO review_records (id,value) VALUES (?,?)").run(review.id, JSON.stringify({ id: review.id, pr, closed: false, records: [], commits: [], changes: [] }));
      } else {
        new ReviewStore(this.db).save({ id: review.id, pr, closed: false, commits: [], changes: [] }, "{}");
      }
      this.db.query("INSERT INTO review_aliases (alias,review_id) VALUES (?,?)").run(pr, review.id);
    }
    const same = key ? this.db.query<{ id: string }, [string, string]>("SELECT id FROM review_threads WHERE review_id=? AND thread_key=?").get(review.id, key) : null;
    if (same) return same.id;
    const id = crypto.randomUUID();
    this.db.query(`INSERT INTO review_threads (id,review_id,kind,resolved,human_sequence,discussion_kind,thread_key)
      VALUES (?,?,'github',0,0,?,?)`).run(id, review.id, kind, key);
    return id;
  }

  /** Fill canonical comment rows without changing their local publication identities. */
  comment(pr: string, comment: DiscussionComment, kind: "issue_comment" | "inline_comment") {
    const thread = this.thread(pr, kind === "issue_comment" ? "general" : `inline:${comment.in_reply_to_id ?? comment.id}`, kind === "issue_comment" ? "general" : "inline", comment.id);
    const body = cleanBody(comment.body ?? "");
    this.db.query(`INSERT INTO review_messages (id,thread_id,author,login,body,created_at,sequence,github_pr,github_kind,github_id,github_url,published_at,body_known)
      VALUES (?,?,'user',?,?,?,0,?,?,?,?,?,1) ON CONFLICT(github_pr,github_kind,github_id) DO UPDATE SET
      thread_id=excluded.thread_id,login=excluded.login,body=CASE WHEN review_messages.author='agent' AND substr(excluded.body,1,12)='**Agent:**\n\n' THEN substr(excluded.body,13) ELSE excluded.body END,
      github_url=excluded.github_url,published_at=excluded.published_at,body_known=1,remote_deleted_at=NULL`)
      .run(crypto.randomUUID(), thread, comment.user.login, body, comment.created_at ?? "", pr, kind, comment.id, comment.html_url, comment.created_at ?? "");
    this.db.query("UPDATE prs SET discussion_version=discussion_version+1 WHERE id=?").run(pr);
  }

  /** Reflect an acknowledged remote edit or deletion without waiting for another full fetch. */
  changeComment(pr: string, id: number, kind: "inline" | "general", body?: string) {
    const githubKind = kind === "inline" ? "inline_comment" : "issue_comment";
    if (body === undefined) this.db.query("UPDATE review_messages SET remote_deleted_at=? WHERE github_pr=? AND github_kind=? AND github_id=?").run(new Date().toISOString(), pr, githubKind, id);
    else this.db.query("UPDATE review_messages SET body=?,body_known=1 WHERE github_pr=? AND github_kind=? AND github_id=?").run(body, pr, githubKind, id);
    this.db.query("UPDATE prs SET discussion_version=discussion_version+1 WHERE id=?").run(pr);
  }

  /** Only complete snapshots may mark remote comments absent; local drafts and history remain stored. */
  private markMissing(pr: string, keys: Set<string>) {
    const at = new Date().toISOString();
    for (const message of this.db.query<{ id: string; github_kind: string; github_id: number }, [string]>("SELECT id,github_kind,github_id FROM review_messages WHERE github_pr=? AND github_id IS NOT NULL AND remote_deleted_at IS NULL").all(pr)) {
      if (!keys.has(`${message.github_kind === "issue_comment" ? "general" : "inline"}:${message.github_id}`)) this.db.query("UPDATE review_messages SET remote_deleted_at=? WHERE id=?").run(at, message.id);
    }
    for (const review of this.db.query<{ id: number; github_id: number }, [string]>("SELECT id,github_id FROM pr_reviews WHERE pr_id=? AND remote_deleted_at IS NULL").all(pr)) {
      if (!keys.has(`review:${review.github_id}`)) this.db.query("UPDATE pr_reviews SET remote_deleted_at=? WHERE id=?").run(at, review.id);
    }
  }
}

/** Transport receipt markers are not human feedback and must not make an empty review unread. */
function cleanBody(body: string): string {
  return body.replace(/\n\n<!-- biff:[a-f0-9-]+:[a-f0-9-]+ -->\s*$/, "");
}
