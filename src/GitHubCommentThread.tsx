import { CommentOverlay } from "./CommentOverlay";
import type { CommentSelection, LineThread } from "./lineComments";
import type { useCommentReads } from "./useCommentReads";
import { useDiscussionDraft } from "./discussionDraft";
import { backgroundSaves } from "./optimisticSave";
import { post } from "./api";
import type { DiscussionComment } from "../shared/types";
import { commentPublications, publicationPending } from "./commentPublications";

/** The inbox, review-wide browser, and inline viewer share one published-thread composer. */
export function GitHubCommentThread(props: {
  endpoint: string; thread: LineThread; selection: CommentSelection;
  reads: ReturnType<typeof useCommentReads>; onClose(): void; onChanged(): void;
  onReanchor?(): void;
}) {
  const replyTo = props.thread.kind ? undefined : props.thread.comments[0].id;
  const draft = useDiscussionDraft(props.endpoint, props.thread.kind ? props.thread.id : String(replyTo));

  /** Save exact text with a stable retry ID; acknowledgement must not clear a newer draft. */
  function publish() {
    if (!draft.comment.trim() || !props.thread.kind && props.thread.comments[0] && publicationPending(props.thread.comments[0])) return;
    const id = crypto.randomUUID();
    commentPublications.add(props.endpoint, id, replyTo ? "inline" : "comments", { body: draft.comment, user: { login: "You" }, html_url: "", ...(replyTo ? { in_reply_to_id: replyTo } : {}) });
    void backgroundSaves.submit(`github-comments:${props.endpoint}`, replyTo ? `thread:${replyTo}` : "general", id, `Comment ${props.thread.location.path}`, async () => {
      const comment = await post<DiscussionComment>(`${props.endpoint}/comment`, { body: draft.comment, replyTo }, { "Idempotency-Key": id });
      commentPublications.acknowledge(props.endpoint, id, comment);
      // Use the submitted thread snapshot so replies arriving during publication stay unread.
      props.reads.markRead(props.thread);
      draft.acknowledge();
      props.onChanged();
    });
    props.onClose();
    props.selection.onSubmitted?.();
  }

  return <CommentOverlay endpoint={props.endpoint} thread={props.thread} selection={props.selection} reads={props.reads} body={draft.comment} onBodyChange={draft.setComment} stale={false} storageError={draft.error ?? ""} onClose={props.onClose} onSaveComment={publish} onCommentChanged={props.onChanged} onReanchor={props.onReanchor} />;
}
