import { FileDiff, VirtualizerContext } from "@pierre/diffs/react";
import type { FileDiffMetadata, FileDiffOptions, VirtualFileMetrics, Virtualizer } from "@pierre/diffs";
import { diffHighlightOptions } from "./diffHighlights";

interface DiffSurfaceProps {
  file: FileDiffMetadata;
  virtualizer: Virtualizer;
  metrics: VirtualFileMetrics;
  options: FileDiffOptions<undefined, undefined>;
}

/** Render the same prepared diff and token options in the main and frozen reading windows. */
export function DiffSurface(props: DiffSurfaceProps) {
  return <VirtualizerContext.Provider value={props.virtualizer}>
    <FileDiff fileDiff={props.file} metrics={props.metrics} options={{
      ...diffHighlightOptions,
      themeType: "dark",
      diffStyle: "unified",
      diffIndicators: "bars",
      overflow: "wrap",
      disableFileHeader: true,
      hunkSeparators: "line-info",
      ...props.options,
    }} />
  </VirtualizerContext.Provider>;
}
