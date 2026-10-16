export interface FileSlide { play(): void; cancel(): void }

/**
 * Retain an inert picture of the outgoing diff while React renders the next file.
 *
 * Pierre renders code inside a shadow root, which cloneNode does not copy. Copy
 * its rendered shadow tree and styles explicitly; the snapshot owns no renderer
 * or event handlers, so only the incoming file remains interactive.
 */
export function prepareFileSlide(stage: HTMLElement, viewport: HTMLElement, direction: 1 | -1): FileSlide | undefined {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const snapshot = viewport.cloneNode(true) as HTMLElement;
  const source = viewport.querySelector("diffs-container")?.shadowRoot;
  const target = snapshot.querySelector("diffs-container");
  if (!source || !target) return;
  const shadow = target.shadowRoot ?? target.attachShadow({ mode: "open" });
  shadow.replaceChildren(...Array.from(source.childNodes, (node) => node.cloneNode(true)));
  shadow.adoptedStyleSheets = source.adoptedStyleSheets;
  snapshot.inert = true;
  snapshot.setAttribute("aria-hidden", "true");
  snapshot.removeAttribute("aria-label");
  snapshot.removeAttribute("tabindex");
  snapshot.dataset.fileSnapshot = "";
  stage.append(snapshot);
  snapshot.scrollTop = viewport.scrollTop;
  snapshot.scrollLeft = viewport.scrollLeft;
  let incoming: Animation | undefined;
  let outgoing: Animation | undefined;
  let started = false;

  /** Start only after the new diff has rendered and restored its initial scroll. */
  function play() {
    if (started) return;
    started = true;
    const distance = stage.clientWidth + 20;
    const timing = { duration: 320, easing: "cubic-bezier(0.22, 1, 0.36, 1)" };
    outgoing = snapshot.animate([{ transform: "translateX(0)" }, { transform: `translateX(${-direction * distance}px)` }], timing);
    incoming = viewport.animate([{ transform: `translateX(${direction * distance}px)` }, { transform: "translateX(0)" }], timing);
    incoming.finished.then(cancel, cancel);
  }

  /** Repeated navigation and unmounts release both the snapshot and its animations. */
  function cancel() {
    snapshot.remove();
    outgoing?.cancel();
    incoming?.cancel();
  }

  return { play, cancel };
}
