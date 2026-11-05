/**
 * Capture a selected, frozen, or navigation target line before changing deletion heights.
 *
 * Restore by row identity because Pierre may replace the DOM during a render.
 * Use an immediate scroll correction: animating it would visibly move the anchor.
 * Return false until the target is mounted so callers can retain the anchor across windows.
 */
export function captureLineAnchor(root: ShadowRoot | null | undefined, target?: HTMLElement): (() => boolean) | undefined {
  const line = target ?? root?.querySelector<HTMLElement>("[data-biff-focused], [data-biff-pinned]");
  const viewport = root?.host.closest<HTMLElement>(".viewport");
  const identity = line?.dataset.lineIndex;
  if (!line || !viewport || !identity) return;
  const top = line.getBoundingClientRect().top;

  return function restore() {
    const current = root?.querySelector<HTMLElement>(`[data-line][data-line-index="${identity}"]`);
    if (!current) return false;
    viewport.scrollTo({ top: viewport.scrollTop + current.getBoundingClientRect().top - top, behavior: "instant" });
    return true;
  };
}
