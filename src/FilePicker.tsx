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
  const matches = props.files.map((file, index) => ({ file, index })).filter((entry) => words.every((word) => entry.file.name.toLowerCase().includes(word)));
  const active = Math.min(selected, Math.max(0, matches.length - 1));

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
      if (matches.length) setSelected(Math.max(0, Math.min(matches.length - 1, active + (down ? 1 : -1))));
    } else if (event.key === "Enter" && event.target === input.current) {
      event.preventDefault();
      if (matches[active]) accept(matches[active].index);
    }
  }}>
    <ModalHeader title="Go to file" closeLabel="Close file picker" onClose={props.onClose} shortcuts={[...pickerShortcuts, { keys: "j", description: "Next result (outside search field)" }, { keys: "k", description: "Previous result (outside search field)" }, { keys: "Mod+p", description: "Select search query" }]} />
    <div className="file-picker-input"><svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.5" stroke="currentColor" strokeWidth="1.5" /><path d="m13 13 4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg><input ref={input} role="combobox" aria-label="Search files" aria-autocomplete="list" aria-expanded="true" aria-controls={`${id}-results`} aria-activedescendant={matches.length ? `${id}-${matches[active].index}` : undefined} placeholder="Go to file…" value={query} onChange={(event) => { setQuery(event.target.value); setSelected(0); }} /></div>
    <div className="file-picker-results" id={`${id}-results`} role="listbox" aria-label="Files in this review">
      {matches.map((entry, index) => <button key={entry.file.name} id={`${id}-${entry.index}`} role="option" aria-selected={index === active} tabIndex={-1} onClick={() => accept(entry.index)}>
        <FileChangeTag type={entry.file.type} />
        <span className="file-picker-name">{entry.file.name.split("/").at(-1)}<span className="file-picker-path">{entry.file.name}</span></span>
        <HunkCount file={entry.file} progress={props.hunkProgress?.[entry.index]} ready={props.progressReady !== false} />
        {props.viewedFiles?.[entry.file.name] === "VIEWED" && <span className="file-picker-reviewed" aria-label="Reviewed">✓</span>}
        {entry.index === props.index && <span className="file-picker-current">Current</span>}
      </button>)}
    </div>
    {!matches.length && <p className="file-picker-empty">No matching files.</p>}
    <div className="file-picker-footer"><span role="status">{matches.length} {matches.length === 1 ? "file" : "files"}</span></div>
  </dialog>;
}

/** Keep saved progress separate from raw patches, which have totals but no reviewed marks. */
function HunkCount(props: { file: FileDiffMetadata; progress?: FileHunkProgress; ready: boolean }) {
  if (isAutoReviewedFile(props.file.name)) return <span className="file-picker-hunks" title="Excluded from hunk totals">Auto-reviewed</span>;
  const total = props.progress?.total ?? changeStarts(props.file).length;
  const label = props.progress ? props.ready ? `${props.progress.reviewed} of ${total} hunks reviewed` : "Loading hunk progress" : `${total} hunks`;
  const count = props.progress ? props.ready ? `${props.progress.reviewed}/${total}` : "…" : String(total);
  return <span className="file-picker-hunks" aria-label={label} title={label}>{count} {total === 1 ? "hunk" : "hunks"}</span>;
}
