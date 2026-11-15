import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { ReviewSymbol, SymbolIndex } from "../shared/symbols";
import { ModalHeader } from "./ModalHeader";
import { pickerShortcuts } from "./shortcutDefinitions";
import { ActivityScope } from "./ActivityStatus";

/**
 * Share one declaration picker between fuzzy search and ambiguous name navigation.
 *
 * Progressive results retain the selected declaration, and only accepting a result
 * moves the review. Cap mounted options rather than rendering an entire large index.
 */
export function SymbolPicker(props: {
  index: SymbolIndex; candidates?: ReviewSymbol[]; activityScope: string; onSelect(symbol: ReviewSymbol): void; onClose(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const id = useId();
  const [query, setQuery] = useState("");
  const [side, setSide] = useState<ReviewSymbol["side"]>("RIGHT");
  const [selected, setSelected] = useState("");
  const matches = useMemo(() => findSymbols(props.candidates ?? props.index.symbols.filter((symbol) => symbol.side === side), query), [props.index.symbols, props.candidates, side, query]);
  const shown = matches.slice(0, 200);
  const active = Math.max(0, shown.findIndex((symbol) => symbolKey(symbol) === selected));
  const title = props.candidates ? `Go to ${props.candidates[0]?.name ?? "definition"}` : "Find symbol";

  useEffect(() => {
    const element = dialog.current!;
    const previous = document.activeElement;
    element.showModal();
    input.current?.focus();
    return () => { element.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  useEffect(() => { dialog.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" }); }, [active, query, side]);

  /** Accepting a declaration is the only operation that changes the reader's location. */
  function accept(symbol: ReviewSymbol) { props.onSelect(symbol); props.onClose(); }

  return <dialog ref={dialog} className="file-picker symbol-picker" aria-label={title} onCancel={(event) => { event.preventDefault(); props.onClose(); }} onClick={(event) => {
    if (event.target !== event.currentTarget) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) props.onClose();
  }} onKeyDown={(event) => {
    if (event.defaultPrevented || event.nativeEvent.isComposing || event.altKey) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "o") { event.preventDefault(); input.current?.select(); return; }
    if (event.ctrlKey || event.metaKey) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (shown.length) setSelected(symbolKey(shown[Math.max(0, Math.min(shown.length - 1, active + (event.key === "ArrowDown" ? 1 : -1)))]));
    } else if (event.key === "Enter" && event.target === input.current && shown[active]) {
      event.preventDefault(); accept(shown[active]);
    }
  }}>
    <ModalHeader title={title} closeLabel="Close symbol picker" onClose={props.onClose} shortcuts={[...pickerShortcuts, { keys: "Mod+o", description: "Select symbol query" }]} />
    <div className="file-picker-input">
      <input ref={input} role="combobox" aria-label="Search symbols" aria-autocomplete="list" aria-expanded="true" aria-controls={`${id}-results`} aria-activedescendant={shown.length ? `${id}-${active}` : undefined} placeholder="Search declarations in this review…" value={query} onChange={(event) => { setQuery(event.target.value); setSelected(""); }} />
      {!props.candidates && <select aria-label="Symbol revision" value={side} onChange={(event) => { setSide(event.target.value as ReviewSymbol["side"]); setSelected(""); }}><option value="RIGHT">Head</option><option value="LEFT">Base</option></select>}
    </div>
    <ActivityScope scope={props.activityScope} />
    <div className="file-picker-results" id={`${id}-results`} role="listbox" aria-label="Symbols in this review">
      {shown.map((symbol, index) => <button key={symbolKey(symbol)} id={`${id}-${index}`} role="option" aria-selected={index === active} tabIndex={-1} onClick={() => accept(symbol)}>
        <span className="file-picker-name"><code>{symbol.name}</code><span className="file-picker-path">{symbol.scope ? `${symbol.scope} · ` : ""}{symbol.path}:{symbol.line}</span></span>
        <span className="symbol-kind">{symbol.kind}</span>
      </button>)}
    </div>
    {!shown.length && <p className="file-picker-empty">{props.index.state === "indexing" ? "Indexing declarations…" : props.index.state === "failed" ? "Symbol index incomplete. Open Activity to retry." : "No matching declarations in this review."}</p>}
    <div className="file-picker-footer"><span role="status">{props.index.state === "indexing" ? `Indexing · ${props.index.completed}/${props.index.total} files` : props.index.state === "failed" ? "Index incomplete" : `${matches.length} ${matches.length === 1 ? "declaration" : "declarations"}`}{matches.length > shown.length ? " · showing first 200; refine your search" : ""}</span></div>
  </dialog>;
}

/** Fuzzy-match names, with exact and prefix matches ahead of looser subsequences. */
export function findSymbols(symbols: ReviewSymbol[], query: string): ReviewSymbol[] {
  const needle = query.trim().toLowerCase();
  return symbols.map((symbol) => ({ symbol, score: matchScore(symbol.name.toLowerCase(), needle) }))
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => a.score - b.score || a.symbol.name.localeCompare(b.symbol.name) || a.symbol.path.localeCompare(b.symbol.path) || a.symbol.line - b.symbol.line)
    .map((entry) => entry.symbol);
}

/** Preserve selection when progressively indexed files add results before the selected declaration. */
function symbolKey(symbol: ReviewSymbol): string { return JSON.stringify([symbol.path, symbol.side, symbol.line, symbol.name, symbol.kind, symbol.scope]); }

/** Rank contiguous matches first without allocating a regular expression per declaration. */
function matchScore(name: string, needle: string): number {
  if (!needle || name === needle) return 0;
  const contiguous = name.indexOf(needle);
  if (contiguous >= 0) return 1 + contiguous;
  let cursor = 0;
  for (const character of needle) {
    const next = name.indexOf(character, cursor);
    if (next < 0) return -1;
    cursor = next + 1;
  }
  return 100 + cursor;
}
