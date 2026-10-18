import { useState, type CSSProperties } from "react";
import type { FileViewedState } from "../shared/types";
import type { FileEntry } from "./fileOrder";

interface Props {
  entries: FileEntry<{ name: string }>[];
  index: number;
  viewedFiles?: Record<string, FileViewedState>;
  onSelect(index: number): void;
}

/** Center the current basename while adjacent files slide through the rail. */
export function FileRail(props: Props) {
  return <div className="file-rail">
    <div className="file-rail-track" style={{ "--file-index": props.index } as CSSProperties}>
      {props.entries.map((entry, index) => <div className={`file-tile${index === props.index ? " current-file" : ""}`} key={entry.file.name}>
        <div className="file-name-box">
        {index === props.index ?
        <CopyPath path={entry.file.name} viewed={props.viewedFiles?.[entry.file.name] === "VIEWED"} />
       : <button className="file-neighbor" title={entry.file.name} aria-label={`Open ${entry.file.name}`} tabIndex={Math.abs(index - props.index) === 1 ? 0 : -1} onClick={() => props.onSelect(index)}>
        <span className={props.viewedFiles?.[entry.file.name] === "VIEWED" ? "viewed-file" : undefined}>{basename(entry.file.name)}</span>
      </button>}
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
