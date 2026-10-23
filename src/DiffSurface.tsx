import { FileDiff, VirtualizerContext } from "@pierre/diffs/react";
import type { FileDiffLoadedFiles, FileDiffMetadata, FileDiffOptions, VirtualFileMetrics, Virtualizer } from "@pierre/diffs";
import { diffHighlightOptions } from "./diffHighlights";
import { fullSourceDiff } from "./fullSourceDiff";

interface DiffSurfaceProps {
  file: FileDiffMetadata;
  contents?: FileDiffLoadedFiles;
  virtualizer: Virtualizer;
  metrics: VirtualFileMetrics;
  options: FileDiffOptions<undefined, undefined>;
}

/** Render the same prepared diff and token options in the main and frozen reading windows. */
export function DiffSurface(props: DiffSurfaceProps) {
  return <VirtualizerContext.Provider value={props.virtualizer}>
    <FileDiff fileDiff={fullSourceDiff(props.file, props.contents)} metrics={props.metrics} options={{
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
