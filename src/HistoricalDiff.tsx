import { useMemo, useRef, useState } from "react";
import { FileDiff } from "@pierre/diffs/react";
import type { SinceReview } from "../shared/sinceReview";
import type { ReviewLine } from "../shared/types";
import { useResource } from "./api";
import { ActivityStatus } from "./ActivityStatus";
import { ModalHeader } from "./ModalHeader";
import { parseInput } from "./patches";
import { closestChangeLine, lineLocation } from "./navigation";
import { groupHunkHistory, type HunkHistory, type HunkHistoryGroup } from "../shared/hunkHistory";
import { renderHunkTexts } from "../shared/hunkText";
import { diffHighlightOptions } from "./diffHighlights";
import { findDiffLine } from "./diffViewport";

/** Show the old PR hunks explicitly, without assigning ancestors to today's hunks. */
export function HistoricalDiff(props: { endpoint: string; path: string; oldPath?: string; location?: ReviewLine; currentBase?: string; onSelectHunk(line: ReviewLine): void; onClose(): void }) {
  const history = useResource<SinceReview & HunkHistory>(`${props.endpoint}/historical?path=${encodeURIComponent(props.path)}`);
  const groups = useMemo(() => groupHunkHistory(history.data?.observations ?? []), [history.data?.observations]);
  const nearest = groups.reduce((best, group, index) => {
    const line = props.location?.line ?? 1;
    const distance = Math.abs(line - Math.max(group.start, Math.min(line, group.end)));
    const previous = groups[best];
    return !previous || distance < Math.abs(line - Math.max(previous.start, Math.min(line, previous.end))) ? index : best;
  }, 0);
  const review = history.data?.review;

  return <aside className="frozen-diff historical-diff" aria-label="Historical diff" data-modal-scope onKeyDown={(event) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); props.onClose(); }
  }}>
    <ModalHeader title={`Historical · ${props.path}`} closeLabel="Close historical diff" onClose={props.onClose} />
    <ActivityStatus label="Load historical hunks" loading={history.loading} error={history.error ?? history.data?.backfillError} retry={history.refresh} />
    {Boolean(history.data?.missing) && <p className="historical-summary">Some older hunk text is unavailable.</p>}
    {!history.loading && !history.error && !review && <p className="historical-summary">History unavailable: your latest submitted review has no retained comparison evidence.</p>}
    {review && !history.loading && !groups.length && !history.data?.missing && <p className="historical-summary">No historical hunks: the hunks from your submitted review are still current, or this file was not in that review.</p>}
    <div className="historical-reading" role="complementary" aria-label="Historical hunks" tabIndex={0}>
      {groups.map((group, index) => <HistoricalGroup key={index} group={group} index={index} path={props.path} location={index === nearest ? props.location : undefined} initial={index === nearest} currentBase={props.currentBase} onSelectHunk={props.onSelectHunk} />)}
    </div>
  </aside>;
}

/** Keep each region's version selection independent within the shared reading pane. */
function HistoricalGroup(props: { group: HunkHistoryGroup; index: number; path: string; location?: ReviewLine; initial: boolean; currentBase?: string; onSelectHunk(line: ReviewLine): void }) {
  const [selected, setSelected] = useState<number>();
  const positioned = useRef(false);
  const page = Math.min(selected ?? props.group.versions.length - 1, props.group.versions.length - 1);
  const version = props.group.versions[page];
  const parsed = useMemo(() => {
    try { return { file: parseInput(renderHunkTexts(props.path, version.hunks), true)[0] }; }
    catch (cause) { return { error: (cause as Error).message }; }
  }, [version, props.path]);
  const file = parsed.file;
  const location = file && closestChangeLine(file, props.location ?? { path: props.path, line: props.group.start, side: "RIGHT" });

  return <section aria-label={`Group ${props.index + 1}`} className="historical-group">
    <div className="historical-navigation">
      <span className="historical-group-title">Group {props.index + 1}</span>
      <div className="historical-versions">
        <button aria-label="Previous historical version" disabled={page === 0} onClick={() => setSelected(page - 1)}>←</button>
        <span aria-label="Historical version" title={version.observedAt ? `Observed ${version.observedAt}` : "Observation time unavailable"}>{page + 1} / {props.group.versions.length}</span>
        <button aria-label="Next historical version" disabled={page === props.group.versions.length - 1} onClick={() => setSelected(page + 1)}>→</button>
      </div>
    </div>
    {props.currentBase !== version.base && <p className="historical-summary">The base branch changed. These old hunks may include differences caused by the base update.</p>}
    {parsed.error && <p className="historical-summary">{parsed.error}</p>}
    {file && <div onClick={(event) => {
      if (window.getSelection()?.isCollapsed === false) return;
      const origin = event.nativeEvent.composedPath()[0];
      const row = origin instanceof Element ? origin.closest<HTMLElement>("[data-line-index]") : null;
      const line = row && lineLocation(file, Number(row.dataset.lineIndex!.split(",")[0]));
      if (line) props.onSelectHunk(line);
    }}><FileDiff fileDiff={file} options={{
      ...diffHighlightOptions, themeType: "dark", diffStyle: "unified", diffIndicators: "bars", overflow: "wrap", disableFileHeader: true, hunkSeparators: "line-info",
      unsafeCSS: "[data-biff-pinned] { outline: 1px solid #b4b8ff; outline-offset: -1px; box-shadow: inset 3px 0 #b4b8ff; }",
      onPostRender: (node, _instance, phase) => {
        if (phase === "unmount" || !props.initial || !location) return;
        const row = findDiffLine(node.shadowRoot, file, location);
        row?.setAttribute("data-biff-pinned", "");
        if (!row || positioned.current) return;
        positioned.current = true;
        // Only opening the pane moves its scroll; paging a group keeps the reader in place.
        queueMicrotask(() => {
          const viewport = node.closest(".historical-reading");
          if (viewport && row.isConnected) viewport.scrollTop += row.getBoundingClientRect().top - viewport.getBoundingClientRect().top - 40;
        });
      },
    }} /></div>}
  </section>;
}
