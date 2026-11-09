import { hasDiffTextSelection } from "./diffTextSelection";

/**
 * Wait for pointer intent before opening a native deletion fold, keeping keyboard focus immediate.
 *
 * Observe the stable shadow root rather than rendered rows: virtual scrolling and
 * selection replace those rows without changing the reader's hover intent.
 */
export function installDeletionHover(root: ShadowRoot, change: (id: string | undefined) => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let activeGroup: string | undefined;
  let focusedGroup: string | undefined;

  /** Cancel pending expansion when the pointer leaves its deletion block. */
  function reset() {
    clearTimeout(timer);
    if (root.host.hasAttribute("data-biff-selecting") || hasDiffTextSelection(root)) return;
    activeGroup = undefined;
    change(focusedGroup);
  }

  /** Moving between tokens or the matching gutter must not restart the delay. */
  function onPointerMove(event: Event) {
    // A hover must never rebuild the rows holding a drag anchor or selected text.
    if ((event as PointerEvent).buttons || root.host.hasAttribute("data-biff-selecting") || hasDiffTextSelection(root)) { clearTimeout(timer); return; }
    const target = deletionTarget(root, event.composedPath()[0]);
    const group = target?.dataset.deletionFold;
    if (group === activeGroup) return;
    reset();
    if (!target || !group) return;
    activeGroup = group;
    timer = setTimeout(() => { if (activeGroup === group && !root.host.hasAttribute("data-biff-selecting") && !hasDiffTextSelection(root)) change(group); }, 50);
  }

  /** Native focus opens a strip immediately; later focus elsewhere releases it. */
  function onFocus(event: Event) {
    if (root.host.hasAttribute("data-biff-selecting") || hasDiffTextSelection(root)) return;
    focusedGroup = deletionTarget(root, event.composedPath()[0])?.dataset.deletionFold;
    clearTimeout(timer);
    // Pointerdown focuses the outer viewport before click selects the code. Do
    // not remove that code between mouse down and up while it is still hovered.
    change(focusedGroup ?? activeGroup);
  }

  /** Losing window focus must not leave a temporary expansion stuck open. */
  function onBlur() {
    focusedGroup = undefined;
    reset();
  }

  /** Cancel a hover queued before the reader pressed the mouse. */
  function onPointerDown() { clearTimeout(timer); }

  document.addEventListener("pointermove", onPointerMove, true);
  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("pointerleave", reset);
  document.addEventListener("focusin", onFocus, true);
  window.addEventListener("blur", onBlur);
  return function cleanup() {
    clearTimeout(timer);
    document.removeEventListener("pointermove", onPointerMove, true);
    document.removeEventListener("pointerdown", onPointerDown, true);
    document.removeEventListener("pointerleave", reset);
    document.removeEventListener("focusin", onFocus, true);
    window.removeEventListener("blur", onBlur);
  };
}

/** Ignore deletion folds belonging to another reading pane. */
function deletionTarget(root: ShadowRoot, target: EventTarget | null): HTMLElement | null {
  const row = target instanceof Element ? target.closest<HTMLElement>("[data-deletion-fold]") : null;
  return row && root.contains(row) ? row : null;
}
