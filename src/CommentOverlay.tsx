import { useRef, useState } from "react";
import { sameLine, type CommentSelection, type LineThread } from "./lineComments";
import { MentionTextarea } from "./MentionTextarea";
import { EditableComment } from "./EditableComment";
import { post } from "./api";
import { ThreadResolution } from "./ThreadResolution";
import { CommentHeader } from "./CommentHeader";
import { FollowUpButton } from "./FollowUpButton";
import { CommentFrame } from "./CommentFrame";

interface Props {
  endpoint: string;
  selection: CommentSelection;
  thread?: LineThread;
  threads: LineThread[];
  body: string;
  stale: boolean;
  storageError: string;
  onBodyChange(body: string): void;
  onClose(): void;
  onSaveComment(): Promise<void>;
  onSaveReviewComment(): void;
  onSaveLocalComment?(): Promise<void>;
  onCommentChanged(): void;
  onSelectThread(thread: LineThread): void;
}

/**
 * Read a thread or compose a line comment without changing the diff layout.
 *
 * The shared frame supplies either a line dialog or an embedded page inside file comments.
 * The caller retains unsaved text when this composer closes or switches threads.
 */
export function CommentOverlay(props: Props) {
  const composer = useRef<HTMLTextAreaElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const published = props.thread && props.thread.draftIndex === undefined;
  const related = props.threads.filter((thread) => Boolean(thread.outdated) === Boolean(props.thread?.outdated) && sameLine(thread.location, props.selection.line));

  /** Keep the composer and its text available when GitHub rejects a write. */
  async function saveComment(local = false) {
    setBusy(true);
    setError("");
    try { if (local) await props.onSaveLocalComment?.(); else await props.onSaveComment(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save comment."); }
    finally { setBusy(false); }
  }

  return <CommentFrame selection={props.selection} label={published ? "Comment thread" : props.thread ? "Review comment" : "New comment"} busy={busy} composer={composer} onClose={props.onClose}>
    <CommentHeader title={published ? "Comment thread" : props.thread ? "Review comment" : "New comment"} line={props.selection.line} embedded={props.selection.embedded} outdated={props.thread?.outdated} busy={busy} onClose={props.onClose} status={<span className={`comment-visibility ${published ? "published" : "local"}`} title={published ? "Published to GitHub" : "Not published to GitHub"}>{published ? "GitHub" : "Local"}</span>} />
    <div className="comment-body">
    {related.length > 1 && <nav className="overlay-threads" aria-label="Threads on this line">{related.map((thread) => <button key={thread.id} aria-pressed={thread.id === props.thread?.id} onClick={() => props.onSelectThread(thread)}>{thread.comments[0].user.login} · {thread.comments[0].body.trim().split(/\s+/).slice(0, 4).join(" ")}</button>)}</nav>}
    {published && <div className="overlay-thread">{props.thread!.comments.map((comment) => <article className="discussion-comment" key={comment.id}>
      <EditableComment header={<strong>{comment.user.login}</strong>} link={<a href={comment.html_url} target="_blank" rel="noreferrer" aria-label={`Open ${comment.user.login}'s comment on GitHub`}>↗</a>} body={comment.body} onEdit={async (body) => { await post(`${props.endpoint}/comment-edit`, { id: comment.id, kind: "inline", action: "edit", body }); props.onCommentChanged(); }} onDelete={async () => { await post(`${props.endpoint}/comment-edit`, { id: comment.id, kind: "inline", action: "delete" }); props.onCommentChanged(); props.onClose(); }} />
    </article>)}</div>}
    {(error || props.storageError) && <p className="error" role="alert">{error || props.storageError}</p>}
    {props.stale && !published && <p className="error" role="alert">This review draft belongs to an older PR head. Start a fresh draft in Discussion & review before saving a review comment.</p>}
    <label className="comment-composer">{published ? "Reply" : "Comment"}<MentionTextarea endpoint={props.endpoint} textareaRef={composer} label={published ? "Thread reply" : "Inline comment"} placeholder={published ? "Write a reply…" : "Write a comment…"} value={props.body} onValueChange={props.onBodyChange} /></label>
    <div className="comment-actions">
      {!published && props.onSaveLocalComment && <button disabled={busy || !props.body.trim()} onClick={() => void saveComment(true)}>Save locally</button>}
      <button disabled={busy || !props.body.trim()} onClick={() => void saveComment()}>{busy ? "Saving…" : "Save as Comment"}</button>
      {published && !props.selection.embedded && <ThreadResolution endpoint={props.endpoint} thread={props.thread?.comments[0].reviewThread} onChanged={props.onCommentChanged} />}
      {published && props.thread && <FollowUpButton endpoint={props.endpoint} thread={`github:${props.thread.comments[0].id}`} />}
      {!published && <button className="primary" disabled={busy || props.stale || !props.body.trim()} onClick={props.onSaveReviewComment}>Save as Review Comment</button>}
    </div>
    </div>
  </CommentFrame>;
}
