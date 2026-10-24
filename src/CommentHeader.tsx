import type { ReactNode } from "react";
import type { ReviewLine } from "../shared/types";
import { ModalHeader } from "./ModalHeader";
import { messageShortcuts } from "./shortcutDefinitions";

/** Keep the title, file anchor, and dismiss action in the same place in every comment dialog. */
export function CommentHeader(props: { title: string; line: ReviewLine; status: ReactNode; busy: boolean; outdated?: boolean; embedded?: boolean; reviewWide?: boolean; hideLine?: boolean; onClose(): void }) {
  const location = <div className="comment-location"><span title={props.line.path}>{props.line.path}</span>{!props.hideLine && <span className="comment-coordinate">:L{props.line.line}{props.line.side === "LEFT" ? " · old" : ""}</span>}{props.outdated && <span className="comment-outdated">Outdated snapshot</span>}</div>;

  if (props.embedded) return <div className="comment-header comment-header-compact">
    <button className="comment-back" disabled={props.busy} onClick={props.onClose} aria-label={`Back to ${props.reviewWide ? "review" : "file"} comments`}>← All comments</button>
    {location}
  </div>;

  return <div className="comment-header">
    <ModalHeader title={<>{props.title} {props.status}</>} titleId="comment-overlay-title" closeLabel="Close comment thread" closeDisabled={props.busy} onClose={props.onClose} shortcuts={[...(props.title !== "New comment" ? messageShortcuts : []), ...(!props.busy ? [{ keys: "Escape", description: "Close" }] : [])]} />
    {location}
  </div>;
}
