import { useEffect, useRef, useState } from "react";
import { sameLine, type CommentSelection, type LineThread } from "./lineComments";
import { MentionTextarea } from "./MentionTextarea";
import { EditableComment } from "./EditableComment";
import { post } from "./api";
import { ThreadResolution } from "./ThreadResolution";
import { CommentHeader } from "./CommentHeader";

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
 * The native dialog supplies focus containment, Escape dismissal, and focus return.
 * The caller retains unsaved text when this overlay closes or switches threads.
 */
export function CommentOverlay(props: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const published = props.thread && props.thread.draftIndex === undefined;
  const related = props.threads.filter((thread) => sameLine(thread.location, props.selection.line));
  const top = Math.max(90, Math.min(props.selection.anchor?.bottom ?? 180, window.innerHeight - 480));

  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    // Focus after opening so the native dialog does not select the close button instead.
    composer.current?.focus();
    return () => element.close();
  }, []);

  /** Keep the composer and its text available when GitHub rejects a write. */
  async function saveComment(local = false) {
    setBusy(true);
    setError("");
    try { if (local) await props.onSaveLocalComment?.(); else await props.onSaveComment(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save comment."); }
    finally { setBusy(false); }
  }

  return <dialog ref={dialog} className="comment-overlay" data-comment-overlay aria-labelledby="comment-overlay-title" style={{ top, maxHeight: `calc(100dvh - ${top + 20}px)` }} onCancel={(event) => { event.preventDefault(); if (!busy) props.onClose(); }} onClick={(event) => {
    if (event.target === event.currentTarget && !busy) {
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) props.onClose();
    }
  }}>
    <CommentHeader title={published ? "Comment thread" : props.thread ? "Review comment" : "New comment"} line={props.selection.line} busy={busy} onClose={props.onClose} status={<span className={`comment-visibility ${published ? "published" : "local"}`} title={published ? "Published to GitHub" : "Not published to GitHub"}>{published ? "GitHub" : "Local"}</span>} />
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
      {published && <ThreadResolution endpoint={props.endpoint} thread={props.thread?.comments[0].reviewThread} onChanged={props.onCommentChanged} />}
      {!published && <button className="primary" disabled={busy || props.stale || !props.body.trim()} onClick={props.onSaveReviewComment}>Save as Review Comment</button>}
    </div>
    </div>
  </dialog>;
}
