import { useState, type ReactNode } from "react";
import type { Conversation, DiscussionComment, GitHubReview, ReviewLine, ReviewSubmission } from "../shared/types";
import { post, type useResource } from "./api";
import type { ReviewDraftState } from "./reviewDraft";
import { MentionTextarea } from "./MentionTextarea";

interface Props {
  endpoint: string;
  review: GitHubReview;
  selected?: ReviewLine;
  onClose(): void;
  onViewLine(line: ReviewLine): void;
  draftState: ReviewDraftState;
  conversation: ReturnType<typeof useResource<Conversation>>;
  onCompose(line: ReviewLine): void;
  localDiscussion?: ReactNode;
}

/** Read discussion and compose explicit GitHub writes, with drafts kept across tabs. */
export function ReviewPanel(props: Props) {
  const { draft, setDraft, storageError } = props.draftState;
  const [event, setEvent] = useState<ReviewSubmission["event"]>("COMMENT");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [comment, setComment] = useState("");
  const [reply, setReply] = useState<number>();
  const conversation = props.conversation;
  const stale = draft.commitId !== props.review.pr.head.sha;

  async function submitReview() {
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
      <div className="inline-composer">
        <p className="muted">{props.selected ? `${props.selected.path}:${props.selected.line} (${props.selected.side === "LEFT" ? "old" : "new"})` : "Select a line in All changes to add an inline comment."}</p>
        <button disabled={busy || stale || !props.selected} onClick={() => props.selected && props.onCompose(props.selected)}>Comment on selected line</button>
      </div>
      {draft.comments.map((entry, index) => <div className="draft-comment" key={index}>
        <div className="card-actions"><span>{entry.path}:{entry.line} · {entry.side}</span><button onClick={() => setDraft((current) => ({ ...current, comments: current.comments.filter((_, item) => item !== index) }))}>Remove</button></div>
        <MentionTextarea endpoint={props.endpoint} label={`Draft comment ${index + 1}`} value={entry.body} onValueChange={(body) => setDraft((current) => ({ ...current, comments: current.comments.map((item, itemIndex) => itemIndex === index ? { ...item, body } : item) }))} />
      </div>)}
      <div className="card-actions"><select aria-label="Review action" value={event} onChange={(change) => setEvent(change.target.value as ReviewSubmission["event"])}><option value="COMMENT">Comment</option><option value="APPROVE">Approve</option><option value="REQUEST_CHANGES">Request changes</option></select><button className="primary" disabled={busy || stale || (event !== "APPROVE" && !draft.body.trim() && !draft.comments.length)} onClick={() => void submitReview()}>Submit review{draft.comments.length ? ` (${draft.comments.length} inline)` : ""}</button></div>
      <p className="muted">Draft saved in this browser. Submit sends it to GitHub.</p>
    </section>

    <section><div className="page-heading"><h3>Conversation</h3></div>
      {conversation.loading && <p role="status">Loading discussion…</p>}
      {conversation.data?.reviews.filter((entry) => entry.body || entry.state !== "COMMENTED").map((entry) => <Comment key={`review-${entry.id}`} comment={entry} />)}
      {conversation.data?.comments.map((entry) => <Comment key={`comment-${entry.id}`} comment={entry} />)}
      {conversation.data?.inline.filter((entry) => !entry.in_reply_to_id).map((entry) => <div className="thread" key={entry.id}>
        <Comment comment={entry} />
        {entry.line != null && props.review.commit === "all" && <button onClick={() => props.onViewLine({ path: entry.path!, line: entry.line!, side: entry.side || "RIGHT" })}>View line</button>}
        {conversation.data!.inline.filter((child) => child.in_reply_to_id === entry.id).map((child) => <Comment key={child.id} comment={child} />)}
        <button onClick={() => { setReply(entry.id); setComment(""); }}>Reply to thread</button>
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
function Comment(props: { comment: DiscussionComment }) {
  const comment = props.comment;
  return <article className="discussion-comment"><div><strong>{comment.user.login}</strong> <span className="muted">{comment.state?.replaceAll("_", " ")}</span> <a href={comment.html_url} target="_blank" rel="noreferrer">↗</a> {comment.path && comment.line == null && <span className="muted">· outdated</span>}</div>{comment.path && <p className="muted">{comment.path}:{comment.line ?? comment.original_line}</p>}<div className="markdown-text">{comment.body}</div></article>;
}
