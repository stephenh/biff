import type { FileDiffMetadata } from "@pierre/diffs";

/**
 * Paint a hairline between adjacent semantic blocks without changing row heights.
 *
 * Native change blocks have context between them; only semantic splits produce
 * adjacent one-sided blocks. Source coordinates survive full-source hydration.
 */
export function semanticDividerCSS(file: FileDiffMetadata): string {
  const selectors: string[] = [];
  for (const hunk of file.hunks) {
    let oldLine = hunk.deletionStart;
    let newLine = hunk.additionStart;
    let previousSide: string | undefined;
    for (const content of hunk.hunkContent) {
      if (content.type === "context") {
        oldLine += content.lines;
        newLine += content.lines;
        previousSide = undefined;
        continue;
      }
      const side = content.deletions === 0 ? "addition" : content.additions === 0 ? "deletion" : undefined;
      if (side && side === previousSide) {
        selectors.push(`[data-line="${side === "addition" ? newLine : oldLine}"][data-line-type="change-${side}"]`);
      }
      previousSide = side;
      oldLine += content.deletions;
      newLine += content.additions;
    }
  }
  // A background layer leaves review/focus shadows and the renderer's row metrics intact.
  return selectors.length ? `${selectors.join(",")} { background-image: linear-gradient(to bottom, #80808055 1px, transparent 1px); }` : "";
}
