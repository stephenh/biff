import { useEffect, useRef, type ReactNode } from "react";
import { ModalHeader } from "./ModalHeader";

/** Keep PR overview focus inside a native modal and return to its inbox row on dismissal. */
export function OverviewDialog(props: { children: ReactNode; busy?: boolean; onClose(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const element = dialog.current!;
    const previous = document.activeElement;
    // Reading the last thread can remove its badge while the modal is still open.
    const row = previous instanceof Element ? previous.closest(".pr-card") : null;
    element.showModal();
    return () => {
      element.close();
      const target = previous instanceof HTMLElement && previous.isConnected && previous.getClientRects().length ? previous : row?.querySelector<HTMLElement>(".card-title");
      target?.focus({ preventScroll: true });
    };
  }, []);

  return <dialog ref={dialog} className="review-panel review-dialog" aria-label="PR overview" onCancel={(event) => {
    event.preventDefault();
    if (!props.busy) props.onClose();
  }} onClick={(event) => {
    if (event.target !== event.currentTarget || props.busy) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) props.onClose();
  }}>
    <ModalHeader title="PR overview" closeLabel="Close PR overview" closeDisabled={props.busy} onClose={props.onClose} shortcuts={[
      ...(!props.busy ? [{ keys: "Escape", description: "Close overview" }] : []),
    ]} />
    {props.children}
  </dialog>;
}
