import type { ReactNode } from "react";
import type { ReviewLine } from "../shared/types";
import { ModalHeader } from "./ModalHeader";

/** Keep the title, file anchor, and dismiss action in the same place in every comment dialog. */
export function CommentHeader(props: { title: string; line: ReviewLine; status: ReactNode; busy: boolean; outdated?: boolean; embedded?: boolean; reviewWide?: boolean; hideLine?: boolean; onClose(): void }) {
  return <div className="comment-header">
    {props.embedded && <button className="comment-back" disabled={props.busy} onClick={props.onClose} aria-label={`Back to ${props.reviewWide ? "review" : "file"} comments`}>← All comments</button>}
    {props.embedded ? <div className="comment-heading"><h2 id="comment-overlay-title">{props.title}</h2>{props.status}</div> :
      <ModalHeader title={<>{props.title} {props.status}</>} titleId="comment-overlay-title" closeLabel="Close comment thread" closeDisabled={props.busy} onClose={props.onClose} />}
    <div className="comment-location"><span title={props.line.path}>{props.line.path}</span>{!props.hideLine && <span className="comment-line">L{props.line.line}{props.line.side === "LEFT" ? " · old" : ""}</span>}{props.outdated && <span className="comment-outdated">Outdated snapshot</span>}</div>
  </div>;
}
