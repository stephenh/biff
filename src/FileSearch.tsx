import { useEffect, useMemo, useRef, useState } from "react";
import type { FileDiffLoadedFiles, FileDiffMetadata } from "@pierre/diffs";
import type { ReviewLine } from "../shared/types";
import { fileSearchMatches, type FileSearchMatch } from "./fileSearchMatches";
import { ShortcutStrip } from "./shortcuts";
import { ActivityStatus } from "./ActivityStatus";

interface FileSearchProps {
  file: FileDiffMetadata;
  query: string;
  request: number;
  location?: ReviewLine;
  loadContents?: (file: FileDiffMetadata) => Promise<FileDiffLoadedFiles>;
  onQueryChange: (query: string) => void;
  onSelect: (match: FileSearchMatch) => void;
  onClose: () => void;
}

/** Search the reading file without replacing the diff with a cross-file result list. */
export function FileSearch(props: FileSearchProps) {
  const input = useRef<HTMLInputElement>(null);
  const [contents, setContents] = useState<FileDiffLoadedFiles>();
  const [loading, setLoading] = useState(Boolean(props.loadContents));
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [selected, setSelected] = useState<FileSearchMatch>();
  const matches = useMemo(() => fileSearchMatches(props.file, props.query, contents), [props.file, props.query, contents]);
  const selectedIndex = matches.findIndex((match) => match.line === selected?.line && match.side === selected.side && match.start === selected.start);

  useEffect(() => { input.current?.select(); }, [props.request]);

  useEffect(() => {
    if (!props.loadContents) return;
    let active = true;
    setLoading(true);
    setFailed(false);
    void props.loadContents(props.file).then((source) => {
      if (active) { setContents(source); setLoading(false); }
    }, () => {
      if (active) { setFailed(true); setLoading(false); }
    });
    return () => { active = false; };
  }, [props.file, props.loadContents, attempt]);

  /** Wrap within this file and start at the reader's current source line. */
  function move(direction: 1 | -1) {
    if (!matches.length) return;
    let next = selectedIndex;
    if (next < 0) {
      const line = props.location?.line ?? 1;
      next = direction === 1 ? matches.findIndex((match) => match.line >= line) : matches.reduce((found, match, index) => match.line <= line ? index : found, -1);
      if (next < 0) next = direction === 1 ? 0 : matches.length - 1;
    } else next = (next + direction + matches.length) % matches.length;
    const match = matches[next];
    setSelected(match);
    props.onSelect(match);
  }

  return <section className="file-find" aria-label="Find in current file" onKeyDown={(event) => {
    if (event.nativeEvent.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === "Escape") { event.preventDefault(); props.onClose(); }
    if (event.key === "Enter") { event.preventDefault(); move(event.shiftKey ? -1 : 1); }
  }}>
    <label className="file-find-input"><span aria-hidden="true">/</span><input ref={input} aria-label="Search current file" placeholder="Find in this file (smart case)…" title="Ignores case unless the query contains an uppercase letter" value={props.query} onChange={(event) => { setSelected(undefined); props.onQueryChange(event.target.value); }} /></label>
    <ActivityStatus label={`Search source · ${props.file.name}`} loading={loading} error={failed ? "Full source unavailable; searching diff lines." : undefined} retry={() => setAttempt((value) => value + 1)} />
    <span className="file-find-status" role="status">{props.query ? `${selectedIndex < 0 ? "" : `${selectedIndex + 1} of `}${matches.length} matches` : "Type to highlight"}</span>
    <button aria-label="Previous match" title="Previous match (Shift+Enter)" disabled={!matches.length} onClick={() => move(-1)}>↑</button>
    <button aria-label="Next match" title="Next match (Enter)" disabled={!matches.length} onClick={() => move(1)}>↓</button>
    <button aria-label="Close file search" title="Clear search (Esc)" onClick={props.onClose}>×</button>
    <ShortcutStrip shortcuts={[{ keys: "Enter", description: "Next match" }, { keys: "⇧Enter", description: "Previous match" }, { keys: "Escape", description: "Clear search" }]} />
    {!props.loadContents && props.file.isPartial && <span className="file-find-note">Searching lines included in this patch.</span>}
  </section>;
}
