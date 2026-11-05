import type { FileDiffMetadata, FileDiffOptions } from "@pierre/diffs";
import type { ReviewLine } from "../shared/types";
import { findDiffLine } from "./diffViewport";

/** Supply navigation intent; Pierre owns mounting and atomic scroll correction. */
export function readLineAnchor(root: ShadowRoot | null | undefined, file: FileDiffMetadata, location: ReviewLine | undefined): ReturnType<NonNullable<FileDiffOptions<undefined, undefined>["getLayoutAnchor"]>> {
  const line = location && findDiffLine(root, file, location);
  const viewport = root?.host.closest<HTMLElement>(".viewport");
  if (!line || !viewport || !location) return;
  return { line: location.line, side: location.side === "LEFT" ? "deletions" : "additions", offset: line.getBoundingClientRect().top - viewport.getBoundingClientRect().top };
}

/**
 * Keep selection still while Biff synchronously changes comment-preview heights.
 *
 * Unlike fold projection, these decorations are applied outside Pierre's render.
 * Row identity is safe here: no source hydration occurs between capture and restore.
 */
export function captureLineAnchor(root: ShadowRoot | null | undefined): (() => boolean) | undefined {
  const line = root?.querySelector<HTMLElement>("[data-biff-focused], [data-biff-pinned]");
  const viewport = root?.host.closest<HTMLElement>(".viewport");
  const identity = line?.dataset.lineIndex;
  if (!line || !viewport || !identity) return;
  const top = line.getBoundingClientRect().top;

  return function restore() {
    const current = root?.querySelector<HTMLElement>(`[data-line][data-line-index="${identity}"]`);
    if (!current) return false;
    viewport.scrollTo({ top: viewport.scrollTop + current.getBoundingClientRect().top - top, behavior: "instant" });
    return true;
  };
}
