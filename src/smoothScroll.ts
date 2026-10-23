export interface SmoothScroll { to(top: number, smooth: boolean): void; follow(center: number, smooth: boolean): void; cancel(): void; destroy(): void }
const scrollers = new WeakMap<HTMLElement, SmoothScroll>();

/**
 * Follow a moving keyboard target without restarting an easing curve on every keypress.
 *
 * A critically damped spring preserves velocity across keypresses, so each new target
 * changes acceleration rather than abruptly changing the speed of the text.
 */
export function createSmoothScroll(element: HTMLElement): SmoothScroll {
  // Comment placement and line navigation must retarget the same spring, not compete.
  const existing = scrollers.get(element);
  if (existing) return existing;
  let frame: number | undefined;
  let target = 0;
  let position = 0;
  let velocity = 0;
  let previousTime = 0;
  element.addEventListener("wheel", cancel, { passive: true });
  element.addEventListener("pointerdown", cancel, { passive: true });
  element.addEventListener("keydown", onKeyDown);

  /** Retarget an existing animation without resetting its clock or fractional position. */
  function to(top: number, smooth: boolean) {
    target = Math.max(0, Math.min(top, element.scrollHeight - element.clientHeight));
    if (!smooth) {
      cancel();
      element.scrollTo({ top: target, behavior: "instant" });
    } else if (frame === undefined) {
      position = element.scrollTop;
      if (Math.abs(target - position) < 0.5) return;
      velocity = 0;
      previousTime = performance.now();
      frame = requestAnimationFrame(step);
    }
  }

  /** Let j/k move within the middle 20% of the viewport without dragging the text along. */
  function follow(center: number, smooth: boolean) {
    if (!smooth) { to(center, false); return; }
    const margin = element.clientHeight * 0.1;
    // Use the destination during motion, not today's lagging scroll position. Otherwise
    // key repeat can pull an in-flight destination backward as the viewport catches up.
    const resting = frame === undefined ? element.scrollTop : target;
    to(Math.max(center - margin, Math.min(center + margin, resting)), true);
  }

  /** Keep subpixel progress locally because scrollTop can round to whole pixels. */
  function step(time: number) {
    const elapsed = Math.min(64, time - previousTime) / 1000;
    previousTime = time;
    // Solve the spring analytically so 60Hz and 144Hz displays follow the same curve.
    // A 120ms time constant takes about 570ms to cover 95% of a stationary step.
    const frequency = 1 / 0.12;
    const displacement = position - target;
    const rate = velocity + frequency * displacement;
    const decay = Math.exp(-frequency * elapsed);
    position = target + (displacement + rate * elapsed) * decay;
    velocity = (velocity - frequency * rate * elapsed) * decay;
    const settled = Math.abs(target - position) < 0.25 && Math.abs(velocity) < 2;
    element.scrollTo({ top: settled ? target : position, behavior: "instant" });
    frame = settled ? undefined : requestAnimationFrame(step);
  }

  /** Manual scrolling and layout anchoring take precedence over keyboard animation. */
  function cancel() {
    if (frame !== undefined) cancelAnimationFrame(frame);
    frame = undefined;
    velocity = 0;
  }

  /** Native keyboard scrolling must not compete with a pending j/k animation. */
  function onKeyDown(event: KeyboardEvent) {
    if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) {
      // Biff handles Space on window during bubbling. Wait until that handler has
      // prevented native scrolling before deciding whether to stop our spring.
      queueMicrotask(() => { if (!event.defaultPrevented) cancel(); });
    }
  }

  /** Release listeners and animation frames when the viewer unmounts. */
  function destroy() {
    cancel();
    scrollers.delete(element);
    element.removeEventListener("wheel", cancel);
    element.removeEventListener("pointerdown", cancel);
    element.removeEventListener("keydown", onKeyDown);
  }

  const scroller = { to, follow, cancel, destroy };
  scrollers.set(element, scroller);
  return scroller;
}
