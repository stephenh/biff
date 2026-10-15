/**
 * Capture the selected line's screen position before changing deletion heights.
 *
 * Restore by row identity because Pierre may replace the DOM during a render.
 * Use an immediate scroll correction: animating it would visibly move the anchor.
 */
export function captureLineAnchor(root: ShadowRoot | null | undefined): (() => void) | undefined {
  const line = root?.querySelector<HTMLElement>("[data-biff-focused]");
  const viewport = root?.host.closest<HTMLElement>("main");
  const identity = line?.dataset.lineIndex;
  if (!line || !viewport || !identity) return;
  const top = line.getBoundingClientRect().top;

  return function restore() {
    const current = root?.querySelector<HTMLElement>(`[data-line][data-line-index="${identity}"]`);
    if (!current) return;
    viewport.scrollTo({ top: viewport.scrollTop + current.getBoundingClientRect().top - top, behavior: "instant" });
  };
}
