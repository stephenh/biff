import type { FileDiffMetadata, VirtualizedFileDiff, Virtualizer } from "@pierre/diffs";
import type { ReviewLine } from "../shared/types";
import { lineLocation } from "./navigation";

/** Source coordinates survive native context hydration; unified renderer indexes do not. */
export function findDiffLine(root: ShadowRoot | null | undefined, file: FileDiffMetadata, location: ReviewLine): HTMLElement | undefined {
  return Array.from(root?.querySelectorAll<HTMLElement>("[data-line]") ?? []).find((row) => {
    const candidate = lineLocation(file, Number(row.dataset.lineIndex!.split(",")[0]));
    return candidate?.line === location.line && candidate.side === location.side;
  });
}

/** Ask Pierre to mount a source coordinate before correcting its measured screen position. */
export function revealDiffLine(instance: VirtualizedFileDiff, virtualizer: Virtualizer, location: ReviewLine, offset: number): boolean {
  const bounds = instance.getLinePosition(location.line, location.side === "LEFT" ? "deletions" : "additions");
  if (!bounds) return false;
  virtualizer.markDOMDirty();
  virtualizer.scrollTo({ top: (instance.top ?? 0) + bounds.top + bounds.height / 2 - offset, behavior: "instant" });
  return true;
}
