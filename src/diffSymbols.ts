import type { FileDiffMetadata } from "@pierre/diffs";
import type { ReviewSymbol } from "../shared/symbols";
import { symbolWords } from "../shared/symbols";
import { wordAtPoint } from "./diffTextSelection";
import { selectedSourceText } from "./selectedSourceText";
import { lineLocation } from "./navigation";

export type SymbolLookup = Map<string, ReviewSymbol[]>;
type SourcePointer = Pick<MouseEvent, "clientX" | "clientY" | "composedPath">;
let nextHighlight = 0;
let modifierHeld = false;
let controllers = 0;

/** Separate snapshot sides even for identically spelled names. */
export function symbolLookup(symbols: ReviewSymbol[]): SymbolLookup {
  const lookup: SymbolLookup = new Map();
  for (const symbol of symbols) {
    const key = `${symbol.side}:${symbol.name}`;
    const entries = lookup.get(key) ?? [];
    entries.push(symbol);
    lookup.set(key, entries);
  }
  return lookup;
}

/**
 * Decorate mounted text with ranges, never wrappers that could upset Pierre's renderer or copying.
 *
 * Preparation runs in idle-sized row batches. Modifier changes only expose prepared ranges;
 * comments and strings intentionally use the same whole-name lookup as executable code.
 */
export function installDiffSymbols(root: ShadowRoot, file: () => FileDiffMetadata, initialLookup: SymbolLookup, navigate: (candidates: ReviewSymbol[], origin: ReviewSymbol) => void) {
  controllers++;
  const name = `biff-symbols-${nextHighlight++}`;
  const style = document.createElement("style");
  style.textContent = `::highlight(${name}) { text-decoration: underline; text-decoration-color: #9fc5ac; }`;
  root.append(style);
  const highlight = new Highlight();
  let held = modifierHeld;
  let disposed = false;
  let pending = false;
  let idle: number | undefined;
  const nativeIdle = typeof window.requestIdleCallback === "function";
  let lookup = initialLookup;
  let generation = 0;
  // New index results invalidate name matching, not source coordinates or already painted ranges.
  const prepared = new WeakMap<HTMLElement, number>();
  const rowRanges = new WeakMap<HTMLElement, Map<number, Range>>();
  const rangeKeys = new Map<Range, string>();
  let pointer: SourcePointer | undefined;
  let hovered: HTMLElement | undefined;
  let oldTitle: string | null = null;
  let oldCursor = "";

  /** Clear temporary cursor/title state without disturbing a pre-existing tooltip. */
  function clearHover() {
    if (!hovered) return;
    if (oldCursor) hovered.style.cursor = oldCursor; else hovered.style.removeProperty("cursor");
    if (oldTitle === null) hovered.removeAttribute("title"); else hovered.title = oldTitle;
    hovered = undefined;
  }

  /** Resolve a complete word at the pointer, independent of syntax-token span boundaries. */
  function target(event: SourcePointer) {
    try {
      const word = wordAtPoint(root, event, file());
      if (!word) return;
      const text = selectedSourceText(file(), word.start, word.end);
      const candidates = lookup.get(`${word.start.side}:${text}`);
      if (!candidates?.length) return;
      return { candidates, origin: { name: text, kind: "reference", path: file().name, side: word.start.side, line: word.start.line } satisfies ReviewSymbol };
    } catch { return; }
  }

  /** Preserve hit-testing coordinates after dispatch, when the browser clears composedPath(). */
  function hover(event: MouseEvent) {
    const path = event.composedPath();
    pointer = { clientX: event.clientX, clientY: event.clientY, composedPath() { return path; } };
    updateHover(pointer);
  }

  /** Leave the existing cursor and native tooltip alone while the pointer stays on the same name. */
  function updateHover(event: SourcePointer) {
    if (!held) return;
    const match = target(event);
    const node = event.composedPath()[0];
    if (!match || !(node instanceof HTMLElement)) { clearHover(); return; }
    if (hovered !== node) {
      clearHover();
      hovered = node;
      oldTitle = node.getAttribute("title");
      oldCursor = node.style.cursor;
      if (node.style.cursor !== "pointer") node.style.cursor = "pointer";
    }
    const title = match.candidates.length === 1 ? `Go to ${match.candidates[0].name} · ${match.candidates[0].path}:${match.candidates[0].line}` : `${match.candidates.length} matching declarations`;
    if (node.title !== title) node.title = title;
  }

  /** Do not revive feedback at a stale pointer location after leaving this reading pane. */
  function leave() { pointer = undefined; clearHover(); }

  /** Expose prepared ranges immediately, and never rescan on key repeat. */
  function modifier(event: KeyboardEvent) {
    const next = (event.ctrlKey || event.metaKey) && !event.altKey;
    modifierHeld = next;
    if (next === held) return;
    held = next;
    if (held) CSS.highlights.set(name, highlight); else CSS.highlights.delete(name);
    if (!held) clearHover();
    else if (pointer) updateHover(pointer);
  }

  /** Stop modified navigation before normal row-selection handlers observe it. */
  function click(event: MouseEvent) {
    if (event.button !== 0 || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
    const match = target(event);
    if (!match) return;
    event.preventDefault();
    event.stopPropagation();
    navigate(match.candidates, match.origin);
  }

  /** A lost keyup, hidden tab or native dialog must not leave link mode stuck on. */
  function reset() { modifierHeld = false; hide(); }

  /** Replacing a controller must not forget a modifier still held for another pane. */
  function hide() { held = false; CSS.highlights.delete(name); clearHover(); }

  /** Keep batches short and discard detached row ranges after virtualization replaces the window. */
  function prepare() {
    if (disposed || pending) return;
    pending = true;
    schedule();
  }

  /** Add new names without hiding ranges that remain valid while the modifier is held. */
  function update(next: SymbolLookup) {
    if (next !== lookup) {
      lookup = next;
      generation++;
      if (pointer) updateHover(pointer);
    }
    prepare();
  }

  /** Yield between small batches, including browsers without requestIdleCallback. */
  function schedule() {
    if (nativeIdle) {
      idle = window.requestIdleCallback(scan, { timeout: 500 });
    } else {
      idle = window.setTimeout(scan, 20);
    }
  }

  /**
   * Extend highlights in idle batches without clearing still-valid source ranges.
   *
   * I.e. when a later file introduces "example", rescan this generation's mounted
   * rows while retaining the existing "saveReview" ranges at their source columns.
   */
  function scan() {
    if (disposed) return;
    const started = performance.now();
    let count = 0;
    for (const [range, key] of rangeKeys) {
      if (root.contains(range.startContainer) && lookup.has(key)) continue;
      highlight.delete(range);
      rangeKeys.delete(range);
    }
    for (const row of root.querySelectorAll<HTMLElement>("[data-content] > [data-line]")) {
      if (prepared.get(row) === generation) continue;
      if (count++ >= 24 || count > 1 && performance.now() - started > 4) { schedule(); return; }
      prepared.set(row, generation);
      const location = lineLocation(file(), Number(row.dataset.lineIndex?.split(",")[0]));
      if (!location) continue;
      const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT, { acceptNode: (node) => node.parentElement?.closest("[data-biff-comment-preview]") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT });
      const nodes: Text[] = [];
      while (walker.nextNode()) nodes.push(walker.currentNode as Text);
      const text = nodes.map((node) => node.data).join("");
      // Minified/generated single-line files should not turn an idle scan into a long main-thread task.
      if (text.length > 20_000) continue;
      const retained = rowRanges.get(row) ?? new Map<number, Range>();
      rowRanges.set(row, retained);
      for (const word of symbolWords(text)) {
        const key = `${location.side}:${word.name}`;
        if (!lookup.has(key)) continue;
        const existing = retained.get(word.start);
        if (existing && rangeKeys.has(existing)) continue;
        const range = document.createRange();
        let offset = 0;
        for (const node of nodes) {
          if (word.start >= offset && word.start < offset + node.length) range.setStart(node, word.start - offset);
          if (word.end > offset && word.end <= offset + node.length) { range.setEnd(node, word.end - offset); break; }
          offset += node.length;
        }
        highlight.add(range);
        rangeKeys.set(range, key);
        retained.set(word.start, range);
      }
    }
    pending = false;
  }

  root.addEventListener("pointermove", hover as EventListener);
  root.addEventListener("pointerleave", leave);
  root.addEventListener("click", click as EventListener, true);
  window.addEventListener("keydown", modifier);
  window.addEventListener("keyup", modifier);
  window.addEventListener("blur", reset);
  document.addEventListener("visibilitychange", reset);
  if (held) CSS.highlights.set(name, highlight);
  prepare();
  return { prepare, update, cleanup() {
    disposed = true;
    if (idle !== undefined) {
      if (nativeIdle) window.cancelIdleCallback(idle);
      else window.clearTimeout(idle);
    }
    hide(); style.remove();
    controllers--;
    queueMicrotask(() => { if (!controllers) modifierHeld = false; });
    root.removeEventListener("pointermove", hover as EventListener);
    root.removeEventListener("pointerleave", leave);
    root.removeEventListener("click", click as EventListener, true);
    window.removeEventListener("keydown", modifier);
    window.removeEventListener("keyup", modifier);
    window.removeEventListener("blur", reset);
    document.removeEventListener("visibilitychange", reset);
  } };
}
