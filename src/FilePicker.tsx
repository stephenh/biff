import { useEffect, useId, useRef, useState } from "react";
import type { FileDiffMetadata } from "@pierre/diffs";
import type { FileViewedState } from "../shared/types";
import { FileChangeTag } from "./FileChangeTag";
import { changeStarts } from "./navigation";
import { isAutoReviewedFile } from "../shared/progress";
import { ModalHeader } from "./ModalHeader";
import { pickerShortcuts } from "./shortcutDefinitions";
import { isTyping } from "./shortcuts";

interface FileHunkProgress { reviewed: number; total: number }

/** Search file paths without loading source or changing the review until a result is accepted. */
export function FilePicker(props: { files: FileDiffMetadata[]; index: number; viewedFiles?: Record<string, FileViewedState>; hunkProgress?: FileHunkProgress[]; progressReady?: boolean; onSelect(index: number): void; onClose(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const id = useId();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(props.index);
  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const matches = props.files.map((file, index) => {
    const progress = props.hunkProgress?.[index];
    const unreviewed = !isAutoReviewedFile(file.name) && (progress
      ? progress.total > progress.reviewed
      : props.viewedFiles?.[file.name] !== "VIEWED" && changeStarts(file).length > 0);
    return { file, index, unreviewed };
  }).filter((entry) => words.every((word) => entry.file.name.toLowerCase().includes(word)))
    .sort((a, b) => Number(b.unreviewed) - Number(a.unreviewed));
  // Keep selection attached to the file when saved progress changes its position.
  const active = Math.max(0, matches.findIndex((entry) => entry.index === selected));

  useEffect(() => {
    const element = dialog.current!;
    const previous = document.activeElement;
    element.showModal();
    input.current?.focus();
    return () => { element.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);

  useEffect(() => {
    dialog.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [active, query]);

  /** Mouse and keyboard acceptance share the same file navigation. */
  function accept(index: number) {
    props.onSelect(index);
    props.onClose();
  }

  return <dialog ref={dialog} className="file-picker" aria-label="Go to file" onCancel={(event) => { event.preventDefault(); props.onClose(); }} onClick={(event) => {
    if (event.target !== event.currentTarget) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) props.onClose();
  }} onKeyDown={(event) => {
    if (event.defaultPrevented || event.nativeEvent.isComposing || event.altKey) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "p") { event.preventDefault(); input.current?.select(); return; }
    if (event.ctrlKey || event.metaKey) return;
    const down = event.key === "ArrowDown" || (!isTyping(event.nativeEvent) && event.key === "j");
    const up = event.key === "ArrowUp" || (!isTyping(event.nativeEvent) && event.key === "k");
    if (down || up) {
      event.preventDefault();
      if (matches.length) setSelected(matches[Math.max(0, Math.min(matches.length - 1, active + (down ? 1 : -1)))].index);
    } else if (event.key === "Enter" && event.target === input.current) {
      event.preventDefault();
      if (matches[active]) accept(matches[active].index);
    }
  }}>
    <ModalHeader title="Go to file" closeLabel="Close file picker" onClose={props.onClose} shortcuts={[...pickerShortcuts, { keys: "j", description: "Next result (outside search field)" }, { keys: "k", description: "Previous result (outside search field)" }, { keys: "Mod+p", description: "Select search query" }]} />
    <div className="file-picker-input"><svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.5" stroke="currentColor" strokeWidth="1.5" /><path d="m13 13 4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg><input ref={input} role="combobox" aria-label="Search files" aria-autocomplete="list" aria-expanded="true" aria-controls={`${id}-results`} aria-activedescendant={matches.length ? `${id}-${matches[active].index}` : undefined} placeholder="Go to file…" value={query} onChange={(event) => { setQuery(event.target.value); setSelected(-1); }} /></div>
    <div className="file-picker-results" id={`${id}-results`} role="listbox" aria-label="Files in this review">
      {matches.map((entry, index) => <button key={entry.file.name} id={`${id}-${entry.index}`} role="option" aria-selected={index === active} tabIndex={-1} onClick={() => accept(entry.index)}>
        <HunkProgress file={entry.file} progress={props.hunkProgress?.[entry.index]} ready={props.progressReady !== false} viewed={props.viewedFiles?.[entry.file.name] === "VIEWED"} />
        <FileChangeTag type={entry.file.type} />
        <span className="file-picker-name">{entry.file.name.split("/").at(-1)}<span className="file-picker-path">{entry.file.name}</span></span>
        {props.viewedFiles?.[entry.file.name] === "VIEWED" && <span className="file-picker-reviewed" aria-label="Reviewed">✓</span>}
      </button>)}
    </div>
    {!matches.length && <p className="file-picker-empty">No matching files.</p>}
    <div className="file-picker-footer"><span role="status">{matches.length} {matches.length === 1 ? "file" : "files"}</span></div>
  </dialog>;
}

/** Keep saved progress separate from raw patches, which have totals but no reviewed marks. */
function HunkProgress(props: { file: FileDiffMetadata; progress?: FileHunkProgress; ready: boolean; viewed: boolean }) {
  const automatic = isAutoReviewedFile(props.file.name);
  const total = props.progress?.total ?? changeStarts(props.file).length;
  const reviewed = props.progress?.reviewed ?? (props.viewed ? total : 0);
  const label = automatic ? "Auto-reviewed; excluded from hunk totals" : !props.ready ? "Loading hunk progress" : `${reviewed} of ${total} hunks reviewed`;
  const fraction = automatic ? 1 : !props.ready ? 0 : total ? reviewed / total : props.viewed ? 1 : 0;
  return <svg className="file-progress" width="16" height="16" viewBox="0 0 20 20" role="img" aria-label={label}>
    <title>{label}</title>
    <circle className="progress-track" cx="10" cy="10" r="7" />
    <circle className="progress-fill" cx="10" cy="10" r="7" pathLength="100" strokeDasharray="100" strokeDashoffset={100 - fraction * 100} transform="rotate(-90 10 10)" />
  </svg>;
}
