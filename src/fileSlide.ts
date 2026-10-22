export interface FileSlide { play(): void; cancel(): void }

/**
 * Introduce the incoming file without cloning source rows or shadow trees.
 *
 * Native virtualization recycles rows while scrolling. A second DOM picture
 * would add layout work and duplicate that transient window during every switch.
 */
export function prepareFileSlide(viewport: HTMLElement, direction: 1 | -1, onTiming?: (phase: string, durationMs: number) => void): FileSlide | undefined {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  let incoming: Animation | undefined;
  let started = false;

  /** Start only after the new diff has rendered and restored its initial scroll. */
  function play() {
    if (started) return;
    started = true;
    const animationStarted = performance.now();
    const timing = { duration: 180, easing: "cubic-bezier(0.22, 1, 0.36, 1)" };
    incoming = viewport.animate([{ transform: `translateX(${direction * 24}px)`, opacity: 0 }, { transform: "translateX(0)", opacity: 1 }], timing);
    incoming.finished.then(() => {
      onTiming?.("file slide playback", performance.now() - animationStarted);
      cancel();
    }, () => {
      onTiming?.("file slide playback canceled", performance.now() - animationStarted);
      cancel();
    });
  }

  /** Repeated navigation and unmounts release the incoming animation. */
  function cancel() {
    incoming?.cancel();
  }

  return { play, cancel };
}
