interface HoverController {
  cleanup(): void;
  expandedLine(): string | undefined;
}

const hoverControllers = new WeakMap<ShadowRoot, HoverController>();

/**
 * Collapse each consecutive deletion block without changing its typography.
 *
 * Pierre puts gutters and code in separate subgrids. Tag both with the same
 * block ID so hovering either expands all matching rows, including wrapped lines.
 */
export function collapseDeletions(container: HTMLElement, enabled: boolean) {
  const root = container.shadowRoot;
  if (!root) return;
  // Updating the selected line must not close the deletion block under the pointer.
  const controller = hoverControllers.get(root);
  const expandedLine = controller?.expandedLine();
  controller?.cleanup();
  hoverControllers.delete(root);

  let style = root.querySelector<HTMLStyleElement>("style[data-biff-collapse]");
  if (!enabled) {
    style?.remove();
    for (const element of root.querySelectorAll<HTMLElement>("[data-biff-group]")) {
      if (element.hasAttribute("data-biff-start") && element.hasAttribute("data-line")) {
        element.removeAttribute("tabindex");
        element.removeAttribute("aria-label");
      }
      delete element.dataset.biffGroup;
      delete element.dataset.biffStart;
    }
    return;
  }

  const groups: HTMLElement[][] = [];
  const gutters = new Map(Array.from(root.querySelectorAll<HTMLElement>("[data-gutter] > [data-line-index]")).map((element) => [element.dataset.lineIndex, element]));
  let previous: HTMLElement | undefined;
  for (const line of root.querySelectorAll<HTMLElement>("[data-content] > [data-line]")) {
    if (line.dataset.lineType !== "change-deletion") {
      previous = undefined;
      continue;
    }
    if (!previous || line.previousElementSibling !== previous) groups.push([]);
    groups[groups.length - 1].push(line);
    previous = line;
  }

  const rules: string[] = [];
  for (const [index, lines] of groups.entries()) {
    for (const [offset, line] of lines.entries()) {
      for (const element of [line, gutters.get(line.dataset.lineIndex)]) {
        if (!element) continue;
        element.dataset.biffGroup = String(index);
        if (offset === 0) element.dataset.biffStart = "";
      }
    }
    const first = lines[0];
    first.tabIndex = 0;
    first.setAttribute("aria-label", `${lines.length} deleted ${lines.length === 1 ? "line" : "lines"}. Focus or hover to expand.`);

    // The first strip stays at the block's top when expanded, avoiding hover flicker.
    // I.e. group 1's two code rows and two gutter rows expand together.
    const group = `[data-biff-group="${index}"]`;
    const collapsed = `pre:not(:has(${group}:is([data-biff-hover], :focus-within))) ${group}`;
    rules.push(`
      ${collapsed} { height: 0; min-height: 0; line-height: 0; overflow: hidden; padding-block: 0; }
      ${collapsed} > * { visibility: hidden; }
      ${collapsed}[data-biff-start] { height: 10px; line-height: 10px; }
      ${collapsed}[data-biff-start][data-line]::after {
        content: "− ${lines.length} deleted ${lines.length === 1 ? "line" : "lines"}";
        position: absolute; inset: 0; padding-inline: 1ch;
        font: 9px/10px system-ui, sans-serif; color: #efa5ad;
        background: var(--diffs-bg-deletion); cursor: pointer;
      }
    `);
  }

  if (!style) {
    style = document.createElement("style");
    style.dataset.biffCollapse = "";
    root.append(style);
  }
  const css = rules.join("\n");
  if (style.textContent !== css) style.textContent = css;
  if (expandedLine) root.querySelector(`[data-biff-group][data-line-index="${expandedLine}"]`)?.setAttribute("data-biff-hover", "");
  hoverControllers.set(root, installDelayedHover(root));
}

/**
 * Wait for pointer intent before expanding, while keeping keyboard focus immediate.
 *
 * Track the shared block so moving between tokens or between a block's
 * gutter and code does not restart the delay or collapse an expanded block.
 */
function installDelayedHover(root: ShadowRoot): HoverController {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expandedRow = root.querySelector<HTMLElement>("[data-biff-hover]");
  let activeGroup = expandedRow?.dataset.biffGroup;

  /** Cancel pending expansion and clear the block that was previously hovered. */
  function reset() {
    clearTimeout(timer);
    activeGroup = undefined;
    expandedRow = null;
    for (const element of root.querySelectorAll("[data-biff-hover]")) {
      element.removeAttribute("data-biff-hover");
    }
  }

  /** Start the delay only when entering a different deletion block. */
  function onPointerMove(event: Event) {
    const row = findDeletionRow(event.composedPath()[0]);
    const target = row && root.contains(row) ? row : null;
    const group = target?.dataset.biffGroup;
    if (group === activeGroup) return;
    reset();
    if (!target || group === undefined) return;
    activeGroup = group;
    timer = setTimeout(() => {
      if (target.isConnected && activeGroup === group) {
        target.setAttribute("data-biff-hover", "");
        expandedRow = target;
      }
    }, 50);
  }

  // Observe movement outside the shadow root too: renderer DOM replacement can
  // detach hovered rows without delivering a pointerout event.
  document.addEventListener("pointermove", onPointerMove, true);
  document.addEventListener("pointerleave", reset);
  window.addEventListener("blur", reset);
  return { cleanup, expandedLine };

  /** Retain row identity across Pierre replacing rendered DOM during selection. */
  function expandedLine() {
    return expandedRow?.dataset.lineIndex;
  }

  /** Remove document listeners when the renderer updates or unmounts. */
  function cleanup() {
    reset();
    document.removeEventListener("pointermove", onPointerMove, true);
    document.removeEventListener("pointerleave", reset);
    window.removeEventListener("blur", reset);
  }
}

/** Resolve syntax tokens and gutters to their shared deletion block. */
function findDeletionRow(target: EventTarget | null): HTMLElement | null {
  return target instanceof Element ? target.closest<HTMLElement>("[data-biff-group]") : null;
}
