import { useEffect, useMemo, useRef, useState } from "react";
import type { FileDiffMetadata } from "@pierre/diffs";
import type { ReviewLine } from "../shared/types";
import { deletionFolds, revealedDeletions, type FoldedRange } from "./deletionFolds";
import { installDeletionHover } from "./deletionHover";
import { useStableCallback } from "./useStableCallback";

/**
 * Share controlled deletion folds between the main and frozen native reading windows.
 *
 * Expansion changes the native layout, but movement within one block must retain
 * the resolver's identity so each cursor step does not rebuild the rendered window.
 */
export function useDeletionFolds(file: FileDiffMetadata, enabled: boolean, imports: readonly { start: number; end: number }[], beforeChange: () => void, near?: ReviewLine, reveal?: ReviewLine) {
  const [hovered, setHovered] = useState<{ path: string; id: string | undefined }>();
  const hover = useRef<{ root: ShadowRoot; path: string; cleanup: () => void } | undefined>(undefined);
  const folds = useMemo(() => deletionFolds(file, imports), [file, file.hunks, imports]);
  const expanded = revealedDeletions(folds, near, reveal);
  if (hovered?.path === file.name && hovered.id) expanded.add(hovered.id);

  // Moving inside the same block must not change Pierre's option identity and rebuild its rows.
  const expansionKey = JSON.stringify([...expanded].sort());
  const resolve = useMemo(() => {
    const open = new Set<string>(JSON.parse(expansionKey));
    return function resolve(diff: FileDiffMetadata, importRanges: readonly FoldedRange[]): FoldedRange[] {
      const deletions = enabled ? deletionFolds(diff, importRanges).map((fold) => ({ ...fold, expanded: open.has(fold.id) })) : [];
      return [...importRanges, ...deletions].sort((a, b) => a.start - b.start);
    };
  }, [enabled, expansionKey]);

  const changesForSelection = useStableCallback((location?: ReviewLine) => {
    if (!enabled) return false;
    const next = revealedDeletions(folds, near ? location : undefined, location);
    if (hovered?.path === file.name && hovered.id) next.add(hovered.id);
    return JSON.stringify([...next].sort()) !== expansionKey;
  });

  const change = useStableCallback((id: string | undefined) => {
    if ((hovered?.path === file.name ? hovered.id : undefined) === id) return;
    const next = revealedDeletions(folds, near, reveal);
    if (id) next.add(id);
    if (JSON.stringify([...next].sort()) !== expansionKey) beforeChange();
    setHovered({ path: file.name, id });
  });

  const onRender = useStableCallback((node: HTMLElement, phase: "mount" | "update" | "unmount") => {
    const root = node.shadowRoot;
    if (hover.current && (phase === "unmount" || !enabled || root !== hover.current.root || file.name !== hover.current.path)) {
      hover.current.cleanup();
      hover.current = undefined;
    }
    if (root && enabled && phase !== "unmount" && !hover.current) hover.current = { root, path: file.name, cleanup: installDeletionHover(root, change) };
  });

  useEffect(() => () => hover.current?.cleanup(), []);
  useEffect(() => { setHovered(undefined); }, [file, enabled]);
  return { resolve, onRender, changesForSelection };
}
