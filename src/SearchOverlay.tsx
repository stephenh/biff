import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { FileDiffLoadedFiles, FileDiffMetadata } from "@pierre/diffs";
import { searchLines, type SearchLine } from "./search";
import { ModalHeader } from "./ModalHeader";
import { pickerShortcuts } from "./shortcutDefinitions";

interface SearchOverlayProps {
  files: FileDiffMetadata[];
  query: string;
  onQueryChange: (query: string) => void;
  selected?: string;
  onSelectedChange: (key: string | undefined) => void;
  loadContents?: (file: FileDiffMetadata) => Promise<FileDiffLoadedFiles>;
  onSelect: (fileIndex: number, line?: SearchLine) => void;
  onClose: () => void;
}

/** Keep cross-file search over the review, without moving the reading surface. */
export function SearchOverlay(props: SearchOverlayProps) {
  const [sources, setSources] = useState(new Map<FileDiffMetadata, FileDiffLoadedFiles>());
  const [loading, setLoading] = useState(Boolean(props.loadContents));
  const [failures, setFailures] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const panel = useRef<HTMLElement>(null);
  const restoreSelection = useRef(props.selected);
  const indexed = useMemo(() => props.files.map((file) => searchLines(file, sources.get(file))), [props.files, sources]);
  const needle = props.query.trim().toLowerCase();
  const groups = props.files.map((file, index) => ({ file, index, lines: needle ? indexed[index].filter((line) => line.text.toLowerCase().includes(needle)) : [], nameMatch: !needle || `${file.name} ${file.prevName ?? ""}`.toLowerCase().includes(needle) })).filter((group) => group.nameMatch || group.lines.length);
  const count = groups.reduce((total, group) => total + group.lines.length, 0);

  useEffect(() => {
    const previous = document.activeElement;
    input.current?.select();
    /** Repeated find shortcuts select the current query for replacement. */
    function keydown(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") { event.preventDefault(); input.current?.select(); }
      if (event.key === "Escape") { event.preventDefault(); props.onClose(); }
    }
    window.addEventListener("keydown", keydown);
    return () => { window.removeEventListener("keydown", keydown); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);

  useEffect(() => {
    if (!restoreSelection.current) return;
    const result = Array.from(panel.current?.querySelectorAll<HTMLButtonElement>("[data-search-result]") ?? []).find((button) => button.dataset.searchResult === restoreSelection.current);
    if (result) {
      restoreSelection.current = undefined;
      result.focus();
      result.scrollIntoView({ block: "nearest" });
    }
  }, [sources]);

  useEffect(() => {
    if (!props.loadContents) return;
    let stopped = false;
    let cursor = 0;
    /** Bound source requests so large reviews do not flood the backend. */
    async function worker() {
      while (!stopped && cursor < props.files.length) {
        const file = props.files[cursor++];
        try {
          const contents = await props.loadContents!(file);
          if (!stopped) setSources((current) => new Map(current).set(file, contents));
        } catch { if (!stopped) setFailures((count) => count + 1); }
      }
    }
    void Promise.all([worker(), worker(), worker()]).then(() => { if (!stopped) setLoading(false); });
    return () => { stopped = true; };
  }, [props.files, props.loadContents]);

  /** Focusing a result previews its source location without dismissing search. */
  function preview(fileIndex: number, line?: SearchLine) {
    props.onSelectedChange(resultKey(props.files[fileIndex].name, line));
    props.onSelect(fileIndex, line);
  }

  /** Mouse activation also works when the browser does not focus clicked buttons. */
  function accept(fileIndex: number, line?: SearchLine) {
    preview(fileIndex, line);
    props.onClose();
  }

  return <section ref={panel} className="search-overlay" role="dialog" aria-label="Find in review" onKeyDown={(event) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const typing = event.target === input.current;
    const down = event.key === "ArrowDown" || (!typing && event.key === "j");
    const up = event.key === "ArrowUp" || (!typing && event.key === "k");
    if (!down && !up && !(event.key === "Enter" && typing)) return;
    const results = Array.from(panel.current?.querySelectorAll<HTMLButtonElement>("[data-search-result]") ?? []).filter((button) => button.getClientRects().length > 0);
    // File headings remain clickable, but symbol navigation stops only at matching lines.
    const options = results.some((button) => button.classList.contains("search-result")) ? results.filter((button) => button.classList.contains("search-result")) : results;
    if (!options.length) return;
    event.preventDefault();
    restoreSelection.current = undefined;
    if (event.key === "Enter") { (options.find((button) => button.dataset.searchResult === props.selected) ?? options[0]).click(); return; }
    const focused = options.indexOf(document.activeElement as HTMLButtonElement);
    const index = focused < 0 && !typing ? options.findIndex((button) => button.dataset.searchResult === props.selected) : focused;
    const next = index < 0 ? (down ? 0 : options.length - 1) : Math.max(0, Math.min(options.length - 1, index + (down ? 1 : -1)));
    options[next].focus();
    options[next].scrollIntoView({ block: "nearest" });
  }}>
    <ModalHeader title="Find in review" closeLabel="Close search" onClose={props.onClose} shortcuts={[...pickerShortcuts, { keys: "j", description: "Next result (outside search field)" }, { keys: "k", description: "Previous result (outside search field)" }, { keys: "Mod+f", description: "Select search query" }]} />
    <div className="search-input"><span aria-hidden="true">⌕</span><input ref={input} aria-label="Search files and symbols" placeholder="Search files and symbols…" value={props.query} onChange={(event) => { restoreSelection.current = undefined; props.onSelectedChange(undefined); props.onQueryChange(event.target.value); }} /></div>
    <p className="search-summary" role="status">{needle ? `${count} matching lines in ${groups.length} files` : `${groups.length} files in this review`}{loading ? " · Loading full source…" : ""}</p>
    {failures > 0 && <p className="search-summary">Full source unavailable for {failures} files; searching their diff lines.</p>}
    {!props.loadContents && <p className="search-summary">Searching lines included in this patch.</p>}
    <div className="search-results">
      {!groups.length && <p className="search-summary">No matches found.</p>}
      {groups.map((group) => <details key={group.file.name} open>
        <summary><button data-search-result={resultKey(group.file.name)} onFocus={() => preview(group.index)} onClick={() => accept(group.index)}><strong>{highlight(group.file.name.split("/").at(-1)!, needle)}</strong><span className="search-path">{group.file.name.includes("/") ? group.file.name.slice(0, group.file.name.lastIndexOf("/")) : ""}</span></button><span className="search-count">{group.lines.length}</span></summary>
        {group.lines.slice(0, 200).map((line) => <button className="search-result" data-search-result={resultKey(group.file.name, line)} aria-current={props.selected === resultKey(group.file.name, line) ? "true" : undefined} key={`${line.side}:${line.line}`} onFocus={() => preview(group.index, line)} onClick={() => accept(group.index, line)} title={line.text}>
          <span className="search-line-number">{line.side === "LEFT" ? "−" : ""}{line.line}</span><code>{highlight(snippet(line.text, needle), needle)}</code>{line.hidden && <span className="search-hidden">hidden</span>}
        </button>)}
        {group.lines.length > 200 && <p className="search-summary">Showing first 200 matching lines. Refine your search to see more.</p>}
      </details>)}
    </div>
  </section>;
}

/** Source coordinates keep the selection stable as full-source matches arrive. */
function resultKey(path: string, line?: SearchLine): string {
  return JSON.stringify([path, line?.side, line?.line]);
}

/** Keep long-line matches inside the visible snippet. */
function snippet(text: string, needle: string): string {
  const start = Math.max(0, text.toLowerCase().indexOf(needle) - 40);
  return `${start ? "…" : ""}${text.slice(start).trimEnd()}`;
}

/** Highlight literal matches without interpreting symbols as regular expressions. */
function highlight(text: string, needle: string): ReactNode {
  if (!needle) return text;
  const parts: ReactNode[] = [];
  let cursor = 0;
  let index = text.toLowerCase().indexOf(needle);
  while (index >= 0) {
    parts.push(text.slice(cursor, index), <mark key={index}>{text.slice(index, index + needle.length)}</mark>);
    cursor = index + needle.length;
    index = text.toLowerCase().indexOf(needle, cursor);
  }
  parts.push(text.slice(cursor));
  return parts;
}
