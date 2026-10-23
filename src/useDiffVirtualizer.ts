import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { DEFAULT_VIRTUAL_FILE_METRICS, Virtualizer, type VirtualizedFileDiff } from "@pierre/diffs";
import { ReadingTypographyContext } from "./Settings";
import { useStableCallback } from "./useStableCallback";

/**
 * Give each reading pane its own native window while sharing typography and resize handling.
 *
 * The owner retains its source anchor before width or font changes invalidate Pierre's measurements.
 */
export function useDiffVirtualizer(beforeMeasure?: () => void) {
  const typography = useContext(ReadingTypographyContext);
  const virtualMetrics = useMemo(() => ({ ...DEFAULT_VIRTUAL_FILE_METRICS, lineHeight: Math.round(typography.size * 1.6) }), [typography.size]);
  const viewport = useRef<HTMLDivElement>(null);
  const diffInstance = useRef<VirtualizedFileDiff | undefined>(undefined);
  const [virtualizer] = useState(() => new Virtualizer({ overscrollSize: 600 }));
  const previousTypography = useRef(typography);
  const attachViewport = useStableCallback((element: HTMLDivElement | null) => {
    viewport.current = element;
    if (element) virtualizer.setup(element);
    else virtualizer.cleanUp();
  });
  const refreshMeasurements = useStableCallback((force: boolean) => {
    if (force) beforeMeasure?.();
    diffInstance.current?.setMetrics(virtualMetrics, force);
  });

  useEffect(() => {
    /** Loaded glyphs can change wrapping without changing the selected source coordinate. */
    function reconcileFonts() {
      if (diffInstance.current) virtualizer.requestHeightReconcile(diffInstance.current);
    }
    const previous = previousTypography.current;
    previousTypography.current = typography;
    refreshMeasurements(previous.size !== typography.size || previous.font !== typography.font);
    let width = viewport.current?.clientWidth;
    const observer = new ResizeObserver(() => {
      const next = viewport.current?.clientWidth;
      if (next === width) return;
      width = next;
      refreshMeasurements(true);
    });
    if (viewport.current) observer.observe(viewport.current);
    document.fonts.addEventListener("loadingdone", reconcileFonts);
    return () => {
      observer.disconnect();
      document.fonts.removeEventListener("loadingdone", reconcileFonts);
    };
  }, [virtualMetrics, typography.font]);

  return { viewport, diffInstance, virtualizer, virtualMetrics, attachViewport };
}
