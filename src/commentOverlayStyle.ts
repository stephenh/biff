import type { CommentSelection } from "./lineComments";

/** Place comments below the selected line, leaving room for the composer inside the viewport. */
export function commentOverlayStyle(selection: CommentSelection) {
  const top = Math.max(90, Math.min(selection.anchor?.bottom ?? 180, window.innerHeight - 480));
  return { top, maxHeight: `calc(100dvh - ${top + 20}px)` };
}
