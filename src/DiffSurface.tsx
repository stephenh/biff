import { FileDiff, VirtualizerContext } from "@pierre/diffs/react";
import type { FileDiffLoadedFiles, FileDiffMetadata, FileDiffOptions, VirtualFileMetrics, Virtualizer } from "@pierre/diffs";
import { diffHighlightOptions } from "./diffHighlights";
import { fullSourceDiff } from "./fullSourceDiff";
import { useDiffTextSelection } from "./useDiffTextSelection";
import { useStableCallback } from "./useStableCallback";

interface DiffSurfaceProps {
  file: FileDiffMetadata;
  contents?: FileDiffLoadedFiles;
  virtualizer: Virtualizer;
  metrics: VirtualFileMetrics;
  options: FileDiffOptions<undefined, undefined>;
}

/** Render the same prepared diff and token options in the main and frozen reading windows. */
export function DiffSurface(props: DiffSurfaceProps) {
  const selection = useDiffTextSelection();
  const onRender = useStableCallback<Parameters<NonNullable<FileDiffOptions<undefined, undefined>["onPostRender"]>>, void>((node, instance, phase) => {
    selection.onRender(node, instance, phase);
    props.options.onPostRender?.(node, instance, phase);
  });
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
      onPostRender: onRender,
    }} />
    {selection.status}
  </VirtualizerContext.Provider>;
}
