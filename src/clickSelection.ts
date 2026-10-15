/**
 * Select code or gutter rows only on an intentional click, without scrolling.
 *
 * Leave text-selection drags and inline comment controls to their native handlers.
 */
export function installClickSelection(viewport: HTMLElement, select: (lineIndex: number) => void): () => void {
  let start: { x: number; y: number } | undefined;

  /** Remember the drag origin without interfering with native text selection. */
  function onPointerDown(event: PointerEvent) {
    start = event.button === 0 ? { x: event.clientX, y: event.clientY } : undefined;
  }

  /** Resolve syntax tokens and gutters through the diff's shadow root. */
  function onClick(event: MouseEvent) {
    const origin = start;
    start = undefined;
    if (!origin || event.button !== 0 || event.detail > 1 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    if (Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > 4) return;
    const target = event.composedPath()[0];
    if (!(target instanceof Element) || target.closest("button, a, input, textarea, select, [contenteditable]")) return;
    const row = target.closest<HTMLElement>("[data-line-index]");
    const root = viewport.querySelector("diffs-container")?.shadowRoot;
    if (!row || !root?.contains(row) || !row.dataset.lineIndex) return;
    select(Number(row.dataset.lineIndex.split(",")[0]));
    viewport.focus({ preventScroll: true });
  }

  viewport.addEventListener("pointerdown", onPointerDown);
  viewport.addEventListener("click", onClick);
  return function cleanup() {
    viewport.removeEventListener("pointerdown", onPointerDown);
    viewport.removeEventListener("click", onClick);
  };
}
