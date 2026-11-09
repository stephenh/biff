import type { FileDiffMetadata } from "@pierre/diffs";
import { selectedSourceText, textPointIndex, type TextPoint } from "./selectedSourceText";
import { lineLocation } from "./navigation";

interface Word { start: TextPoint; end: TextPoint }
interface TextPosition { node: Text; offset: number }
const controls = "button, a, input, textarea, select, [contenteditable]";

/** Read inside the shadow root, rather than the host-retargeted document range. */
export function diffSelectionRange(root: ShadowRoot): StaticRange | Range | undefined {
  const selection = document.getSelection();
  if (!selection?.rangeCount) return;
  if (selection.getComposedRanges) return selection.getComposedRanges({ shadowRoots: [root] })[0];
  const local = (root as ShadowRoot & { getSelection?: () => Selection | null }).getSelection?.();
  return local?.rangeCount ? local.getRangeAt(0) : selection.getRangeAt(0);
}

/** Hover-driven folds must not remove either endpoint of selected code. */
export function hasDiffTextSelection(root: ShadowRoot): boolean {
  const range = diffSelectionRange(root);
  return Boolean(range && !range.collapsed && (root.contains(range.startContainer) || root.contains(range.endContainer)));
}

/**
 * Keep native drag anchors alive and add double-click → Shift-click word copying.
 *
 * Native selection still owns dragging, word selection, and the clipboard. Only
 * the explicit word-range shortcut writes the clipboard automatically. Its anchor
 * uses source coordinates, so hydration cannot silently select a different line.
 */
export function installDiffTextSelection(root: ShadowRoot, file: () => FileDiffMetadata, copy: (text: string) => void, fail: (message: string) => void): () => void {
  const host = root.host as HTMLElement;
  const viewport = host.closest<HTMLElement>(".viewport, .historical-reading")!;
  let anchor: Word | undefined;
  let copiedRange: { start: TextPoint; end: TextPoint } | undefined;
  let expected: StaticRange | Range | undefined;
  let extending = false;

  /** Mark the caret before mousedown; the renderer retains it during a drag. */
  function onPointerDown(event: PointerEvent) {
    if (event.button !== 0 || !sourceRow(event.composedPath()[0], root)) return;
    host.setAttribute("data-biff-selecting", "");
    if (!event.shiftKey) { anchor = undefined; copiedRange = undefined; expected = undefined; }
  }

  /** Cancel the browser's partial-word Shift-click before its default action. */
  function onMouseDown(event: MouseEvent) {
    onSelectionChange();
    if (event.button !== 0 || !event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || !anchor) return;
    const word = wordAtPoint(root, event, file(), anchor.start.side);
    if (!word) return;
    event.preventDefault();
    extending = true;
    try {
      const before = textPointIndex(file(), word.start) < textPointIndex(file(), anchor.start)
        || textPointIndex(file(), word.start) === textPointIndex(file(), anchor.start) && word.start.column < anchor.start.column;
      const next = { start: before ? word.start : anchor.start, end: before ? anchor.end : word.end };
      copiedRange = undefined;
      showRange(root, file(), next.start, next.end);
      copiedRange = next;
      expected = diffSelectionRange(root);
    } catch (cause) { fail((cause as Error).message); }
  }

  /** Clipboard writes stay inside the intentional click's user activation. */
  function onClick(event: MouseEvent) {
    if (!extending) return;
    extending = false;
    event.preventDefault();
    event.stopPropagation();
    if (copiedRange) copyRange();
  }

  /** Use complete code identifiers, including underscores, dollars, and Unicode. */
  function onDoubleClick(event: MouseEvent) {
    if (event.button !== 0 || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
    const word = wordAtPoint(root, event, file());
    if (!word) return;
    anchor = word;
    copiedRange = word;
    showRange(root, file(), word.start, word.end);
    expected = diffSelectionRange(root);
  }

  /** A completed selection remains pinned until the reader clears it. */
  function onPointerUp() { host.removeAttribute("data-biff-selecting"); }

  /** A different click starts a new selection, never a stale word range. */
  function onOutsidePointerDown(event: PointerEvent) {
    // Scrollbar gestures belong to this pane too; they must keep the word anchor.
    if (event.composedPath().includes(viewport)) return;
    anchor = undefined;
    copiedRange = undefined;
    expected = undefined;
  }

  /** Escape clears code selection before closing an enclosing reference pane. */
  function onKeyDown(event: KeyboardEvent) {
    if (event.key !== "Escape" || !hasDiffTextSelection(root) || event.composedPath().some((node) => node instanceof Element && node.matches(controls))) return;
    event.preventDefault();
    event.stopPropagation();
    document.getSelection()?.removeAllRanges();
    anchor = undefined;
    copiedRange = undefined;
    expected = undefined;
  }

  /** Native keyboard extension or Select All must not copy an obsolete word range. */
  function onSelectionChange() {
    if (!expected) return;
    const current = diffSelectionRange(root);
    if (current?.startContainer === expected.startContainer && current.startOffset === expected.startOffset
      && current.endContainer === expected.endContainer && current.endOffset === expected.endOffset) return;
    anchor = undefined;
    copiedRange = undefined;
    expected = undefined;
  }

  /** Copy source, not folded summaries or inline comment previews. */
  function onCopy(event: ClipboardEvent) {
    onSelectionChange();
    if (!copiedRange || !hasDiffTextSelection(root) || !event.clipboardData) return;
    try {
      const text = selectedSourceText(file(), copiedRange.start, copiedRange.end);
      event.clipboardData.setData("text/plain", text);
      event.preventDefault();
    } catch (cause) { event.preventDefault(); fail((cause as Error).message); }
  }

  /** Keep failed selections intact so ordinary Copy or a second Shift-click can retry. */
  function copyRange() {
    try { copy(selectedSourceText(file(), copiedRange!.start, copiedRange!.end)); }
    catch (cause) { fail((cause as Error).message); }
  }

  host.addEventListener("pointerdown", onPointerDown);
  host.addEventListener("mousedown", onMouseDown);
  host.addEventListener("click", onClick, true);
  host.addEventListener("dblclick", onDoubleClick);
  document.addEventListener("pointerup", onPointerUp);
  document.addEventListener("pointercancel", onPointerUp);
  document.addEventListener("pointerdown", onOutsidePointerDown);
  document.addEventListener("selectionchange", onSelectionChange);
  viewport.addEventListener("keydown", onKeyDown, true);
  viewport.addEventListener("copy", onCopy);
  window.addEventListener("blur", onPointerUp);
  return function cleanup() {
    onPointerUp();
    if (hasDiffTextSelection(root)) document.getSelection()?.removeAllRanges();
    host.removeEventListener("pointerdown", onPointerDown);
    host.removeEventListener("mousedown", onMouseDown);
    host.removeEventListener("click", onClick, true);
    host.removeEventListener("dblclick", onDoubleClick);
    document.removeEventListener("pointerup", onPointerUp);
    document.removeEventListener("pointercancel", onPointerUp);
    document.removeEventListener("pointerdown", onOutsidePointerDown);
    document.removeEventListener("selectionchange", onSelectionChange);
    viewport.removeEventListener("keydown", onKeyDown, true);
    viewport.removeEventListener("copy", onCopy);
    window.removeEventListener("blur", onPointerUp);
  };
}

/** Ignore gutters and review controls even when the event crosses a shadow boundary. */
function sourceRow(target: EventTarget | null, root: ShadowRoot): HTMLElement | undefined {
  const element = target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
  if (element?.closest(controls)) return;
  const row = element?.closest<HTMLElement>("[data-content] > [data-line]");
  return row && root.contains(row) ? row : undefined;
}

/**
 * Resolve a word's source offsets without depending on syntax-token boundaries.
 *
 * DOM and source columns both use UTF-16 offsets, including Unicode identifiers.
 */
function wordAtPoint(root: ShadowRoot, event: MouseEvent, file: FileDiffMetadata, contextSide: TextPoint["side"] = "RIGHT"): Word | undefined {
  const row = sourceRow(event.composedPath()[0], root);
  if (!row) return;
  const caret = document.caretPositionFromPoint?.(event.clientX, event.clientY, { shadowRoots: [root] });
  if (!caret || !row.contains(caret.offsetNode)) return;
  const nodes = textNodes(row);
  let column = caret.offset;
  for (const node of nodes) {
    if (node === caret.offsetNode) break;
    column += node.length;
  }
  const text = nodes.map((node) => node.data).join("");
  const words = Array.from(text.matchAll(/[$_\p{ID_Continue}]+|[^\s]/gu));
  const word = words.find((match) => column >= match.index && column < match.index + match[0].length)
    ?? words.find((match) => column === match.index + match[0].length);
  if (!word) return;
  const point = lineLocation(file, Number(row.dataset.lineIndex!.split(",")[0]), contextSide);
  if (!point) return;
  // Validate against the currently rendered metadata, which may have just hydrated.
  textPointIndex(file, { ...point, column: word.index });
  return { start: { ...point, column: word.index }, end: { ...point, column: word.index + word[0].length } };
}

/** Paint with native Selection so normal Copy and browser accessibility still work. */
function showRange(root: ShadowRoot, file: FileDiffMetadata, start: TextPoint, end: TextPoint) {
  const first = domPoint(root, file, start);
  const last = domPoint(root, file, end);
  if (!first || !last) throw new Error("That word is no longer visible. Select it again.");
  document.getSelection()?.setBaseAndExtent(first.node, first.offset, last.node, last.offset);
}

/** Locate retained rows by source coordinates, not hydration-sensitive unified indexes. */
function domPoint(root: ShadowRoot, file: FileDiffMetadata, point: TextPoint): TextPosition | undefined {
  const index = textPointIndex(file, point);
  const row = Array.from(root.querySelectorAll<HTMLElement>("[data-content] > [data-line]")).find((row) => Number(row.dataset.lineIndex?.split(",")[0]) === index);
  if (!row) return;
  let offset = point.column;
  for (const node of textNodes(row)) {
    if (offset <= node.length) return { node, offset };
    offset -= node.length;
  }
}

/** Comment previews must not shift source character offsets. */
function textNodes(row: HTMLElement): Text[] {
  const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT, { acceptNode: (node) => node.parentElement?.closest("[data-biff-comment-preview]") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT });
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  return nodes;
}
