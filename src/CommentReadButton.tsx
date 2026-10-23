import { BackgroundSaveStatus } from "./BackgroundSaveStatus";

/** Native Enter activation acknowledges only this thread, never a focused reply editor. */
export function CommentReadButton(props: { unread: number; scope: string; showStatus?: boolean; onRead(): void }) {
  return <div className="comment-read-controls">
    <button data-mark-read aria-disabled={!props.unread} onClick={() => { if (props.unread) props.onRead(); }} title="Mark this thread read (Enter when focused)">{props.unread ? "Mark read" : "Read"}</button>
    {props.showStatus !== false && <BackgroundSaveStatus scope={props.scope} />}
  </div>;
}
