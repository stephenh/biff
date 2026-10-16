import { useEffect, useRef, useState } from "react";
import { sameLine, type CommentSelection, type LineThread } from "./lineComments";
import { MentionTextarea } from "./MentionTextarea";

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
  async function saveComment() {
    setBusy(true);
    setError("");
    try { await props.onSaveComment(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save comment."); }
    finally { setBusy(false); }
  }

  return <dialog ref={dialog} className="comment-overlay" data-comment-overlay aria-labelledby="comment-overlay-title" style={{ top, maxHeight: `calc(100dvh - ${top + 20}px)` }} onCancel={(event) => { event.preventDefault(); if (!busy) props.onClose(); }} onClick={(event) => {
    if (event.target === event.currentTarget && !busy) {
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) props.onClose();
    }
  }}>
    <div className="panel-heading"><h2 id="comment-overlay-title">{published ? "Comment thread" : props.thread ? "Review comment" : "New comment"}</h2><button disabled={busy} onClick={props.onClose} aria-label="Close comment thread">×</button></div>
    <p className="muted">{props.selection.line.path}:{props.selection.line.line} · {props.selection.line.side === "LEFT" ? "old" : "new"} side</p>
    {related.length > 1 && <nav className="overlay-threads" aria-label="Threads on this line">{related.map((thread) => <button key={thread.id} aria-pressed={thread.id === props.thread?.id} onClick={() => props.onSelectThread(thread)}>{thread.comments[0].user.login} · {thread.comments[0].body.trim().split(/\s+/).slice(0, 4).join(" ")}</button>)}</nav>}
    {published && <div className="overlay-thread">{props.thread!.comments.map((comment) => <article className="discussion-comment" key={comment.id}>
      <div><strong>{comment.user.login}</strong> <a href={comment.html_url} target="_blank" rel="noreferrer" aria-label={`Open ${comment.user.login}'s comment on GitHub`}>↗</a></div>
      <div className="markdown-text">{comment.body}</div>
    </article>)}</div>}
    {(error || props.storageError) && <p className="error" role="alert">{error || props.storageError}</p>}
    {props.stale && <p className="error" role="alert">This review draft belongs to an older PR head. Start a fresh draft in Discussion & review before saving a review comment.</p>}
    <label>{published ? "Reply" : "Comment"}<MentionTextarea endpoint={props.endpoint} textareaRef={composer} label={published ? "Thread reply" : "Inline comment"} placeholder={published ? "Write a reply…" : "Write a comment…"} value={props.body} onValueChange={props.onBodyChange} /></label>
    <div className="card-actions">
      <button disabled={busy || !props.body.trim()} onClick={() => void saveComment()}>{busy ? "Saving…" : "Save as Comment"}</button>
      {!published && <button className="primary" disabled={busy || props.stale || !props.body.trim()} onClick={props.onSaveReviewComment}>Save as Review Comment</button>}
    </div>
    <p className="muted">{published ? "Replies are published to GitHub immediately." : "Comments publish immediately. Review comments stay in your draft until you submit the review."}</p>
  </dialog>;
}
