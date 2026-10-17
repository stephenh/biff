import { createElement, useState, type CSSProperties } from "react";
import type { FileViewedState } from "../shared/types";
import type { FileEntry } from "./fileOrder";

interface Props {
  entries: FileEntry<{ name: string }>[];
  index: number;
  viewedFiles?: Record<string, FileViewedState>;
  onSelect(index: number): void;
}

/** Center the current basename in a sliding rail while retaining a jump-to-file list. */
export function FileRail(props: Props) {
  return <div className="file-rail">
    <div className="file-rail-track" style={{ "--file-index": props.index } as CSSProperties}>
      {props.entries.map((entry, index) => <div className={`file-tile${index === props.index ? " current-file" : ""}`} key={entry.file.name}>
        <div className="file-name-box">
        {index === props.index ?
        <select className="file-select" aria-label="Current file" title={entry.file.name} value={props.index} onChange={(event) => props.onSelect(Number(event.target.value))}>
          {/* React's JSX types do not yet list this native customizable-select element. */}
          <button type="button">{createElement("selectedcontent")}</button>
          {props.entries.map((option, optionIndex) => <option key={option.file.name} value={optionIndex} title={option.file.name} aria-label={`${option.file.name}${props.viewedFiles?.[option.file.name] === "VIEWED" ? " ✓" : ""}`}><span className={`file-option-label${props.viewedFiles?.[option.file.name] === "VIEWED" ? " viewed-file" : ""}`}>{basename(option.file.name)}{option.file.name.includes("/") && <small className="file-option-path">{option.file.name}</small>}</span>{props.viewedFiles?.[option.file.name] === "VIEWED" && <span className="file-viewed-check" aria-hidden="true">✓</span>}</option>)}
        </select>
       : <button className="file-neighbor" title={entry.file.name} aria-label={`Open ${entry.file.name}`} tabIndex={Math.abs(index - props.index) === 1 ? 0 : -1} onClick={() => props.onSelect(index)}>
        <span className={props.viewedFiles?.[entry.file.name] === "VIEWED" ? "viewed-file" : undefined}>{basename(entry.file.name)}</span>
      </button>}
        <CopyPath path={entry.file.name} tabIndex={Math.abs(index - props.index) <= 1 ? 0 : -1} />
        </div>
      </div>)}
    </div>
  </div>;
}

/** Copy the repository-relative path without changing the selected file. */
function CopyPath(props: { path: string; tabIndex: number }) {
  const [status, setStatus] = useState("");

  async function copy() {
    try { await navigator.clipboard.writeText(props.path); setStatus("Copied!"); }
    catch { setStatus("Could not copy path"); }
  }

  return <button type="button" className="copy-file-path" aria-label={`Copy path ${props.path}`} title={status || "Copy relative path"} tabIndex={props.tabIndex} onClick={() => void copy()} onMouseLeave={() => setStatus("")} onBlur={() => setStatus("")}>
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V4H4v12h4" /></svg>
    <span className="copy-path-status" role="status">{status}</span>
  </button>;
}

/** Keep directory information in tooltips rather than the horizontal labels. */
function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}
