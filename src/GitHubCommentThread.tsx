import { CommentOverlay } from "./CommentOverlay";
import type { CommentSelection, LineThread } from "./lineComments";
import type { useCommentReads } from "./useCommentReads";
import { useDiscussionDraft } from "./discussionDraft";
import { backgroundSaves } from "./optimisticSave";
import { post } from "./api";

/** The inbox, review-wide browser, and inline viewer share one published-thread composer. */
export function GitHubCommentThread(props: {
  endpoint: string; thread: LineThread; threads: LineThread[]; selection: CommentSelection;
  reads: ReturnType<typeof useCommentReads>; onClose(): void; onChanged(): void; onSelectThread(thread: LineThread): void;
}) {
  const replyTo = props.thread.kind ? undefined : props.thread.comments[0].id;
  const draft = useDiscussionDraft(props.endpoint, props.thread.kind ? props.thread.id : String(replyTo));

  /** Save exact text with a stable retry ID; acknowledgement must not clear a newer draft. */
  function publish() {
    const id = crypto.randomUUID();
    void backgroundSaves.submit(`github-comments:${props.endpoint}`, replyTo ? `thread:${replyTo}` : "general", id, `Comment ${props.thread.location.path}`, async () => {
      await post(`${props.endpoint}/comment`, { body: draft.comment, replyTo }, { "Idempotency-Key": id });
      draft.acknowledge();
      props.onChanged();
    });
    props.onClose();
    props.selection.onSubmitted?.();
  }

  return <CommentOverlay endpoint={props.endpoint} thread={props.thread} threads={props.threads} selection={props.selection} reads={props.reads} body={draft.comment} onBodyChange={draft.setComment} stale={false} storageError={draft.error ?? ""} onClose={props.onClose} onSaveComment={publish} onCommentChanged={props.onChanged} onSelectThread={props.onSelectThread} />;
}
