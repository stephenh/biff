import { useState, type CSSProperties, type ReactNode } from "react";
import type { FileDiffMetadata } from "@pierre/diffs";
import type { FileViewedState } from "../shared/types";
import type { FileEntry } from "./fileOrder";
import { FileChangeTag } from "./FileChangeTag";
import { UnreadThreadBadge } from "./UnreadThreadBadge";

interface Props {
  entries: FileEntry<Pick<FileDiffMetadata, "name" | "type">>[];
  index: number;
  viewedFiles?: Record<string, FileViewedState>;
  unreadThreads?: Record<string, number>;
  currentProgress?: ReactNode;
  currentReviewToggle?: ReactNode;
  onOpenComments(index: number): void;
  onSelect(index: number): void;
}

/** Center the current basename while adjacent files slide through the rail. */
export function FileRail(props: Props) {
  return <div className="file-rail">
    <div className="file-rail-track" style={{ "--file-index": props.index } as CSSProperties}>
      {props.entries.map((entry, index) => <div className={`file-tile${index === props.index ? " current-file" : ""}`} key={entry.file.name}>
        <div className="file-name-box">
        {index === props.index && props.currentReviewToggle}
        <FileChangeTag type={entry.file.type} />
        {index === props.index ?
        <CopyPath path={entry.file.name} viewed={props.viewedFiles?.[entry.file.name] === "VIEWED"} />
       : <button className="file-neighbor" title={entry.file.name} aria-label={`Open ${entry.file.name}`} tabIndex={Math.abs(index - props.index) === 1 ? 0 : -1} onClick={() => props.onSelect(index)}>
        <span className={props.viewedFiles?.[entry.file.name] === "VIEWED" ? "viewed-file" : undefined}>{basename(entry.file.name)}</span>
       </button>}
        {index === props.index && props.currentProgress}
        {(props.unreadThreads?.[entry.file.name] ?? 0) > 0 && <button className="unread-thread-trigger" aria-label={`${props.unreadThreads![entry.file.name]} unread threads in ${entry.file.name}`} tabIndex={Math.abs(index - props.index) <= 1 ? 0 : -1} onClick={() => props.onOpenComments(index)}><UnreadThreadBadge count={props.unreadThreads![entry.file.name]} /></button>}
        </div>
      </div>)}
    </div>
  </div>;
}

/** Copy the repository-relative path without changing the selected file. */
function CopyPath(props: { path: string; viewed: boolean }) {
  const [status, setStatus] = useState("");

  async function copy() {
    try { await navigator.clipboard.writeText(props.path); setStatus("Copied!"); }
    catch { setStatus("Could not copy path"); }
  }

  return <><button type="button" className="current-file-name" aria-label={`Copy path ${props.path}`} title={status || "Click to copy relative path"} onClick={() => void copy()} onMouseLeave={() => setStatus("")} onBlur={() => setStatus("")}>
    <span className={props.viewed ? "viewed-file" : undefined} aria-label="Current file" title={props.path}>{basename(props.path)}</span>
  </button>
    <span className="copy-path-status" role="status">{status}</span>
  </>;
}

/** Keep directory information in tooltips rather than the horizontal labels. */
function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}
