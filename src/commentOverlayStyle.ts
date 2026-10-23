import type { CommentSelection } from "./lineComments";
import { createSmoothScroll } from "./smoothScroll";

const gap = 8;
const composerRoom = 480;

/** Place comments beside the line's vertical bounds, never by clamping the box across it. */
export function commentOverlayStyle(selection: CommentSelection) {
  const anchor = selection.anchor;
  const top = anchor ? anchor.bottom + gap : Math.max(90, Math.min(180, window.innerHeight - composerRoom));
  // A short viewport or a clamped scroll range may leave more usable space above the line.
  if (anchor && (anchor.above ?? preferAbove(anchor.top, anchor.bottom))) {
    return { top: "auto", bottom: window.innerHeight - anchor.top + gap, maxHeight: Math.max(0, anchor.top - 90 - gap) };
  }
  return { top, bottom: "auto", maxHeight: `calc(100dvh - ${top + 20}px)` };
}

/** Retarget the line-navigation spring and let the dialog follow the moving source row. */
export function prepareCommentAnchor(row: HTMLElement) {
  const root = row.getRootNode();
  const viewport = (root instanceof ShadowRoot ? root.host : row).closest<HTMLElement>(".viewport");
  const bounds = row.getBoundingClientRect();
  let shift = 0;
  if (viewport) {
    const visibleTop = viewport.getBoundingClientRect().top + gap;
    const bottom = Math.max(visibleTop + bounds.height, window.innerHeight - composerRoom - gap);
    const delta = bounds.top < visibleTop ? bounds.top - visibleTop : Math.max(0, bounds.bottom - bottom);
    const target = Math.max(0, Math.min(viewport.scrollHeight - viewport.clientHeight, viewport.scrollTop + delta));
    shift = target - viewport.scrollTop;
    createSmoothScroll(viewport).to(target, !matchMedia("(prefers-reduced-motion: reduce)").matches);
  }
  const current = row.getBoundingClientRect();
  // Choose a side using the destination, so the box never flips sides during the animation.
  return { top: current.top, bottom: current.bottom, row, viewport: viewport ?? undefined, above: preferAbove(bounds.top - shift, bounds.bottom - shift) };
}

/** Use the space above only when scrolling cannot leave a usable composer below. */
function preferAbove(top: number, bottom: number) {
  const below = window.innerHeight - bottom - gap - 20;
  return below < 240 && top - 90 - gap > below;
}
