import { useState, type ReactNode } from "react";
import type { Conversation, DiscussionComment, GitHubReview, ReviewLine, ReviewSubmission } from "../shared/types";
import { post, type useResource } from "./api";
import type { ReviewDraftState } from "./reviewDraft";
import { MentionTextarea } from "./MentionTextarea";
import { EditableComment } from "./EditableComment";
import { ThreadResolution } from "./ThreadResolution";

interface Props {
  endpoint: string;
  review: GitHubReview;
  onClose(): void;
  onViewLine(line: ReviewLine): void;
  onOpenThread(id: string, line: ReviewLine): void;
  draftState: ReviewDraftState;
  conversation: ReturnType<typeof useResource<Conversation>>;
  localDiscussion?: ReactNode;
}

/** Read discussion and compose explicit GitHub writes, with drafts kept across tabs. */
export function ReviewPanel(props: Props) {
  const { draft, setDraft, storageError } = props.draftState;
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [comment, setComment] = useState("");
  const [reply, setReply] = useState<number>();
  const conversation = props.conversation;
  const stale = draft.commitId !== props.review.pr.head.sha;

  /** Each review action submits the same draft with its explicit GitHub outcome. */
  async function submitReview(event: ReviewSubmission["event"]) {
    setBusy(true); setError(""); setMessage("");
    try {
      await post(`${props.endpoint}/review`, { ...draft, event });
      setDraft({ commitId: props.review.pr.head.sha, body: "", comments: [] });
      setMessage("Review submitted to GitHub."); conversation.refresh();
    } catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  }

  async function sendComment() {
    setBusy(true); setError(""); setMessage("");
    try {
      await post(`${props.endpoint}/comment`, { body: comment, replyTo: reply });
      setComment(""); setReply(undefined); setMessage("Comment posted to GitHub."); conversation.refresh();
    } catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  }

  return <aside className="review-panel" aria-label="PR discussion and review">
    <div className="panel-heading"><h2>Discussion & review</h2><button onClick={props.onClose} aria-label="Close discussion">×</button></div>
    <p className="muted">{props.review.pr.user.login} · {props.review.pr.state} · {props.review.pr.head.ref} → {props.review.pr.base.ref}</p>
    <details><summary>Description</summary><div className="markdown-text">{props.review.pr.body || "No description."}</div></details>
    {(error || conversation.error || storageError) && <p className="error" role="alert">{error || conversation.error || storageError}</p>}
    {message && <p className="success" role="status">{message}</p>}

    {props.localDiscussion}
    <section className="review-compose">
      <h3>Your review</h3>
      {stale && <p className="error">This draft belongs to an older PR head. Copy anything you want to keep, then <button onClick={() => setDraft({ commitId: props.review.pr.head.sha, body: "", comments: [] })}>Start a fresh draft</button>.</p>}
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

    <section><div className="page-heading"><h3>Conversation</h3></div>
      {conversation.loading && <p role="status">Loading discussion…</p>}
      {conversation.data?.reviews.filter((entry) => entry.body || entry.state !== "COMMENTED").map((entry) => <Comment key={`review-${entry.id}`} comment={entry} />)}
      {conversation.data?.comments.map((entry) => <Comment key={`comment-${entry.id}`} comment={entry} endpoint={props.endpoint} kind="general" onChanged={conversation.refresh} />)}
      {conversation.data?.inline.filter((entry) => !entry.in_reply_to_id).map((entry) => <div className="thread" key={entry.id}>
        <Comment comment={entry} endpoint={props.endpoint} kind="inline" onChanged={conversation.refresh} onOpen={entry.path && entry.line != null && props.review.commit === "all" ? () => props.onOpenThread(`comment-${entry.id}`, { path: entry.path!, line: entry.line!, side: entry.side ?? "RIGHT" }) : undefined} />
        {entry.line != null && props.review.commit === "all" && <button onClick={() => props.onViewLine({ path: entry.path!, line: entry.line!, side: entry.side || "RIGHT" })}>View line</button>}
        {conversation.data!.inline.filter((child) => child.in_reply_to_id === entry.id).map((child) => <Comment key={child.id} comment={child} endpoint={props.endpoint} kind="inline" onChanged={conversation.refresh} onOpen={entry.path && entry.line != null && props.review.commit === "all" ? () => props.onOpenThread(`comment-${entry.id}`, { path: entry.path!, line: entry.line!, side: entry.side ?? "RIGHT" }) : undefined} />)}
        <button onClick={() => { setReply(entry.id); setComment(""); }}>Reply to thread</button>
        <ThreadResolution endpoint={props.endpoint} thread={entry.reviewThread} onChanged={conversation.refresh} />
      </div>)}
      <form onSubmit={(change) => { change.preventDefault(); void sendComment(); }}>
        <h4>{reply ? "Reply to thread" : "General comment"}</h4>
        {reply && <button type="button" onClick={() => setReply(undefined)}>Cancel reply</button>}
        <MentionTextarea endpoint={props.endpoint} label="Discussion comment" value={comment} onValueChange={setComment} />
        <button disabled={busy || !comment.trim()}>Post comment</button>
      </form>
    </section>
  </aside>;
}

/** Render untrusted GitHub content as text, retaining markdown for copy/paste. */
function Comment(props: { comment: DiscussionComment; endpoint?: string; kind?: "inline" | "general"; onChanged?(): void; onOpen?(): void }) {
  const comment = props.comment;
  const header = <><strong>{comment.user.login}</strong><span className="muted">{comment.state?.replaceAll("_", " ")}</span>{comment.path && comment.line == null && <span className="muted">· outdated</span>}</>;
  const link = <a href={comment.html_url} target="_blank" rel="noreferrer" aria-label={`Open ${comment.user.login}'s comment on GitHub`}>↗</a>;
  return <article className="discussion-comment">{comment.path && <p className="muted">{props.onOpen ? <button className="text-button comment-location-link" onClick={props.onOpen}>{comment.path}:{comment.line ?? comment.original_line}</button> : `${comment.path}:${comment.line ?? comment.original_line}`}</p>}{props.endpoint ? <EditableComment header={header} link={link} body={comment.body} onOpen={props.onOpen} onEdit={async (body) => { await post(`${props.endpoint}/comment-edit`, { id: comment.id, kind: props.kind, action: "edit", body }); props.onChanged?.(); }} onDelete={async () => { await post(`${props.endpoint}/comment-edit`, { id: comment.id, kind: props.kind, action: "delete" }); props.onChanged?.(); }} /> : <><div className="comment-author">{header}{link}</div><div className="markdown-text">{comment.body}</div></>}</article>;
}
