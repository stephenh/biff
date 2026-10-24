import { createContext, useContext, useEffect, useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";
import type { CommentSelection } from "./lineComments";
import { commentOverlayStyle } from "./commentOverlayStyle";
import { ModalBusyContext } from "./ModalHeader";

/** The shared browser supplies actions backed by its optimistic thread state. */
export const EmbeddedThreadActions = createContext<ReactNode>(null);

/**
 * Reuse the same composer in a line dialog or as a page inside file comments.
 *
 * Embedded threads use the outer dialog's focus boundary and Back navigation, not a second modal.
 */
export function CommentFrame(props: {
  selection: CommentSelection; label: string; busy: boolean; composer: RefObject<HTMLTextAreaElement | null>;
  children: ReactNode; onClose(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const setModalBusy = useContext(ModalBusyContext);
  const threadActions = useContext(EmbeddedThreadActions);

  useEffect(() => {
    setModalBusy?.(props.busy);
    return () => setModalBusy?.(false);
  }, [props.busy, setModalBusy]);

  useLayoutEffect(() => {
    const anchor = props.selection.anchor;
    const element = dialog.current;
    if (!element || !anchor?.row || !anchor.viewport) return;
    const root = anchor.row.getRootNode();
    const index = anchor.row.dataset.lineIndex;

    /** Update only dialog geometry; typing and comment rendering do not participate in scrolling. */
    function followLine() {
      // Virtualization can replace the original DOM row while the spring is moving.
      const row = root instanceof ShadowRoot && index ? root.querySelector<HTMLElement>(`[data-content] > [data-line-index="${CSS.escape(index)}"]`) : anchor!.row;
      if (!row?.isConnected) return;
      const bounds = row.getBoundingClientRect();
      const style = commentOverlayStyle({ ...props.selection, anchor: { ...anchor, top: bounds.top, bottom: bounds.bottom } });
      for (const key of ["top", "bottom", "maxHeight"] as const) {
        const value = style[key];
        element!.style[key] = typeof value === "number" ? `${value}px` : value;
      }
    }
    followLine();
    anchor.viewport.addEventListener("scroll", followLine);
    window.addEventListener("resize", followLine);
    return () => {
      anchor.viewport!.removeEventListener("scroll", followLine);
      window.removeEventListener("resize", followLine);
    };
  }, [props.selection]);

  useEffect(() => {
    const element = dialog.current;
    const previous = document.activeElement;
    element?.showModal();
    // Focus after opening so the native dialog does not select the close button instead.
    // Existing threads start in reading mode. Space acknowledges; typing in Reply stays native.
    const reader = props.composer.current?.closest("[data-comment-overlay], .comment-detail")?.querySelector<HTMLElement>('[data-comment-message][data-selected="true"]');
    (reader ?? props.composer.current)?.focus({ preventScroll: true });
    return () => {
      element?.close();
      if (element && previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);

  if (props.selection.embedded) return <section className="comment-detail" aria-label={props.label} aria-busy={props.busy} onKeyDown={(event) => {
    if (event.key === "Escape" && !event.defaultPrevented) {
      event.preventDefault();
      event.stopPropagation();
      if (!props.busy) props.onClose();
    }
  }}>{props.children}{threadActions}</section>;

  return <dialog ref={dialog} className="comment-overlay" data-comment-overlay aria-label={props.label} style={commentOverlayStyle(props.selection)} onCancel={(event) => { event.preventDefault(); if (!props.busy) props.onClose(); }} onClick={(event) => {
    if (event.target !== event.currentTarget || props.busy) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) props.onClose();
  }}>{props.children}</dialog>;
}
