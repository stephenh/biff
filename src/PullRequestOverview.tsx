import { useRef, useState, useSyncExternalStore } from "react";
import type { PullRequest, PullRequestStatus, ReviewSubmission } from "../shared/types";
import type { ReviewDraft, ReviewDraftState } from "./reviewDraft";
import { post } from "./api";
import { MentionTextarea } from "./MentionTextarea";
import { OverviewDialog } from "./OverviewDialog";
import { Markdown } from "./Markdown";
import { BackgroundSaveStatus } from "./BackgroundSaveStatus";
import { backgroundSaves } from "./optimisticSave";
import { ReReviewNotice } from "./PullRequestStatusIndicators";
import { ActivityStatus } from "./ActivityStatus";

interface ReviewIntent { id: string; scope: string; event: ReviewSubmission["event"]; draft: ReviewDraft }
const reviewIntents = new Map<string, ReviewIntent>();

/** PR metadata and review submission stay separate from browsing comment threads. */
export function PullRequestOverview(props: { endpoint: string; pr: PullRequest; status?: PullRequestStatus; draftState: ReviewDraftState; onClose(): void; onSubmitted?(): void; onReanchor?(id: string): void }) {
  const { draft, setDraft, olderDrafts, storageError } = props.draftState;
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(false);
  const submitting = useRef(false);
  const scope = `github-review:${props.endpoint}`;
  const receipts = useSyncExternalStore((listener) => backgroundSaves.subscribe(listener), () => backgroundSaves.getSnapshot());
  const busy = starting || receipts.some((entry) => entry.scope === scope && entry.status === "saving");
  const stale = !props.draftState.loaded;
  const included = draft.comments.filter((comment) => !comment.needsReanchoring);

  /** Each review action submits the same draft with its explicit GitHub outcome. */
  async function submitReview(event: ReviewSubmission["event"]) {
    if (submitting.current) return;
    submitting.current = true;
    setStarting(true); setError("");
    try {
      const sent = structuredClone({ ...draft, comments: included });
      const submission = await submissionId(props.endpoint, event, sent);
      const id = submission.id;
      reviewIntents.set(`${scope}:${id}`, { id, scope, event, draft: sent });
      backgroundSaves.submit(scope, props.endpoint, id, `Submit review ${props.pr.number}`, async () => {
        await props.draftState.flush();
        const result = await post<{ biffDraft?: typeof sent }>(`${props.endpoint}/review`, { ...sent, event }, { "Idempotency-Key": id });
        props.draftState.acknowledge(sent, result.biffDraft);
        acknowledgeCoveredReviews({ id, scope, event, draft: sent });
        try { if (localStorage.getItem(submission.key) === id) localStorage.removeItem(submission.key); } catch { /* Publication is acknowledged even if browser cleanup fails. */ }
        props.onSubmitted?.();
      });
      props.onClose();
    } catch (error) { setError((error as Error).message); }
    finally { setStarting(false); submitting.current = false; }
  }

  return <OverviewDialog title={props.pr.title} busy={starting} onClose={props.onClose}>
    <ReReviewNotice status={props.status} endpoint={props.endpoint} head={props.pr.head.sha} onAcknowledged={props.onSubmitted} />
    <p className="muted">{props.pr.user.login} · {props.pr.state} · {props.pr.head.ref} → {props.pr.base.ref}</p>
    <Markdown className="pr-description" body={props.pr.body || "No description."} />
    <ActivityStatus scope={`load:${props.endpoint}/review-draft`} label="Load review draft" loading={!props.draftState.loaded} error={storageError} retry={() => void props.draftState.retryLoad()} />
    <ActivityStatus label={`Submit review #${props.pr.number}`} kind="saving" loading={starting} error={error} />
    <BackgroundSaveStatus scope={props.draftState.scope} />
    <BackgroundSaveStatus scope={scope} />
    <section className="review-compose">
      <h3>Your review</h3>
      {olderDrafts.length > 0 && <details className="older-review-drafts" open>
        <summary>Earlier drafts ({olderDrafts.length})</summary>
        <p className="muted">Original browser copies are kept here for recovery. Saved comments follow unchanged hunks; unmatched comments stay in your review below.</p>
        {olderDrafts.map((older, index) => <section key={`${older.commitId}:${index}`} aria-label={`Draft on commit ${older.commitId}`}>
          <h4>Commit {older.commitId.slice(0, 8)}</h4>
          {older.body && <Markdown body={older.body} />}
          {older.comments.map((entry, index) => <article className="draft-comment" key={index}>
            <p className="muted">{entry.path}:{entry.line} · {entry.side}</p>
            <Markdown body={entry.body} />
          </article>)}
        </section>)}
      </details>}
      {draft.comments.some((comment) => comment.needsReanchoring) && <p className="error">Some comment locations no longer match the current diff. Their text is saved; choose a new line to include them in this review. They remain unsent until you do.</p>}
      <button onClick={() => void props.draftState.reload()}>Reload saved draft</button>
      <label>Summary<MentionTextarea endpoint={props.endpoint} label="Review summary" value={draft.body} onValueChange={(body) => setDraft((current) => ({ ...current, body }))} /></label>
      {draft.comments.map((entry, index) => <div className="draft-comment" key={index}>
        <div className="card-actions"><span>{entry.path}:{entry.line} · {entry.side}{entry.needsReanchoring ? " · Needs a new location" : ""}</span>{entry.needsReanchoring && props.onReanchor && entry.id && <button onClick={() => props.onReanchor?.(entry.id!)}>Choose new line</button>}<button onClick={() => setDraft((current) => ({ ...current, comments: current.comments.filter((_, item) => item !== index) }))}>Remove</button></div>
        <MentionTextarea endpoint={props.endpoint} label={`Draft comment ${index + 1}`} value={entry.body} onValueChange={(body) => setDraft((current) => ({ ...current, comments: current.comments.map((item, itemIndex) => itemIndex === index ? { ...item, body } : item) }))} />
      </div>)}
      <div className="review-submit">
        {included.length > 0 && <p className="review-included">{included.length} inline {included.length === 1 ? "comment" : "comments"} included</p>}
        <div className="review-submit-actions" role="group" aria-label="Submit review">
          <button disabled={busy || stale || (!draft.body.trim() && !included.length)} onClick={() => void submitReview("COMMENT")}><svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3.5 3h9A1.5 1.5 0 0 1 14 4.5v6a1.5 1.5 0 0 1-1.5 1.5H6l-4 2V4.5A1.5 1.5 0 0 1 3.5 3Z" /></svg>Comment</button>
          <button className="review-approve" disabled={busy || stale || included.length !== draft.comments.length} onClick={() => void submitReview("APPROVE")}><svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m3 8 3.5 3.5L13 5" /></svg>Approve</button>
          <button className="review-request-changes" disabled={busy || stale || (!draft.body.trim() && !included.length)} onClick={() => void submitReview("REQUEST_CHANGES")}><svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M5 3 2 6l3 3M2 6h7a4 4 0 0 1 0 8" /></svg>Request changes</button>
        </div>
        <p className="muted">Drafts are saved to Biff, with a browser recovery copy. These actions submit to GitHub.</p>
      </div>
    </section>
  </OverviewDialog>;
}

/** A later successful review may cover an older failed attempt, but never different words or review outcomes. */
function acknowledgeCoveredReviews(published: ReviewIntent) {
  for (const [key, prior] of reviewIntents) {
    if (prior.scope !== published.scope || prior.event !== published.event || prior.draft.body.trim() && prior.draft.body !== published.draft.body) continue;
    if (!prior.draft.comments.every((comment) => published.draft.comments.some((entry) => entry.id === comment.id && entry.body === comment.body))) continue;
    backgroundSaves.acknowledgeFailed(prior.scope, prior.id);
    reviewIntents.delete(key);
  }
}

/** Recover the same publication after a lost response, including after a browser or service restart. */
async function submissionId(endpoint: string, event: ReviewSubmission["event"], draft: ReviewDraft): Promise<{ id: string; key: string }> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([event, draft.body, draft.comments.map((comment) => [comment.id, comment.body])])));
  const hash = Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const key = `biff:review-submission:${endpoint}:${hash}`;
  const existing = localStorage.getItem(key);
  if (existing) return { id: existing, key };
  const id = crypto.randomUUID();
  localStorage.setItem(key, id);
  return { id, key };
}
