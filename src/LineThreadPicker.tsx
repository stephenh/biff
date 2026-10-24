import { useLayoutEffect, useRef } from "react";
import type { CommentSelection, LineThread } from "./lineComments";
import { ModalHeader } from "./ModalHeader";

/** Choose a root at an ambiguous gutter marker before mounting any thread composer. */
export function LineThreadPicker(props: {
  selection: CommentSelection; threads: LineThread[]; onSelect(thread: LineThread): void; onClose(): void;
}) {
  const popup = useRef<HTMLElement>(null);

  useLayoutEffect(() => {
    const element = popup.current!;
    const previous = focusedElement();
    element.showPopover();
    position();
    element.querySelector<HTMLButtonElement>(".line-thread-choice")?.focus({ preventScroll: true });

    /** Keep the compact chooser beside its gutter while the viewport moves. */
    function position() {
      const bounds = props.selection.anchor?.row?.getBoundingClientRect() ?? props.selection.anchor;
      const top = bounds?.bottom ?? 120;
      const height = element.getBoundingClientRect().height;
      const left = props.selection.anchor?.row?.getBoundingClientRect().left ?? 20;
      element.style.left = `${Math.max(8, Math.min(left, window.innerWidth - element.offsetWidth - 8))}px`;
      element.style.top = `${Math.max(8, Math.min(top + 6, window.innerHeight - height - 8))}px`;
    }

    const viewport = props.selection.anchor?.viewport;
    viewport?.addEventListener("scroll", position);
    window.addEventListener("resize", position);
    return () => {
      viewport?.removeEventListener("scroll", position);
      window.removeEventListener("resize", position);
      element.hidePopover();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);

  return <section ref={popup} popover="auto" role="dialog" className="line-thread-picker" aria-label="Choose comment thread" onToggle={(event) => { if (event.newState === "closed") props.onClose(); }} onKeyDown={(event) => {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || !["j", "k", "ArrowDown", "ArrowUp"].includes(event.key)) return;
    event.preventDefault();
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(".line-thread-choice")];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    buttons[Math.max(0, Math.min(buttons.length - 1, index + (["j", "ArrowDown"].includes(event.key) ? 1 : -1)))]?.focus();
  }}>
    <ModalHeader title={`Threads on line ${props.selection.line.line}`} closeLabel="Close thread chooser" onClose={props.onClose} shortcuts={[
      { keys: "j", aliases: ["ArrowDown"], description: "Next thread" },
      { keys: "k", aliases: ["ArrowUp"], description: "Previous thread" },
      { keys: "Enter", description: "Open thread" }, { keys: "Escape", description: "Close" },
    ]} />
    <div className="line-thread-choices">{props.threads.map((thread) => <button key={thread.id} className="line-thread-choice" onClick={() => props.onSelect(thread)}>
      <span><strong>{thread.comments[0]?.user.login}</strong><span className="muted">{thread.resolved ? "Resolved" : `${Math.max(0, thread.comments.length - 1)} replies`}{thread.unreadCount ? " · Unread" : ""}</span></span>
      <span className="line-thread-preview">{thread.comments[0]?.body}</span>
    </button>)}</div>
  </section>;
}

/** Gutter buttons live inside Pierre's shadow root; restore focus to the actual trigger. */
function focusedElement(): Element | null {
  let element = document.activeElement;
  while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
  return element;
}
