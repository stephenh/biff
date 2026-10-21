import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import type { CommentSelection } from "./lineComments";
import { commentOverlayStyle } from "./commentOverlayStyle";

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

  useEffect(() => {
    const element = dialog.current;
    const previous = document.activeElement;
    element?.showModal();
    // Focus after opening so the native dialog does not select the close button instead.
    // Embedded threads already have a modal focus boundary; only move focus into the reply.
    props.composer.current?.focus();
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
  }}>{props.children}</section>;

  return <dialog ref={dialog} className="comment-overlay" data-comment-overlay aria-label={props.label} style={commentOverlayStyle(props.selection)} onCancel={(event) => { event.preventDefault(); if (!props.busy) props.onClose(); }} onClick={(event) => {
    if (event.target !== event.currentTarget || props.busy) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) props.onClose();
  }}>{props.children}</dialog>;
}
