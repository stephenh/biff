import type { ReactNode } from "react";
import type { ReviewLine } from "../shared/types";

/** Keep the title, file anchor, and dismiss action in the same place in every comment dialog. */
export function CommentHeader(props: { title: string; line: ReviewLine; status: ReactNode; busy: boolean; outdated?: boolean; onClose(): void }) {
  return <div className="comment-header">
    <div className="comment-heading"><h2 id="comment-overlay-title">{props.title}</h2>{props.status}</div>
    <button className="comment-close" disabled={props.busy} onClick={props.onClose} aria-label="Close comment thread" title="Close (Esc)">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
    </button>
    <div className="comment-location"><span title={props.line.path}>{props.line.path}</span><span className="comment-line">L{props.line.line}{props.line.side === "LEFT" ? " · old" : ""}</span>{props.outdated && <span className="comment-outdated">Outdated snapshot</span>}</div>
  </div>;
}
