import { createElement, type CSSProperties } from "react";
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
      {props.entries.map((entry, index) => index === props.index ? <div className="file-tile current-file" key={entry.file.name}>
        <select className="file-select" aria-label="Current file" title={entry.file.name} value={props.index} onChange={(event) => props.onSelect(Number(event.target.value))}>
          {/* React's JSX types do not yet list this native customizable-select element. */}
          <button type="button">{createElement("selectedcontent")}</button>
          {props.entries.map((option, optionIndex) => <option key={option.file.name} value={optionIndex} title={option.file.name} aria-label={`${option.file.name}${props.viewedFiles?.[option.file.name] === "VIEWED" ? " ✓" : ""}`}><span className={`file-option-label${props.viewedFiles?.[option.file.name] === "VIEWED" ? " viewed-file" : ""}`}>{basename(option.file.name)}{option.file.name.includes("/") && <small className="file-option-path">{option.file.name}</small>}</span>{props.viewedFiles?.[option.file.name] === "VIEWED" && <span className="file-viewed-check" aria-hidden="true">✓</span>}</option>)}
        </select>
      </div> : <button className="file-tile" key={entry.file.name} title={entry.file.name} aria-label={`Open ${entry.file.name}`} tabIndex={Math.abs(index - props.index) === 1 ? 0 : -1} onClick={() => props.onSelect(index)}>
        <span className={props.viewedFiles?.[entry.file.name] === "VIEWED" ? "viewed-file" : undefined}>{basename(entry.file.name)}</span>
      </button>)}
    </div>
  </div>;
}

/** Keep directory information in tooltips rather than the horizontal labels. */
function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}
