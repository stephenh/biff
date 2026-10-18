import { useEffect, useId, useRef, useState } from "react";
import type { FileViewedState } from "../shared/types";

/** Search file paths without loading source or changing the review until a result is accepted. */
export function FilePicker(props: { files: { name: string }[]; index: number; viewedFiles?: Record<string, FileViewedState>; onSelect(index: number): void; onClose(): void }) {
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
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "p") { event.preventDefault(); input.current?.select(); return; }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (matches.length) setSelected((active + (event.key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length);
    } else if (event.key === "Enter" && event.target === input.current) {
      event.preventDefault();
      if (matches[active]) accept(matches[active].index);
    }
  }}>
    <div className="file-picker-input"><svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.5" stroke="currentColor" strokeWidth="1.5" /><path d="m13 13 4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg><input ref={input} role="combobox" aria-label="Search files" aria-autocomplete="list" aria-expanded="true" aria-controls={`${id}-results`} aria-activedescendant={matches.length ? `${id}-${matches[active].index}` : undefined} placeholder="Go to file…" value={query} onChange={(event) => { setQuery(event.target.value); setSelected(0); }} /><button onClick={props.onClose} aria-label="Close file picker"><kbd>Esc</kbd></button></div>
    <div className="file-picker-results" id={`${id}-results`} role="listbox" aria-label="Files in this review">
      {matches.map((entry, index) => <button key={entry.file.name} id={`${id}-${entry.index}`} role="option" aria-selected={index === active} tabIndex={-1} onClick={() => accept(entry.index)}>
        <span className="file-picker-name">{entry.file.name.split("/").at(-1)}<span className="file-picker-path">{entry.file.name}</span></span>
        {props.viewedFiles?.[entry.file.name] === "VIEWED" && <span className="file-picker-reviewed" aria-label="Reviewed">✓</span>}
        {entry.index === props.index && <span className="file-picker-current">Current</span>}
      </button>)}
    </div>
    {!matches.length && <p className="file-picker-empty">No matching files.</p>}
    <div className="file-picker-footer"><span role="status">{matches.length} {matches.length === 1 ? "file" : "files"}</span><span><kbd>↑</kbd> <kbd>↓</kbd> navigate <kbd>↵</kbd> open</span></div>
  </dialog>;
}
