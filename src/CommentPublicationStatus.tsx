import type { DiscussionComment } from "../shared/types";

/** Show publication feedback beside submitted text; Retry stays in the shared save indicator. */
export function CommentPublicationStatus(props: { comment: DiscussionComment }) {
  const status = props.comment.publication?.status;
  if (!status) return null;
  return <span className="muted" role="status">{status === "saving" ? "Saving…" : status === "error" ? "Not published · Retry in Activity" : "Saved"}</span>;
}
