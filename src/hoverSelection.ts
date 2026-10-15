/**
 * Select a line after a deliberate hover without making the viewport chase the mouse.
 *
 * Track row identity rather than tokens so movement within one line keeps the timer.
 * Scrolling or keyboard input cancels it: stationary cursors must not steal focus
 * from keyboard navigation as new lines scroll underneath them.
 */
export function installHoverSelection(viewport: HTMLElement, select: (lineIndex: number) => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let candidate: string | undefined;
  let x = 0;
  let y = 0;

  /** Cancel the pending selection when the reader moves away or starts navigating. */
  function reset() {
    clearTimeout(timer);
    candidate = undefined;
  }

  /** Resolve code and gutter tokens to a row in the current diff. */
  function rowAt(target: EventTarget | null | undefined): HTMLElement | null {
    const row = target instanceof Element ? target.closest<HTMLElement>("[data-line-index]") : null;
    const root = viewport.querySelector("diffs-container")?.shadowRoot;
    return row && root?.contains(row) ? row : null;
  }

  /** Start one delay per line, ignoring text-selection drags. */
  function onPointerMove(event: PointerEvent) {
    x = event.clientX;
    y = event.clientY;
    const row = event.buttons === 0 && event.pointerType !== "touch" ? rowAt(event.composedPath()[0]) : null;
    const identity = row?.dataset.lineIndex;
    if (identity === candidate) return;
    reset();
    if (!identity) return;
    candidate = identity;
    timer = setTimeout(() => {
      const root = viewport.querySelector("diffs-container")?.shadowRoot;
      // A deletion may have expanded during the wait, moving the original row.
      const current = rowAt(root?.elementFromPoint(x, y));
      if (candidate === identity && current?.dataset.lineIndex === identity) {
        select(Number(identity.split(",")[0]));
      }
    }, 250);
  }

  document.addEventListener("pointermove", onPointerMove, true);
  document.addEventListener("pointerleave", reset);
  document.addEventListener("pointerdown", reset, true);
  document.addEventListener("keydown", reset, true);
  viewport.addEventListener("scroll", reset);
  window.addEventListener("blur", reset);
  return function cleanup() {
    reset();
    document.removeEventListener("pointermove", onPointerMove, true);
    document.removeEventListener("pointerleave", reset);
    document.removeEventListener("pointerdown", reset, true);
    document.removeEventListener("keydown", reset, true);
    viewport.removeEventListener("scroll", reset);
    window.removeEventListener("blur", reset);
  };
}
