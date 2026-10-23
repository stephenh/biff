import { useState } from "react";
import { Link } from "wouter";
import type { PullRequest, ReviewSubmission } from "../shared/types";
import type { ReviewDraftState } from "./reviewDraft";
import { post } from "./api";
import { MentionTextarea } from "./MentionTextarea";
import { OverviewDialog } from "./OverviewDialog";

/** PR metadata and review submission stay separate from browsing comment threads. */
export function PullRequestOverview(props: { endpoint: string; pr: PullRequest; draftState: ReviewDraftState; onClose(): void; onSubmitted?(): void }) {
  const { draft, setDraft, olderDrafts, storageError } = props.draftState;
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const stale = draft.commitId !== props.pr.head.sha;

  /** Each review action submits the same draft with its explicit GitHub outcome. */
  async function submitReview(event: ReviewSubmission["event"]) {
    setBusy(true); setError("");
    try {
      await post(`${props.endpoint}/review`, { ...draft, event });
      setDraft({ commitId: props.pr.head.sha, body: "", comments: [] });
      props.onSubmitted?.();
      props.onClose();
    } catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  }

  return <OverviewDialog busy={busy} onClose={props.onClose}>
    <p><strong>{props.pr.title}</strong> · <Link href={props.endpoint.replace("/api/github", "")} onClick={props.onClose}>Open diff</Link></p>
    <p className="muted">{props.pr.user.login} · {props.pr.state} · {props.pr.head.ref} → {props.pr.base.ref}</p>
    <h3>Description</h3><div className="markdown-text">{props.pr.body || "No description."}</div>
    {(error || storageError) && <p className="error" role="alert">{error || storageError}</p>}
    <section className="review-compose">
      <h3>Your review</h3>
      {olderDrafts.length > 0 && <details className="older-review-drafts">
        <summary>Earlier drafts ({olderDrafts.length})</summary>
        <p className="muted">These notes were saved on earlier commits and are kept here to read or copy. They are not included in the current review.</p>
        {olderDrafts.map((older) => <section key={older.commitId} aria-label={`Draft on commit ${older.commitId}`}>
          <h4>Commit {older.commitId.slice(0, 8)}</h4>
          {older.body && <div className="markdown-text">{older.body}</div>}
          {older.comments.map((entry, index) => <article className="draft-comment" key={index}>
            <p className="muted">{entry.path}:{entry.line} · {entry.side}</p>
            <div className="markdown-text">{entry.body}</div>
          </article>)}
        </section>)}
      </details>}
      {stale && <p className="error">This draft belongs to an older PR head. Copy anything you want to keep, then <button onClick={() => setDraft({ commitId: props.pr.head.sha, body: "", comments: [] })}>Start a fresh draft</button>.</p>}
      <label>Summary<MentionTextarea endpoint={props.endpoint} label="Review summary" value={draft.body} onValueChange={(body) => setDraft((current) => ({ ...current, body }))} /></label>
      {draft.comments.map((entry, index) => <div className="draft-comment" key={index}>
        <div className="card-actions"><span>{entry.path}:{entry.line} · {entry.side}</span><button onClick={() => setDraft((current) => ({ ...current, comments: current.comments.filter((_, item) => item !== index) }))}>Remove</button></div>
        <MentionTextarea endpoint={props.endpoint} label={`Draft comment ${index + 1}`} value={entry.body} onValueChange={(body) => setDraft((current) => ({ ...current, comments: current.comments.map((item, itemIndex) => itemIndex === index ? { ...item, body } : item) }))} />
      </div>)}
      <div className="review-submit">
        {draft.comments.length > 0 && <p className="review-included">{draft.comments.length} inline {draft.comments.length === 1 ? "comment" : "comments"} included</p>}
        <div className="review-submit-actions" role="group" aria-label="Submit review">
          <button disabled={busy || stale || (!draft.body.trim() && !draft.comments.length)} onClick={() => void submitReview("COMMENT")}><svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3.5 3h9A1.5 1.5 0 0 1 14 4.5v6a1.5 1.5 0 0 1-1.5 1.5H6l-4 2V4.5A1.5 1.5 0 0 1 3.5 3Z" /></svg>Comment</button>
          <button className="review-approve" disabled={busy || stale} onClick={() => void submitReview("APPROVE")}><svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m3 8 3.5 3.5L13 5" /></svg>Approve</button>
          <button className="review-request-changes" disabled={busy || stale || (!draft.body.trim() && !draft.comments.length)} onClick={() => void submitReview("REQUEST_CHANGES")}><svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M5 3 2 6l3 3M2 6h7a4 4 0 0 1 0 8" /></svg>Request changes</button>
        </div>
        <p className="muted">Draft saved in this browser. These actions submit to GitHub.</p>
      </div>
    </section>
  </OverviewDialog>;
}
