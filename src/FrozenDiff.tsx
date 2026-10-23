import { useContext, useLayoutEffect, useMemo, useRef, useState } from "react";
import { VirtualizedFileDiff, type FileDiffContentsLoader, type FileDiffLoadedFiles, type FileDiffMetadata, type FileDiffOptions } from "@pierre/diffs";
import type { ReviewLine } from "../shared/types";
import { DiffSurface } from "./DiffSurface";
import { CollapseDeletedContext } from "./Settings";
import { collapseDeletions, isCollapsedDeletion, updateDeletionVisibility } from "./collapseDeletions";
import { findDiffLine, revealDiffLine } from "./diffViewport";
import { importGroups, importGroupId } from "./importFolds";
import { highlightMovedLines } from "./movedLines";
import { lineLocation } from "./navigation";
import { semanticDividerCSS } from "./semanticDividers";
import { useDiffVirtualizer } from "./useDiffVirtualizer";
import { useStableCallback } from "./useStableCallback";

export interface FrozenLocation {
  file: FileDiffMetadata;
  location: ReviewLine;
  screenTop: number;
  expandedImports: Set<string>;
  showDeletions: boolean;
  showUnmodified: boolean;
  request: number;
}

interface FrozenDiffProps {
  frozen: FrozenLocation;
  contents?: FileDiffLoadedFiles;
  loadContents?: FileDiffContentsLoader;
  onClose: () => void;
}

/**
 * Keep a scrollable reference without installing a second reviewer or global shortcuts.
 *
 * The prepared file and source cache are shared; scroll, folds and the frozen coordinate are local.
 */
export function FrozenDiff(props: FrozenDiffProps) {
  const frozen = props.frozen;
  const file = frozen.file;
  const collapseOld = useContext(CollapseDeletedContext);
  const [expanded, setExpanded] = useState(frozen.expandedImports);
  const [showUnmodified, setShowUnmodified] = useState(frozen.showUnmodified);
  const [error, setError] = useState("");
  const pending = useRef<{ location: ReviewLine; top: number } | undefined>({ location: frozen.location, top: frozen.screenTop });
  const container = useRef<HTMLElement | undefined>(undefined);
  const activeDiff = useRef(file);
  const { viewport, diffInstance, virtualizer, virtualMetrics, attachViewport } = useDiffVirtualizer(preserveScroll);
  const dividerCSS = useMemo(() => semanticDividerCSS(file), [file]);
  const resolveFoldedRanges = useMemo<NonNullable<FileDiffOptions<undefined, undefined>["resolveFoldedRanges"]>>(() => (diff) => {
    return importGroups(diff, props.contents).map((group) => ({ id: importGroupId(group), start: group.start, end: group.end, label: `${group.changes} Import ${group.changes === 1 ? "change" : "changes"}`, expanded: group.keys.some((key) => expanded.has(key)), includeLeadingContext: group.leading }));
  }, [file, props.contents, expanded]);
  const onRender = useStableCallback<Parameters<NonNullable<FileDiffOptions<undefined, undefined>["onPostRender"]>>, void>((node, instance, phase) => {
    if (phase === "unmount") {
      collapseDeletions(node, false);
      return;
    }
    container.current = node;
    activeDiff.current = instance.fileDiff ?? file;
    if (instance instanceof VirtualizedFileDiff) diffInstance.current = instance;
    highlightMovedLines(node, file);
    collapseDeletions(node, collapseOld);
    syncFrozenLine(node);
    // Native hydration and virtualization restore their anchors after onPostRender.
    queueMicrotask(() => { if (node.isConnected) restoreScroll(); });
  });
  const loadContents = useStableCallback(async () => {
    try {
      // Use the original prepared file as the cache key, not a hydrated renderer copy.
      return await props.loadContents!(file);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load unmodified lines.");
      setShowUnmodified(false);
      throw cause;
    }
  });

  useLayoutEffect(() => {
    const node = container.current;
    if (!node) return;
    collapseDeletions(node, collapseOld);
    syncFrozenLine(node);
  }, [collapseOld]);

  /** Keep an old-side pin readable even when deleted blocks normally collapse. */
  function syncFrozenLine(node: HTMLElement) {
    for (const previous of node.shadowRoot?.querySelectorAll("[data-biff-pinned]") ?? []) previous.removeAttribute("data-biff-pinned");
    const row = findDiffLine(node.shadowRoot, activeDiff.current, frozen.location);
    const index = row ? Number(row.dataset.lineIndex!.split(",")[0]) : undefined;
    updateDeletionVisibility(node, collapseOld, frozen.showDeletions ? index : undefined, frozen.location.side === "LEFT" ? index : undefined);
    row?.setAttribute("data-biff-pinned", "");
  }

  /** Retain the reader's current reference position, not the original pin, on resize. */
  function preserveScroll() {
    if (pending.current || !viewport.current) return;
    const top = viewport.current.getBoundingClientRect().top;
    const row = Array.from(container.current?.shadowRoot?.querySelectorAll<HTMLElement>("[data-content] > [data-line]") ?? []).find((entry) => !isCollapsedDeletion(entry) && entry.getBoundingClientRect().bottom > top);
    const location = row && lineLocation(activeDiff.current, Number(row.dataset.lineIndex!.split(",")[0]));
    if (row && location) pending.current = { location, top: row.getBoundingClientRect().top };
  }

  /** Mount distant rows through Pierre, then align their actual wrapped bounds. */
  function restoreScroll() {
    const request = pending.current;
    const element = viewport.current;
    if (!request || !element) return;
    const row = findDiffLine(container.current?.shadowRoot, activeDiff.current, request.location);
    if (row) {
      const top = Math.max(element.getBoundingClientRect().top, request.top);
      element.scrollTop += row.getBoundingClientRect().top - top;
      pending.current = undefined;
    } else if (diffInstance.current) {
      revealDiffLine(diffInstance.current, virtualizer, request.location, request.top - element.getBoundingClientRect().top + virtualMetrics.lineHeight / 2);
    }
  }

  /** Revisit the frozen coordinate after independently scrolling the reference. */
  function returnToPin() {
    if (!viewport.current) return;
    pending.current = { location: frozen.location, top: viewport.current.getBoundingClientRect().top + viewport.current.clientHeight / 2 };
    const group = importGroups(activeDiff.current, props.contents).find((entry) => entry.keys.includes(`${frozen.location.side}:${frozen.location.line}`));
    if (group && !group.keys.some((key) => expanded.has(key))) {
      setExpanded(new Set([...expanded, ...group.keys]));
      return;
    }
    if (frozen.showUnmodified && !showUnmodified) setShowUnmodified(true);
    restoreScroll();
  }

  /** Native import folds remain independently inspectable in the reference. */
  function toggleImport(id: string, open: boolean) {
    const group = importGroups(activeDiff.current, props.contents).find((entry) => importGroupId(entry) === id);
    if (!group) return;
    preserveScroll();
    // A deliberately hidden import cannot remain the scroll-restoration target.
    if (!open && pending.current && group.keys.includes(`${pending.current.location.side}:${pending.current.location.line}`)) pending.current = undefined;
    setExpanded((current) => {
      const next = new Set(current);
      for (const key of group.keys) { if (open) next.add(key); else next.delete(key); }
      return next;
    });
  }

  /** Reference scroll buttons never move the main review cursor. */
  function scrollLines(direction: 1 | -1) {
    pending.current = undefined;
    viewport.current?.scrollBy({ top: direction * virtualMetrics.lineHeight, behavior: "instant" });
  }

  return <aside className="frozen-diff" aria-label="Frozen diff">
    <div className="frozen-diff-heading">
      <span className="frozen-diff-path" title={`${file.name}:${frozen.location.line} (${frozen.location.side === "LEFT" ? "old" : "new"} file)`}>Frozen · {file.name}:{frozen.location.line}{frozen.location.side === "LEFT" ? " (old)" : ""}</span>
      <button onClick={returnToPin} title="Return to frozen line" aria-label="Return to frozen line">↩</button>
      <button onClick={() => scrollLines(-1)} aria-label="Scroll frozen diff up">↑</button>
      <button onClick={() => scrollLines(1)} aria-label="Scroll frozen diff down">↓</button>
      <button onClick={() => { if (showUnmodified) pending.current = undefined; else preserveScroll(); setShowUnmodified((current) => !current); }} disabled={file.isPartial && !props.loadContents} aria-label="Show unmodified lines in frozen diff" aria-pressed={showUnmodified} title="Toggle unmodified lines in frozen diff">Context</button>
      <button onClick={props.onClose} aria-label="Close frozen diff" title="Close frozen diff (Esc)">×</button>
    </div>
    {error && <div className="error" role="alert">{error}<button onClick={() => { setError(""); setShowUnmodified(true); }}>Retry</button></div>}
    <div ref={attachViewport} className="viewport" aria-label="Frozen diff reading surface" tabIndex={0} onWheel={() => { pending.current = undefined; }} onClick={(event) => {
      const origin = event.nativeEvent.composedPath()[0];
      const button = origin instanceof Element ? origin.closest<HTMLElement>("[data-fold-toggle]") : null;
      if (button) toggleImport(button.dataset.foldToggle!, button.getAttribute("aria-expanded") !== "true");
    }}>
      <div className="surface">
        <DiffSurface file={file} virtualizer={virtualizer} metrics={virtualMetrics} options={{
          resolveFoldedRanges,
          expandUnchanged: showUnmodified,
          loadDiffFiles: props.loadContents ? loadContents : undefined,
          unsafeCSS: `${dividerCSS}\n[data-biff-pinned] { outline: 1px solid #b4b8ff; outline-offset: -1px; box-shadow: inset 3px 0 #b4b8ff; }`,
          onPostRender: onRender,
        }} />
        <div className="end-note">End of {file.name} · Reference only</div>
      </div>
    </div>
  </aside>;
}
