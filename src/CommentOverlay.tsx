import { useRef, useState } from "react";
import { Markdown } from "./Markdown";
import type { CommentSelection, LineThread } from "./lineComments";
import { MentionTextarea } from "./MentionTextarea";
import { EditableComment } from "./EditableComment";
import { post } from "./api";
import { ThreadResolution } from "./ThreadResolution";
import { CommentHeader } from "./CommentHeader";
import { FollowUpButton } from "./FollowUpButton";
import { CommentFrame } from "./CommentFrame";
import { BackgroundSaveStatus } from "./BackgroundSaveStatus";
import { CommentMessages } from "./CommentMessages";
import type { useCommentReads } from "./useCommentReads";

interface Props {
  endpoint: string;
  selection: CommentSelection;
  thread?: LineThread;
  reads: ReturnType<typeof useCommentReads>;
  body: string;
  stale: boolean;
  storageError: string;
  onBodyChange(body: string): void;
  onClose(): void;
  onSaveComment(): void;
  onSaveReviewComment?(): void;
  onSaveLocalComment?(): Promise<void>;
  onCommentChanged(): void;
  onReanchor?(): void;
  onAttachThread?(): void;
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
  const kind = props.thread?.kind;

  /** Keep the local composer available on failure; GitHub submissions have persistent background feedback. */
  async function saveLocalComment() {
    setBusy(true);
    setError("");
    try { await props.onSaveLocalComment?.(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save comment."); }
    finally { setBusy(false); }
  }

  return <CommentFrame selection={props.selection} label={published ? "Comment thread" : props.thread ? "Review comment" : "New comment"} busy={busy} composer={composer} onClose={props.onClose}>
    <CommentHeader title={kind === "general" ? "PR discussion" : kind === "review" ? "Review summary" : published ? "Comment thread" : props.thread ? "Review comment" : "New comment"} line={props.selection.line} embedded={props.selection.embedded} reviewWide={props.selection.reviewWide} hideLine={Boolean(kind)} outdated={props.thread?.outdated} busy={busy} onClose={props.onClose} status={<span className={`comment-visibility ${published ? "published" : "local"}`} title={published ? "Published to GitHub" : "Not published to GitHub"}>{published ? "GitHub" : "Local"}</span>} />
    <div className="comment-body">
    {published && <CommentMessages thread={props.thread} reads={props.reads}>{props.thread!.comments.map((comment) => <article className="discussion-comment" key={comment.id}>
      {kind === "review" ? <><div className="comment-author"><strong>{comment.user.login}</strong></div><Markdown body={comment.body} /></> : <EditableComment own={Boolean(comment.own)} header={<strong>{comment.user.login}</strong>} body={comment.body} onEdit={async (body) => { await post(`${props.endpoint}/comment-edit`, { id: comment.id, kind: kind ?? "inline", action: "edit", body }); props.onCommentChanged(); }} onDelete={async () => { await post(`${props.endpoint}/comment-edit`, { id: comment.id, kind: kind ?? "inline", action: "delete" }); props.onCommentChanged(); props.onClose(); }} />}
    </article>)}</CommentMessages>}
    {(error || props.storageError) && <p className="error" role="alert">{error || props.storageError}</p>}
    {props.thread?.needsReanchoring && <p className="error">This thread's original hunk changed or could not be found. Its text and GitHub link are kept; choose a new line to place it.</p>}
    <BackgroundSaveStatus scope={`github-comments:${props.endpoint}`} />
    <BackgroundSaveStatus scope={`review-draft:${props.endpoint}`} />
    {props.stale && !published && <p className="error" role="alert">This review draft belongs to an older PR head. Start a fresh draft in PR overview before saving a review comment.</p>}
    <label className="comment-composer">{kind ? "Comment on PR" : published ? "Reply" : "Comment"}<MentionTextarea endpoint={props.endpoint} textareaRef={composer} label={kind ? "Discussion comment" : published ? "Thread reply" : "Inline comment"} placeholder={published && !kind ? "Write a reply…" : "Write a comment…"} value={props.body} onValueChange={props.onBodyChange} /></label>
    <div className="comment-actions">
      {props.onAttachThread && <button className="primary" onClick={props.onAttachThread}>Attach thread here</button>}
      {props.onReanchor && props.thread?.needsReanchoring && <button onClick={props.onReanchor}>Choose new line</button>}
      {!published && props.onSaveLocalComment && <button disabled={busy || !props.body.trim()} onClick={() => void saveLocalComment()}>Save locally</button>}
      <button disabled={busy || !props.body.trim()} onClick={props.onSaveComment}>Save as Comment</button>
      {published && !props.selection.embedded && <ThreadResolution endpoint={props.endpoint} thread={props.thread?.comments[0]?.reviewThread} keys={props.thread?.comments.map((comment) => `github:${comment.id}`) ?? []} onChanged={props.onCommentChanged} />}
      {published && !kind && props.thread && <FollowUpButton endpoint={props.endpoint} thread={`github:${props.thread.comments[0].id}`} />}
      {!published && props.onSaveReviewComment && <button className="primary" disabled={busy || props.stale || !props.body.trim()} onClick={props.onSaveReviewComment}>Save as Review Comment</button>}
    </div>
    </div>
  </CommentFrame>;
}
