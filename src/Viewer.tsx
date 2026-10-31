import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { matchesShortcut, registerShortcuts } from "./shortcuts";
import { ModalHeader } from "./ModalHeader";
import { prepareCommentAnchor } from "./commentOverlayStyle";
import { viewerShortcuts, progressShortcuts } from "./shortcutDefinitions";
import { parseInput } from "./patches";
import { groupFiles } from "./fileOrder";
import { VirtualizedFileDiff } from "@pierre/diffs";
import type { FileDiffContentsLoader, FileDiffLoadedFiles, FileDiffMetadata, FileDiffOptions } from "@pierre/diffs";
import "./style.css";
import { collapseDeletions, isCollapsedDeletion, updateDeletionVisibility } from "./collapseDeletions";
import { installClickSelection } from "./clickSelection";
import { captureLineAnchor } from "./lineAnchor";
import { changeStarts, closestDiffLine, lineLocation, nextHunk, type CodeLocation, type HunkPosition } from "./navigation";
import type { FileViewedState, ReviewLine } from "../shared/types";
import { syncLineComments, type CommentSelection, type LineThread } from "./lineComments";
import { LineThreadPicker } from "./LineThreadPicker";
import { CollapseDeletedContext } from "./Settings";
import { FileRail } from "./FileRail";
import { prepareFileSlide, type FileSlide } from "./fileSlide";
import { highlightMovedLines } from "./movedLines";
import { semanticDividerCSS } from "./semanticDividers";
import { createSmoothScroll, type SmoothScroll } from "./smoothScroll";
import { useStableCallback } from "./useStableCallback";
import { foldedImportAt, firstNonImportChange, importGroups, importGroupId } from "./importFolds";
import { importSourceMayHelp } from "./importGroups";
import { useChangeProgress } from "./useChangeProgress";
import { useReconciliation } from "./useReconciliation";
import { isImportOnly, type ChangeBlock } from "./changeProgress";
import { SearchOverlay } from "./SearchOverlay";
import { FilePicker } from "./FilePicker";
import { FileSearch } from "./FileSearch";
import { paintFileSearch, type FileSearchMatch } from "./fileSearchMatches";
import type { SearchLine } from "./search";
import { useFollowUps } from "./useFollowUps";
import { followUpKey, type FollowUp } from "../shared/followUps";
import { fileReviewed, isAutoReviewedFile, matchesChange } from "../shared/progress";
import { BackgroundSaveStatus } from "./BackgroundSaveStatus";
import { ActivityScope, ActivityStatus } from "./ActivityStatus";
import { ReviewProgress, ReviewProgressTarget } from "./ReviewProgress";
import { FileComments } from "./FileComments";
import { useThreadResolutions } from "./useThreadResolutions";
import { useBrowserLocation } from "wouter/use-browser-location";
import { fileRouteNames, reviewFileRoute } from "./fileRoute";
import { inheritDiffTracking, measureFileTiming, recordFileTiming } from "./diffMetrics";
import { DiffSurface } from "./DiffSurface";
import { DiffPanes } from "./DiffPanes";
import { FrozenDiff, type FrozenLocation } from "./FrozenDiff";
import { useDiffVirtualizer } from "./useDiffVirtualizer";
import { findDiffLine, revealDiffLine } from "./diffViewport";
import { canLoadDiffSource, fullSourceDiff } from "./fullSourceDiff";
import { readReviewPosition, saveReviewPosition } from "./reviewPosition";

/** Review pages host Find in their source toolbar; standalone viewers keep it in the diff toolbar. */
export const SearchControlTarget = createContext<HTMLElement | null>(null);

export interface ViewerProps {
  progressEndpoint?: string;
  progressHead?: string;
  reconciliation?: boolean;
  comparisonBase?: string;
  reviewStateReady?: boolean;
  /** Backend reviews already hide whitespace; only raw imports need filtering. */
  whitespaceHidden?: boolean;
  patch: string;
  source?: string;
  allowImport?: boolean;
  onSelectLine?: (line: ReviewLine | undefined) => void;
  focus?: CodeLocation & { request: number };
  viewedFiles?: Record<string, FileViewedState>;
  loadDiffFiles?: FileDiffContentsLoader;
  inlineThreads?: LineThread[];
  /** Include outdated threads here without reattaching their coordinates to the current diff. */
  commentThreads?: LineThread[];
  /** The review owns mutations; file comments hosts its active thread inside the existing dialog. */
  commentContent?: ReactNode;
  activeCommentId?: string;
  onResolveComment?: (id: string, resolved: boolean, keys?: string[], complete?: boolean) => Promise<void>;
  onReadComment?: (thread: LineThread) => void;
  onOpenComments?: (selection: CommentSelection) => void;
  onOpenFollowUpThread?: (id: string) => void;
  followUpThreadsReady?: boolean;
}

/**
 * Show an inline diff with full-size code and collapsible deleted blocks.
 *
 * Patch parsing stays local to the browser.
 */
export function Viewer(props: ViewerProps) {
  const searchControlTarget = useContext(SearchControlTarget);
  const reviewProgressTarget = useContext(ReviewProgressTarget);
  const [entries, setEntries] = useState(() => groupFiles(parseInput(props.patch, props.whitespaceHidden, props.source ?? props.progressEndpoint ?? "Imported patch")));
  const files = useMemo(() => entries.map((entry) => entry.file), [entries]);
  const routeNames = useMemo(() => fileRouteNames(files), [files]);
  // useLocation decodes escapes too early for filenames containing literal percent escapes.
  const [pathname, navigate] = useBrowserLocation();
  const initialRoute = useRef(reviewFileRoute(pathname));
  const initialSearch = useRef(window.location.search);
  const previousPathname = useRef(pathname);
  const followUps = useFollowUps(props.progressEndpoint);
  const [followUpsOpen, setFollowUpsOpen] = useState(false);
  const [selectedFollowUp, setSelectedFollowUp] = useState("");
  const initialFollowUp = useRef(false);
  const initialReviewSelection = useRef(false);
  const [position, setPosition] = useState<HunkPosition>(() => ({ fileIndex: Math.max(0, routeNames.indexOf(initialRoute.current?.file ?? "")), hunkIndex: 0 }));
  const positionScope = initialRoute.current ? `${initialRoute.current.base}${initialSearch.current}` : undefined;
  const [restoredLine] = useState(() => readReviewPosition(positionScope, initialRoute.current?.file === undefined ? undefined : files[position.fileIndex]?.name));
  const index = position.fileIndex;
  const reconciliation = useReconciliation(props.reconciliation ? props.progressEndpoint : undefined, props.progressHead, props.comparisonBase ?? null, files[index]?.name ?? "");
  const progress = useChangeProgress(files, props.progressEndpoint, props.progressHead, props.reconciliation ? reconciliation.status?.files ?? {} : undefined);
  const [source, setSource] = useState(props.source ?? "Example changes");
  const collapseOld = useContext(CollapseDeletedContext);
  const previousCollapse = useRef(collapseOld);
  const [frozen, setFrozen] = useState<FrozenLocation>();
  const [nearbyOpen, setNearbyOpen] = useState(false);
  const [deletionPeek, setDeletionPeek] = useState(false);
  const [unmodifiedOpen, setUnmodifiedOpen] = useState(false);
  const [unmodifiedPeek, setUnmodifiedPeek] = useState(false);
  const unmodifiedPress = useRef(false);
  const pendingContextRender = useRef(false);
  const deletionPress = useRef(false);
  const deletionAnchor = useRef<(() => void) | undefined>(undefined);
  const [error, setError] = useState("");
  const [pasteOpen, setPasteOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [filePickerOpen, setFilePickerOpen] = useState(false);
  const [fileCommentsOpen, setFileCommentsOpen] = useState(false);
  const [lineThreadPicker, setLineThreadPicker] = useState<CommentSelection>();
  const [searchQuery, setSearchQuery] = useState("");
  const [searchSelection, setSearchSelection] = useState<string>();
  const [fileSearch, setFileSearch] = useState<{ file: FileDiffMetadata; query: string; request: number }>();
  const [patch, setPatch] = useState("");
  const { viewport, virtualizer, diffInstance, attachViewport, virtualMetrics } = useDiffVirtualizer(() => {
    if (!pendingScroll.current && !openAtFileStart.current && renderedFile.current === file) {
      // Resizing may replace the mounted window. Keep the latest navigation
      // intent, rather than reviving a row selected before the last keypress.
      focusRequest.current ??= lineLocation(activeDiff.current, position.lineIndex ?? hunks[position.hunkIndex]);
      pendingScroll.current = true;
    }
  });
  const stage = useRef<HTMLDivElement>(null);
  const fileSlide = useRef<{ file: typeof files[number]; slide: FileSlide } | undefined>(undefined);
  const focusRequest = useRef<ReviewLine | undefined>(undefined);
  const upload = useRef<HTMLInputElement>(null);
  const pendingScroll = useRef(true);
  const openAtFileStart = useRef(true);
  const navigationVersion = useRef(0);
  const file = files[index];
  // Readiness includes waits for source/progress, but not the review API request or patch parsing.
  const fileTiming = useRef({ file, started: performance.now(), finished: false });
  const filePaintFrame = useRef<number | undefined>(undefined);
  if (fileTiming.current.file !== file) fileTiming.current = { file, started: performance.now(), finished: false };
  const fileSearchOpen = fileSearch?.file === file;
  const fileSearchQuery = fileSearchOpen ? fileSearch.query : "";
  const sourceThreads = props.commentThreads ?? props.inlineThreads ?? [];
  const resolutionScope = `thread-resolution:${props.progressEndpoint ?? source}`;
  const resolutions = useThreadResolutions(resolutionScope, sourceThreads, props.onResolveComment);
  const commentThreads = resolutions.threads;
  const unreadThreadsByFile = useMemo(() => Object.fromEntries(files.map((entry) => [entry.name,
    commentThreads.filter((thread) => (thread.unreadCount ?? 0) > 0 && (thread.location.path === entry.name || thread.location.path === entry.prevName)).length,
  ])), [files, commentThreads]);
  const unresolvedThreads = commentThreads.filter((thread) => !thread.resolved);
  const fileThreadCount = unresolvedThreads.filter((thread) => thread.location.path === file.name || thread.location.path === file.prevName).length;
  const reviewThreadCount = unresolvedThreads.length;

  const resolveComment = resolutions.resolve;
  const lastScrolledFile = useRef<typeof file | null>(null);
  const scrolling = useRef<SmoothScroll | undefined>(undefined);
  const scrollHeight = useRef<number | undefined>(undefined);
  const resizeRemainder = useRef(0);
  const followLine = useRef(false);
  const sourceRequests = useRef(new WeakMap<FileDiffMetadata, Promise<FileDiffLoadedFiles>>());
  const sourceContents = useRef(new WeakMap<FileDiffMetadata, FileDiffLoadedFiles>());
  const sourceFailures = useRef(new WeakSet<FileDiffMetadata>());
  const [sourceVersion, setSourceVersion] = useState(0);
  const [sourceLoads, setSourceLoads] = useState(0);
  const [expandedImports, setExpandedImports] = useState<Map<string, Set<string>>>(new Map());
  const expanded = useMemo(() => expandedImports.get(file.name) ?? new Set<string>(), [expandedImports, file.name]);
  const activeDiff = useRef(file);
  const renderedFile = useRef<FileDiffMetadata | null>(null);
  const preparedFile = useRef<FileDiffMetadata | null>(null);
  const needsImportSource = useMemo(() => Boolean(props.loadDiffFiles) && importSourceMayHelp(file), [file, Boolean(props.loadDiffFiles)]);
  const hunks = changeStarts(file);
  // Navigation prefers additions, so a stop on the old side identifies a deletion-only block.
  const deletionOnlyLine = lineLocation(file, hunks[position.hunkIndex])?.side === "LEFT" ? hunks[position.hunkIndex] : undefined;
  const currentBlock = progress.blocks.find((block) => block.fileIndex === index && block.hunkIndex === position.hunkIndex);
  const fileImportGroups = importGroups(file, sourceContents.current.get(file));
  const reviewableBlocks = useMemo(() => {
    const groups = files.map((entry) => importGroups(entry, sourceContents.current.get(entry)));
    return progress.blocks.filter((block) => !isAutoReviewedFile(block.path) && !isImportOnly(block, groups[block.fileIndex]));
  }, [files, progress.blocks, sourceVersion]);
  const fileBlocks = reviewableBlocks.filter((block) => block.fileIndex === index);
  const reviewedBlockCount = fileBlocks.filter(progress.reviewed).length;
  const totalReviewedBlocks = reviewableBlocks.filter(progress.reviewed).length;
  const fileHunkProgress = useMemo(() => {
    const counts = files.map(() => ({ reviewed: 0, total: 0 }));
    for (const block of reviewableBlocks) {
      counts[block.fileIndex].total++;
      if (progress.reviewed(block)) counts[block.fileIndex].reviewed++;
    }
    return counts;
  }, [files, reviewableBlocks, progress.reviewed]);
  const followUpTargets = followUps.items.flatMap<{ item: FollowUp; fileIndex: number; line: number }>((item) => {
    if (item.type === "hunk") {
      const block = progress.blocks.find((entry) => matchesChange(item, entry));
      return block ? [{ item, block, fileIndex: block.fileIndex, line: lineLocation(files[block.fileIndex], block.selected)?.line ?? block.newLine }] : [];
    }
    const fileIndex = files.findIndex((entry) => entry.name === item.location.path || entry.prevName === item.location.path);
    return [{ item, block: undefined, fileIndex: fileIndex < 0 ? files.length : fileIndex, line: item.location.line }];
  }).sort((a, b) => a.fileIndex - b.fileIndex || a.line - b.line || followUpKey(a.item).localeCompare(followUpKey(b.item)));
  const followUpIndex = followUpTargets.findIndex((target) => followUpKey(target.item) === selectedFollowUp);
  // Cursor movement must not reclassify every file in a large review.
  const reviewedFiles = useMemo<Record<string, FileViewedState>>(() => props.progressEndpoint ? Object.fromEntries(files.map((entry, fileIndex) => [entry.name, isFileReviewed(fileIndex) ? "VIEWED" : "UNVIEWED"])) : props.viewedFiles ?? {}, [files, index, sourceVersion, progress.blocks, progress.metadata, progress.reviewed, props.progressEndpoint, props.viewedFiles]);
  const reviewedFileCount = files.filter((entry) => reviewedFiles[entry.name] === "VIEWED").length;
  const dividerCSS = useMemo(() => semanticDividerCSS(file), [file]);
  const reviewedCSS = useMemo(() => {
    const rules: string[] = [];
    for (const block of progress.blocks.filter((entry) => entry.fileIndex === index && progress.reviewed(entry))) {
      // Source line numbers remain stable when Pierre hydrates omitted context.
      for (let row = block.start; row <= block.end; row++) {
        const location = lineLocation(file, row);
        if (location) rules.push(`[data-line="${location.line}"][data-line-type="change-${location.side === "LEFT" ? "deletion" : "addition"}"]`);
      }
    }
    return rules.length ? `${rules.join(",")} { box-shadow: inset -4px 0 #6caa87; opacity: .58; }` : "";
  }, [progress.blocks, progress.reviewed, index, file]);
  const sourceReady = reconciliation.ready && props.reviewStateReady !== false && (!needsImportSource || sourceContents.current.has(file) || !props.reconciliation && sourceFailures.current.has(file)) && (!props.progressEndpoint || progress.ready || !props.reconciliation && Boolean(progress.error));
  const finishRender = useStableCallback(() => {
    scrollToHunk();
    finishImportPreparation();
  });
  // Pierre treats changed callback identities as option changes, which would rebuild rows on cursor movement.
  const onDiffTiming = useMemo<NonNullable<FileDiffOptions<undefined, undefined>["onDiffTiming"]>>(() => (timing) => recordFileTiming(file, timing), [file]);
  const resolveFoldedRanges = useMemo<NonNullable<FileDiffOptions<undefined, undefined>["resolveFoldedRanges"]>>(() => (diff) => {
    inheritDiffTracking(file, diff);
    const definitions = importGroups(diff, sourceContents.current.get(file));
    return definitions.map((group) => {
      const count = (props.inlineThreads ?? []).filter((thread) => (thread.location.path === diff.name || thread.location.path === diff.prevName) && group.keys.includes(`${thread.location.side}:${thread.location.line}`)).length;
      return { id: importGroupId(group), start: group.start, end: group.end, label: `${group.changes} Import ${group.changes === 1 ? "change" : "changes"}${count ? ` · ${count} ${count === 1 ? "thread" : "threads"}` : ""}`, expanded: group.keys.some((key) => expanded.has(key)), includeLeadingContext: group.leading };
    });
  }, [file, sourceContents.current.get(file), expanded, props.inlineThreads]);
  const onRender = useStableCallback<Parameters<NonNullable<FileDiffOptions<undefined, undefined>["onPostRender"]>>, void>((node, instance, phase) => {
    if (phase === "unmount") collapseDeletions(node, false);
    if (phase !== "unmount") {
      const started = performance.now();
      renderedFile.current = file;
      activeDiff.current = instance.fileDiff ?? file;
      pendingContextRender.current = false;
      if (instance instanceof VirtualizedFileDiff) diffInstance.current = instance;
      inheritDiffTracking(file, activeDiff.current);
      syncReviewedStyle(node);
      measureFileTiming(file, "moved-line markers", () => highlightMovedLines(node, file));
      measureFileTiming(file, "deletion grouping", () => collapseDeletions(node, collapseOld));
      measureFileTiming(file, "deletion visibility", () => syncDeletionVisibility(node));
      const restoreAnchor = deletionAnchor.current;
      deletionAnchor.current = undefined;
      measureFileTiming(file, "comment markers", () => syncLineComments(node, file, props.inlineThreads ?? [], props.onOpenComments ? openLineComments : undefined));
      measureFileTiming(file, "search painting", () => paintFileSearch(node, fileSearchQuery));
      // Pierre restores its scroll anchor after onPostRender. Reveal only after
      // that pass, or its old anchor would undo an offscreen navigation target.
      const rendered = file;
      queueMicrotask(() => {
        if (!node.isConnected || renderedFile.current !== rendered) return;
        if (restoreAnchor) measureFileTiming(rendered, "scroll anchor restoration", restoreAnchor);
        // A cursor remap can commit before this microtask; use its latest position.
        finishRender();
      });
      recordFileTiming(file, { phase: "DOM post-processing", durationMs: performance.now() - started, pass: phase });
      recordFileTiming(file, { phase: "mounted source rows", durationMs: 0, lines: node.shadowRoot?.querySelectorAll("[data-content] > [data-line]").length ?? 0 });
    }
  });
  const loadDiffContents = useStableCallback(loadContext);
  const loadSearchContents = useStableCallback(fetchContents);

  useLayoutEffect(() => {
    // Seed the source request before the first rendered row can overwrite the saved cursor.
    if (restoredLine && !props.focus) goToCode(restoredLine);
  }, []);

  useEffect(() => () => { if (filePaintFrame.current !== undefined) cancelAnimationFrame(filePaintFrame.current); }, []);

  useLayoutEffect(() => {
    const container = viewport.current?.querySelector<HTMLElement>("diffs-container");
    if (container) paintFileSearch(container, fileSearchQuery);
  }, [file, fileSearchQuery]);

  useEffect(() => () => { CSS.highlights.delete("biff-file-search"); }, []);

  useLayoutEffect(() => {
    const container = viewport.current?.querySelector<HTMLElement>("diffs-container");
    if (container) syncReviewedStyle(container);
  }, [reviewedCSS, followUps.items, file]);

  /** Include layout-effect updates as well as the renderer's post-processing callback. */
  function syncReviewedStyle(container: HTMLElement) {
    measureFileTiming(file, "review and follow-up markers", () => updateReviewedStyle(container));
  }

  /** Progress only changes paint; keep it out of Pierre's options to avoid rebuilding rows mid-scroll. */
  function updateReviewedStyle(container: HTMLElement) {
    const root = container.shadowRoot;
    if (!root) return;
    let style = root.querySelector<HTMLStyleElement>("[data-reviewed-style]");
    if (!style) { style = document.createElement("style"); style.dataset.reviewedStyle = ""; root.append(style); }
    if (style.textContent !== reviewedCSS) style.textContent = reviewedCSS;
    root.querySelectorAll("[data-follow-up-hunk]").forEach((marker) => marker.remove());
    const flaggedLines = new Set<string>();
    for (const block of progress.blocks.filter((entry) => entry.fileIndex === index && followUps.hasHunk(entry))) {
      // Source coordinates keep every changed row flagged after context expansion.
      for (let row = block.start; row <= block.end; row++) {
        const location = lineLocation(file, row);
        if (location) flaggedLines.add(`change-${location.side === "LEFT" ? "deletion" : "addition"}:${location.line}`);
      }
    }
    for (const gutter of root.querySelectorAll<HTMLElement>("[data-gutter] > [data-line-index]")) {
      if (!flaggedLines.has(`${gutter.dataset.lineType}:${gutter.dataset.columnNumber}`)) continue;
      gutter.style.position = "relative";
      const marker = document.createElement("span");
      marker.dataset.followUpHunk = "";
      marker.textContent = "!";
      marker.title = "Follow-up hunk";
      marker.setAttribute("aria-label", "Follow-up hunk");
      marker.style.cssText = "position:absolute;right:1px;top:50%;transform:translateY(-50%);color:#f0c77a;font-weight:800;pointer-events:none";
      gutter.append(marker);
    }
  }

  useEffect(() => {
    if (!props.loadDiffFiles || (!needsImportSource && !canLoadDiffSource(file))) return;
    if (sourceContents.current.has(file)) return;
    let active = true;
    const started = performance.now();
    // Full source also supplies syntax state before hunks that start inside a
    // template literal or comment. Only import classification holds the initial pane.
    void fetchContents(file).then(() => {
      if (active) {
        recordFileTiming(file, { phase: "full-source notification", durationMs: performance.now() - started, outcome: "loaded" });
      }
    }, () => {
      if (active) { sourceFailures.current.add(file); setSourceVersion((version) => version + 1); }
    });
    return () => { active = false; };
  }, [file, needsImportSource, Boolean(props.loadDiffFiles)]);

  useEffect(() => {
    if (!props.loadDiffFiles) return;
    let stopped = false;
    // The visible file already has a foreground request. Warm the remaining
    // candidates in reading order without flooding gh with one request per file.
    const candidates = [...files.slice(index + 1), ...files.slice(0, index)].filter(importSourceMayHelp);
    let cursor = 0;

    /** Share in-flight requests and cache entries with foreground navigation. */
    async function prefetch() {
      while (!stopped && cursor < candidates.length) {
        const candidate = candidates[cursor++];
        try { await fetchContents(candidate); }
        catch { /* A speculative failure stays retryable when the file is opened. */ }
      }
    }

    for (let worker = 0; worker < 3; worker++) void prefetch();
    return () => { stopped = true; };
  }, [files, Boolean(props.loadDiffFiles)]);

  useEffect(() => {
    const route = reviewFileRoute(pathname);
    // A revision change can leave the old viewer mounted until its replacement loads.
    if (!route || route.base !== initialRoute.current?.base || window.location.search !== initialSearch.current) return;

    if (previousPathname.current !== pathname) {
      previousPathname.current = pathname;
      const requested = Math.max(0, routeNames.indexOf(route.file ?? ""));
      if (requested !== index) { selectFile(requested, false); return; }
    }

    const next = `${route.base}/f/${encodeURIComponent(routeNames[index])}`;
    if (next === pathname) return;
    previousPathname.current = next;
    navigate(`${next}${window.location.search}${window.location.hash}`, { replace: true });
  }, [pathname, routeNames, index, navigate]);

  useLayoutEffect(() => {
    if (previousCollapse.current !== collapseOld) anchorDeletions();
    previousCollapse.current = collapseOld;
  }, [collapseOld]);

  useEffect(() => () => fileSlide.current?.slide.cancel(), []);
  useEffect(() => () => scrolling.current?.destroy(), []);

  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    // Opening review controls or loading fonts changes the 50cqh spacer. Keep the code in place.
    const observer = new ResizeObserver(() => {
      const next = element.clientHeight;
      const height = scrollHeight.current;
      if (height !== undefined && lastScrolledFile.current && !pendingScroll.current && next !== height) {
        scrolling.current?.cancel();
        // scrollTop rounds to pixels; retain half-pixels across successive layout changes.
        const target = Math.max(0, Math.min(element.scrollHeight - next, element.scrollTop + (next - height) / 2 + resizeRemainder.current));
        element.scrollTop = target;
        resizeRemainder.current = target - element.scrollTop;
      }
      scrollHeight.current = next;
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  /** Resolve visibility using the actual rendered metadata, including native source hydration. */
  function currentImportGroups() {
    return importGroups(activeDiff.current.name === file.name ? activeDiff.current : file, sourceContents.current.get(file));
  }

  /** Control fold state using stable source coordinates, never renderer row attributes. */
  function setImportExpanded(id: string, open: boolean) {
    const group = currentImportGroups().find((entry) => importGroupId(entry) === id);
    if (!group) return;
    anchorDeletions();
    setExpandedImports((current) => {
      const next = new Map(current);
      const keys = new Set(current.get(file.name));
      for (const key of group.keys) { if (open) keys.add(key); else keys.delete(key); }
      next.set(file.name, keys);
      return next;
    });
  }

  /** Reveal a requested comment coordinate before trying to find its rendered line. */
  function revealImportLocation(location: ReviewLine): boolean {
    const group = currentImportGroups().find((entry) => entry.keys.includes(`${location.side}:${location.line}`) && !entry.keys.some((key) => expanded.has(key)));
    if (!group) return false;
    setImportExpanded(importGroupId(group), true);
    return true;
  }

  /** Reveal only a rendered, classified pane; slow or failed source lookups cannot flash raw imports. */
  function finishImportPreparation() {
    if (!sourceReady || renderedFile.current !== file || pendingScroll.current) return;
    if (!fileTiming.current.finished && fileTiming.current.file === file) {
      fileTiming.current.finished = true;
      recordFileTiming(file, { phase: "file ready latency (inclusive)", durationMs: performance.now() - fileTiming.current.started });
      const timing = fileTiming.current;
      if (filePaintFrame.current !== undefined) cancelAnimationFrame(filePaintFrame.current);
      // Two frames give the browser a paint opportunity without forcing another layout read.
      filePaintFrame.current = requestAnimationFrame(() => {
        if (fileTiming.current !== timing) return;
        filePaintFrame.current = requestAnimationFrame(() => {
          filePaintFrame.current = undefined;
          if (fileTiming.current === timing) recordFileTiming(file, { phase: "file switch to paint opportunity (inclusive)", durationMs: performance.now() - timing.started });
        });
      });
    }
    preparedFile.current = file;
    stage.current?.removeAttribute("data-imports-pending");
    stage.current?.setAttribute("aria-busy", "false");
    if (viewport.current) { viewport.current.inert = false; viewport.current.removeAttribute("aria-hidden"); }
    if (fileSlide.current?.file === file) measureFileTiming(file, "file slide animation setup", () => fileSlide.current!.slide.play());
  }

  /** Share full-source requests between syntax highlighting, import recognition and context expansion. */
  function fetchContents(diff: FileDiffMetadata): Promise<FileDiffLoadedFiles> {
    const existing = sourceRequests.current.get(diff);
    if (existing) return existing;
    const started = performance.now();
    const version = navigationVersion.current;
    setSourceLoads((count) => count + 1);
    const request = Promise.resolve().then(() => props.loadDiffFiles!(diff)).then((contents) => {
      recordFileTiming(diff, { phase: "source fetch", durationMs: performance.now() - started, outcome: "loaded" });
      sourceContents.current.set(diff, contents);
      sourceFailures.current.delete(diff);
      // Prepare classification while this file is still in the background too.
      importGroups(diff, contents);
      if (version === navigationVersion.current && diff === file && fullSourceDiff(diff, contents) !== diff) preserveSourceLocation();
      setSourceVersion((version) => version + 1);
      return contents;
    }, (error: unknown) => { recordFileTiming(diff, { phase: "source fetch", durationMs: performance.now() - started, outcome: "failed" }); sourceRequests.current.delete(diff); throw error; }).finally(() => setSourceLoads((count) => count - 1));
    sourceRequests.current.set(diff, request);
    return request;
  }

  /** Keep a reconciled file's imports complete even if its browser source request failed. */
  async function retrySource() {
    sourceFailures.current.delete(file);
    setSourceVersion((version) => version + 1);
    try { await fetchContents(file); }
    catch { sourceFailures.current.add(file); setSourceVersion((version) => version + 1); }
  }

  /** Change navigation skips folded import stanzas instead of stopping inside them. */
  function moveChange(direction: 1 | -1) {
    if (props.progressEndpoint && progress.ready) { nextUnreviewed(direction); return; }
    let next = nextHunk(files, position, direction);
    if (next.fileIndex === index && foldedImportAt(currentImportGroups(), expanded, hunks[next.hunkIndex])) {
      const target = firstNonImportChange(file, currentImportGroups(), expanded, next.hunkIndex, direction);
      if (target) { navigateTo({ fileIndex: index, hunkIndex: target.hunkIndex, lineIndex: target.index }); return; }
      // Import-only stops at this file's edge must not trap cross-file navigation.
      next = nextHunk(files, { fileIndex: index, hunkIndex: direction === 1 ? hunks.length - 1 : 0 }, direction);
      if (next.fileIndex === index) return;
    }
    navigateTo(next);
  }

  /**
   * Navigate pending blocks, finishing the completed file before moving to later files.
   *
   * Explicit next/previous navigation stays directional and does not wrap.
   */
  function nextUnreviewed(direction: 1 | -1, exclude: ChangeBlock[] = []) {
    const current = progress.blocks.findIndex((block) => block.fileIndex === index && block.hunkIndex === position.hunkIndex);
    const following = direction === 1 ? progress.blocks.slice(current + 1) : progress.blocks.slice(0, Math.max(0, current)).reverse();
    // A completed hunk must not strand earlier pending work in this file.
    const candidates = exclude.length && direction === 1 ? [
      ...following.filter((block) => block.fileIndex === index),
      ...progress.blocks.slice(0, current).filter((block) => block.fileIndex === index),
      ...following.filter((block) => block.fileIndex !== index),
    ] : following;
    for (const block of candidates) {
      if (exclude.includes(block) || progress.reviewed(block)) continue;
      const targetFile = files[block.fileIndex];
      const definitions = importGroups(targetFile, sourceContents.current.get(targetFile));
      if (isImportOnly(block, definitions)) continue;
      const keys = expandedImports.get(targetFile.name) ?? new Set<string>();
      const visible = firstNonImportChange(targetFile, definitions, keys, block.hunkIndex);
      if (!visible || visible.hunkIndex !== block.hunkIndex) continue;
      navigateTo({ fileIndex: block.fileIndex, hunkIndex: block.hunkIndex, lineIndex: visible.index });
      return;
    }
  }

  /** Space previews completion and advances without waiting for persistence. */
  function completeChange(matching = false) {
    if (!currentBlock || !progress.ready || !sourceReady) return;
    if (isImportOnly(currentBlock, fileImportGroups)) { nextUnreviewed(1); return; }
    if (matching) {
      const completed = progress.saveMatching(currentBlock);
      if (completed.length) nextUnreviewed(1, completed);
    } else if (progress.save(currentBlock, true)) nextUnreviewed(1, [currentBlock]);
  }

  /** Flag and complete atomically before advancing; clearing a flag leaves completion alone. */
  async function followUpChange() {
    if (!currentBlock || !props.progressHead || !followUps.ready || followUps.busy || !progress.ready || !sourceReady) return;
    if (isImportOnly(currentBlock, fileImportGroups)) return;
    const enabled = !followUps.hasHunk(currentBlock);
    const version = navigationVersion.current;
    if (await followUps.hunk(currentBlock, props.progressHead, enabled)) {
      progress.retry();
      if (enabled && navigationVersion.current === version) nextUnreviewed(1, [currentBlock]);
    }
  }

  /** Open thread discussions even when their original diff coordinates are now outdated. */
  function openFollowUp(item: FollowUp) {
    setSelectedFollowUp(followUpKey(item));
    setFollowUpsOpen(false);
    if (item.type === "thread") {
      if (props.followUpThreadsReady === false) { setError("Discussion is still loading. Try this follow-up again."); return; }
      if (props.onOpenFollowUpThread) props.onOpenFollowUpThread(item.id);
      else setError("Open this thread from the discussion panel.");
      return;
    }
    const block = progress.blocks.find((entry) => matchesChange(item, entry));
    if (block) {
      navigateTo({ fileIndex: block.fileIndex, hunkIndex: block.hunkIndex, lineIndex: block.selected });
      setSelectedFollowUp(followUpKey(item));
    }
  }

  /** Follow-up traversal wraps across the entire review in file/line order. */
  function moveFollowUp(direction: 1 | -1) {
    if (!followUpTargets.length) return;
    let next = followUpIndex;
    if (next < 0) {
      const line = lineLocation(file, position.lineIndex ?? hunks[position.hunkIndex])?.line ?? 0;
      next = direction === 1
        ? followUpTargets.findIndex((target) => target.fileIndex > index || target.fileIndex === index && target.line > line)
        : followUpTargets.reduce((found, target, candidate) => target.fileIndex < index || target.fileIndex === index && target.line < line ? candidate : found, -1);
      if (next < 0) next = direction === 1 ? 0 : followUpTargets.length - 1;
    } else next = (next + direction + followUpTargets.length) % followUpTargets.length;
    openFollowUp(followUpTargets[next]!.item);
  }

  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get("followUp");
    if (!requested || restoredLine || initialFollowUp.current || !followUps.ready || !progress.ready || props.followUpThreadsReady === false || !followUpTargets.length) return;
    const target = requested === "first" ? followUpTargets[0] : followUpTargets.find((entry) => followUpKey(entry.item) === requested);
    // A retained followUp query must not steal selection from an explicit file URL on reload.
    if (initialRoute.current?.file !== undefined && target?.fileIndex !== index) return;
    if (target) { initialFollowUp.current = true; openFollowUp(target.item); }
  }, [followUps.ready, followUps.items, progress.ready, props.followUpThreadsReady]);

  /** Capture before changing files; finish interrupted movement before the next slide. */
  function slideToFile(fileIndex: number) {
    if (fileIndex === index || !stage.current || !viewport.current) return;
    fileSlide.current?.slide.cancel();
    fileSlide.current = undefined;
    if (preparedFile.current !== file) return;
    const target = files[fileIndex];
    const slide = measureFileTiming(file, "file transition preparation", () => prepareFileSlide(viewport.current!, fileIndex > index ? 1 : -1, (phase, durationMs) => recordFileTiming(target, { phase, durationMs })));
    if (slide) fileSlide.current = { file: files[fileIndex], slide };
  }

  /** Deletion visibility changes preserve the selected line, even when off-center. */
  function anchorDeletions() {
    scrolling.current?.cancel();
    deletionAnchor.current = captureLineAnchor(viewport.current?.querySelector("diffs-container")?.shadowRoot);
    pendingScroll.current = false;
  }

  /** Context expansion can unmount the selected row; reveal its source coordinate after rendering. */
  function anchorUnmodified() {
    scrolling.current?.cancel();
    deletionAnchor.current = undefined;
    focusRequest.current ??= lineLocation(activeDiff.current, position.lineIndex ?? hunks[position.hunkIndex]);
    openAtFileStart.current = false;
    followLine.current = false;
    pendingScroll.current = true;
    pendingContextRender.current = true;
  }

  /** Apply the same reveal rules after renderer updates and cursor movement. */
  function syncDeletionVisibility(container: HTMLElement) {
    updateDeletionVisibility(container, collapseOld, nearbyOpen || deletionPeek ? position.lineIndex ?? hunks[position.hunkIndex] : undefined, deletionOnlyLine);
  }

  /** File selection starts at its first hunk, independently of keyboard navigation. */
  function selectFile(fileIndex: number, animate = true) {
    if (fileIndex !== index) fileTiming.current = { file: files[fileIndex], started: performance.now(), finished: false };
    setSelectedFollowUp("");
    focusRequest.current = undefined;
    openAtFileStart.current = true;
    followLine.current = false;
    scrolling.current?.cancel();
    if (animate) slideToFile(fileIndex);
    navigationVersion.current++;
    resetDeletionVisibility();
    pendingScroll.current = true;
    setPosition({ fileIndex, hunkIndex: 0 });
  }

  /** Search uses source coordinates so folded and hydrated rows remain addressable. */
  function selectSearchResult(fileIndex: number, line?: SearchLine) {
    selectFile(fileIndex);
    if (!line) return;
    focusRequest.current = line;
    openAtFileStart.current = false;
    if (line.side === "LEFT") setNearbyOpen(true);
    if (line.hidden) setUnmodifiedOpen(true);
  }

  /** Seed slash-search from selected code without changing the cross-file query. */
  function openFileSearch() {
    const root = viewport.current?.querySelector("diffs-container")?.shadowRoot;
    const selection = window.getSelection();
    const text = selection?.anchorNode && root?.contains(selection.anchorNode) ? selection.toString().trim() : "";
    setFileSearch({ file, query: text && !text.includes("\n") ? text : fileSearchQuery, request: (fileSearch?.request ?? 0) + 1 });
    setSearchOpen(false);
  }

  /** Reveal a match using source coordinates, preserving this file's existing reveal state. */
  function selectFileSearchResult(match: FileSearchMatch) {
    focusRequest.current = match;
    openAtFileStart.current = false;
    followLine.current = false;
    pendingScroll.current = true;
    navigationVersion.current++;
    if (match.side === "LEFT") setNearbyOpen(true);
    if (match.hidden) setUnmodifiedOpen(true);
    setPosition((current) => ({ ...current }));
  }

  /** Escape clears highlights and returns keyboard reading to the diff. */
  function closeFileSearch() {
    setFileSearch(undefined);
    viewport.current?.focus({ preventScroll: true });
  }

  /** Capture source identity and reveal state without handing review focus to the reference. */
  function freezeLine() {
    const row = viewport.current?.querySelector("diffs-container")?.shadowRoot?.querySelector<HTMLElement>("[data-biff-focused]");
    if (!row) return;
    const lineIndex = Number(row.dataset.lineIndex!.split(",")[0]);
    const location = lineLocation(activeDiff.current, lineIndex);
    if (!location) return;
    const original = lineLocation(file, lineIndex);
    scrolling.current?.cancel();
    setFrozen({ file, location, screenTop: row.getBoundingClientRect().top, expandedImports: new Set(expanded), showDeletions: nearbyOpen || deletionPeek, showUnmodified: unmodifiedOpen || unmodifiedPeek || original?.line !== location.line || original?.side !== location.side, request: (frozen?.request ?? 0) + 1 });
    viewport.current?.focus({ preventScroll: true });
  }

  /** Closing the reference does not change the main file or reading cursor. */
  function closeFrozen() {
    setFrozen(undefined);
    viewport.current?.focus({ preventScroll: true });
  }

  /** Clear per-file reveal state in the same render as the file change. */
  function resetDeletionVisibility() {
    deletionPress.current = false;
    deletionAnchor.current = undefined;
    setNearbyOpen(false);
    setDeletionPeek(false);
    unmodifiedPress.current = false;
    pendingContextRender.current = false;
    setUnmodifiedOpen(false);
    setUnmodifiedPeek(false);
  }

  /** Cross-file navigation starts with that file's normal collapsed view. */
  function navigateTo(next: HunkPosition) {
    focusRequest.current = undefined;
    if (next.fileIndex !== index) fileTiming.current = { file: files[next.fileIndex], started: performance.now(), finished: false };
    setSelectedFollowUp("");
    openAtFileStart.current = next.fileIndex !== index && next.hunkIndex === 0;
    followLine.current = false;
    if (next.fileIndex !== index) scrolling.current?.cancel();
    slideToFile(next.fileIndex);
    navigationVersion.current++;
    if (next.fileIndex !== index) resetDeletionVisibility();
    pendingScroll.current = true;
    setPosition(next);
  }

  // Choose once after saved progress arrives; later saves and cross-tab updates must not steal focus.
  useEffect(() => {
    if (initialReviewSelection.current || !props.progressEndpoint || !progress.ready) return;
    initialReviewSelection.current = true;
    if (navigationVersion.current > 0 || props.focus) return;

    // Explicit file URLs win over resuming elsewhere, but can still resume a hunk in that file.
    const pendingFiles = files.map((entry, fileIndex) => (initialRoute.current?.file === undefined || fileIndex === index)
      && !isFileReviewed(fileIndex) && props.viewedFiles?.[entry.name] !== "VIEWED");
    const block = progress.blocks.find((entry) => pendingFiles[entry.fileIndex] && !progress.reviewed(entry)
      && !isImportOnly(entry, importGroups(files[entry.fileIndex], sourceContents.current.get(files[entry.fileIndex]))));
    // Binary and metadata-only files still need review when no unreviewed text hunks remain.
    const fileIndex = block?.fileIndex ?? pendingFiles.findIndex(Boolean);
    if (fileIndex < 0) return;
    if (fileIndex === index && (!block || (position.lineIndex ?? hunks[position.hunkIndex]) === block.selected)) return;
    if (fileIndex !== index) selectFile(fileIndex, false);
    if (block) {
      openAtFileStart.current = false;
      pendingScroll.current = true;
      setPosition({ fileIndex, hunkIndex: block.hunkIndex, lineIndex: block.selected });
    }
  }, [files, progress, props.progressEndpoint, props.viewedFiles, props.focus]);

  /** Navigate immediately; saving the reviewed file must not block further navigation. */
  function markViewedAndMove(direction: 1 | -1) {
    if (!props.progressEndpoint) return;
    const fileIndex = index;
    const next = index + direction;
    if (next >= 0 && next < files.length) selectFile(next);
    progress.saveFile(fileIndex, true);
  }

  /** File state is derived from text hunks and explicit non-text review units. */
  function isFileReviewed(fileIndex: number): boolean {
    const entry = files[fileIndex];
    const groups = importGroups(entry, sourceContents.current.get(entry));
    const blocks = progress.blocks.filter((block) => block.fileIndex === fileIndex && !isImportOnly(block, groups));
    return fileReviewed(entry.name, [...blocks, ...progress.metadata.filter((unit) => unit.path === entry.name)], progress.reviewed);
  }

  /** Step through readable rows, skipping collapsed deletion strips. */
  function moveLine(direction: 1 | -1) {
    // A keypress supersedes an unfinished resize anchor from opening the split.
    focusRequest.current = undefined;
    // Keyboard reading resumes even at a file boundary; Space must not click a stale toolbar button.
    viewport.current?.focus({ preventScroll: true });
    const root = viewport.current?.querySelector("diffs-container")?.shadowRoot;
    const rows = Array.from(root?.querySelectorAll<HTMLElement>("[data-line]") ?? []);
    const current = rows.findIndex((row) => row.hasAttribute("data-biff-focused"));
    let next = current + direction;
    // Only measure candidate rows, rather than every line in a large PR on each repeat.
    while (rows[next] && (isCollapsedDeletion(rows[next]) || rows[next].getBoundingClientRect().height === 0)) next += direction;
    const target = current >= 0 ? rows[next] : undefined;
    if (!target) {
      // A viewport edge is not a file edge. Locate the next source row before
      // asking Pierre to mount it and measure its actual bounds.
      const diff = activeDiff.current;
      let candidate = (position.lineIndex ?? hunks[position.hunkIndex]) + direction;
      for (; candidate >= 0 && candidate < diff.unifiedLineCount; candidate += direction) {
        const location = lineLocation(diff, candidate);
        if (!location || foldedImportAt(currentImportGroups(), expanded, candidate)) continue;
        if (location.side === "LEFT" && collapseOld && !nearbyOpen && !deletionPeek) continue;
        if (location.side === "RIGHT" && !diffInstance.current?.isLineRenderable(location.line)) continue;
        selectLine(candidate, true, true);
        return;
      }
      return;
    }

    const lineIndex = Number(target.dataset.lineIndex!.split(",")[0]);
    selectLine(lineIndex, true, true);
  }

  /** Share the navigation cursor between mouse selection and keyboard movement. */
  function selectLine(lineIndex: number, center: boolean, follow = false) {
    openAtFileStart.current = false;
    followLine.current = follow;
    if (!center) scrolling.current?.cancel();
    // Deleted rows belong to their replacement's block even though its preferred
    // navigation stop is the first addition, several rows further down.
    const starts = changeStarts(file, false);
    const following = starts.findIndex((start) => start > lineIndex);
    const hunkIndex = Math.max(0, (following < 0 ? starts.length : following) - 1);
    pendingScroll.current = center;
    setPosition((current) => current.fileIndex === index && current.lineIndex === lineIndex ? current : { fileIndex: index, hunkIndex, lineIndex });
  }

  /** Include scroll/layout work from layout effects, which can run after onPostRender returns. */
  function scrollToHunk() {
    measureFileTiming(file, "scroll and layout (inclusive)", scrollToHunkNow);
  }

  /** Use rendered row positions because wrapping and collapsed deletions change heights. */
  function scrollToHunkNow() {
    const element = viewport.current;
    if (!element) return;
    // File switches can run effects before Pierre replaces the previous file's rows.
    if (renderedFile.current !== file || activeDiff.current.name !== file.name) return;
    // React effects can run while Pierre still has the pre-expansion window mounted.
    if (pendingContextRender.current) return;
    if (focusRequest.current && focusRequest.current.path !== file.name && focusRequest.current.path !== file.prevName) return;
    if (needsImportSource && !sourceContents.current.has(file) && !sourceFailures.current.has(file)) return;
    const lineIndex = position.lineIndex ?? changeStarts(file)[position.hunkIndex];
    if (lineIndex === undefined) {
      scrolling.current?.cancel();
      element.scrollTop = 0;
      pendingScroll.current = false;
      return;
    }
    const root = element.querySelector("diffs-container")?.shadowRoot;
    if (!root) return;
    // Explicit comment/search targets win over resuming at an unreviewed hunk.
    if (!focusRequest.current && props.progressEndpoint && progress.ready && openAtFileStart.current && lastScrolledFile.current !== file) {
      const candidates = progress.blocks.filter((block) => block.fileIndex === index && !progress.reviewed(block));
      const target = candidates.find((block) => !foldedImportAt(currentImportGroups(), expanded, block.selected));
      if (target && position.lineIndex !== target.selected) {
        setPosition({ fileIndex: index, hunkIndex: target.hunkIndex, lineIndex: target.selected });
        return;
      }
    }
    if (focusRequest.current && root) {
      const request = focusRequest.current;
      if ((unmodifiedOpen || unmodifiedPeek) && activeDiff.current.isPartial && props.loadDiffFiles) return;
      if (revealImportLocation(request)) return;
      const match = findDiffLine(root, activeDiff.current, request);
      if (match) {
        const matchedIndex = Number(match.dataset.lineIndex!.split(",")[0]);
        if (position.lineIndex !== matchedIndex) {
          // Pierre can render again before React commits the remapped cursor.
          // Retain the file coordinate until the new renderer index is in state.
          selectLine(matchedIndex, pendingScroll.current, followLine.current);
          return;
        }
        focusRequest.current = undefined;
      }
      if (!match && revealVirtualLine(request)) return;
      if (!match && root.querySelector("[data-line]")) {
        focusRequest.current = undefined;
        setError("That line is outside the context included in this diff.");
      }
    }
    if (foldedImportAt(currentImportGroups(), expanded, lineIndex)) {
      const next = firstNonImportChange(file, currentImportGroups(), expanded, position.hunkIndex);
      if (next) {
        pendingScroll.current = true;
        setPosition({ fileIndex: index, hunkIndex: next.hunkIndex, lineIndex: next.index });
      } else {
        for (const previous of root!.querySelectorAll("[data-biff-focused]")) previous.removeAttribute("data-biff-focused");
        props.onSelectLine?.(undefined);
        element.scrollTop += element.querySelector("diffs-container")!.getBoundingClientRect().top - element.getBoundingClientRect().top - 8;
        lastScrolledFile.current = file;
        pendingScroll.current = false;
      }
      return;
    }
    const sourceLine = root.querySelector<HTMLElement>(`[data-line][data-line-index^="${lineIndex},"], [data-line][data-line-index="${lineIndex}"]`);
    if (!sourceLine) {
      if (pendingScroll.current) {
        const location = lineLocation(activeDiff.current, lineIndex);
        if (location) revealVirtualLine(location);
      }
      return;
    }
    const line = sourceLine;
    for (const previous of root!.querySelectorAll("[data-biff-focused]")) previous.removeAttribute("data-biff-focused");
    line.setAttribute("data-biff-focused", "");
    const location = lineLocation(activeDiff.current, lineIndex);
    if (location) {
      saveReviewPosition(positionScope, location);
      props.onSelectLine?.(location);
    }
    if (!pendingScroll.current) return;
    const bounds = measureFileTiming(file, "selected-row layout read", () => line.getBoundingClientRect());
    // Animate navigation within a file, but avoid sweeping through unrelated code
    // when opening a new file. Repeated keypresses share one moving scroll target.
    const smooth = lastScrolledFile.current === file && !matchMedia("(prefers-reduced-motion: reduce)").matches;
    const openingAtStart = lastScrolledFile.current !== file && openAtFileStart.current;
    const content = element.querySelector("diffs-container")!;
    // Skip the centering spacer on file load so code starts beside the picker.
    const top = openingAtStart
      ? measureFileTiming(file, "file-start layout reads", () => element.scrollTop + content.getBoundingClientRect().top - element.getBoundingClientRect().top - 8)
      : measureFileTiming(file, "centering layout reads", () => element.scrollTop + bounds.top + bounds.height / 2 - element.getBoundingClientRect().top - element.clientHeight / 2);
    scrolling.current ??= createSmoothScroll(element);
    if (followLine.current) scrolling.current.follow(top, smooth);
    else scrolling.current.to(top, smooth);
    scrollHeight.current = element.clientHeight;
    resizeRemainder.current = 0;
    lastScrolledFile.current = file;
    pendingScroll.current = false;
  }

  /** Reveal an offscreen source coordinate through Pierre's native layout estimate. */
  function revealVirtualLine(location: ReviewLine): boolean {
    const instance = diffInstance.current;
    if (!instance || instance.fileDiff !== activeDiff.current) return false;
    scrolling.current?.cancel();
    return revealDiffLine(instance, virtualizer, location, (viewport.current?.clientHeight ?? 0) / 2);
  }

  /** Parse first so a rejected upload leaves the current review intact. */
  function load(text: string, name: string) {
    try {
      const parsed = parseInput(text, false, "Imported patch");
      setFrozen(undefined);
      setEntries(groupFiles(parsed));
      fileSlide.current?.slide.cancel();
      fileSlide.current = undefined;
      selectFile(0, false);
      setSource(name);
      setError("");
      setPasteOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not read this patch.");
    }
  }

  /** Read dropped and selected files through the same input path. */
  async function openFiles(selected: File[]) {
    try {
      const texts = await Promise.all(selected.map((entry) => entry.text()));
      load(texts.join("\n"), selected.map((entry) => entry.name).join(", "));
    } catch {
      setError("Could not read the selected files.");
    }
  }

  useEffect(() => {
    scrollToHunk();
    finishImportPreparation();
  }, [file, position, nearbyOpen, deletionPeek, unmodifiedOpen, unmodifiedPeek]);

  useLayoutEffect(() => {
    const container = viewport.current?.querySelector<HTMLElement>("diffs-container");
    if (container) {
      // Cursor-only navigation must not ask Pierre to re-render every code column.
      // Nearby-deletion mode follows individual lines within the selected block.
      syncDeletionVisibility(container);
      deletionAnchor.current?.();
      deletionAnchor.current = undefined;
    }
  }, [collapseOld, nearbyOpen, deletionPeek, deletionOnlyLine, file, position]);

  useEffect(() => {
    const container = viewport.current?.querySelector<HTMLElement>("diffs-container");
    if (container && renderedFile.current === file) syncLineComments(container, file, props.inlineThreads ?? [], props.onOpenComments ? openLineComments : undefined);
  }, [file, props.inlineThreads, props.onOpenComments]);

  /** A shared gutter opens a chooser; an unambiguous gutter keeps its direct-open behavior. */
  function openLineComments(selection: CommentSelection) {
    if (selection.threadIds && selection.threadIds.length > 1) setLineThreadPicker(selection);
    else props.onOpenComments?.(selection);
  }

  useEffect(() => {
    if (!props.focus) return;
    goToCode(props.focus);
  }, [props.focus]);

  /**
   * Use current hunks as a best-effort destination for historical comment coordinates.
   *
   * Files without text hunks still open. Only exact targets may expand unchanged source.
   */
  function goToCode(location: CodeLocation) {
    const fileIndex = files.findIndex((entry) => entry.name === location.path || entry.prevName === location.path);
    if (fileIndex < 0) return;
    const target = files[fileIndex];
    const line = location.approximate ? closestDiffLine(target, location) : location;
    selectFile(fileIndex);
    if (line) {
      openAtFileStart.current = false;
      focusRequest.current = line;
      if (line.side === "LEFT") setNearbyOpen(true);
      // GitHub can attach current comments to unchanged lines outside the patch's context.
      const included = target.hunks.some((hunk) => {
        const start = line.side === "LEFT" ? hunk.deletionStart : hunk.additionStart;
        const count = line.side === "LEFT" ? hunk.deletionCount : hunk.additionCount;
        return line.line >= start && line.line < start + count;
      });
      if (!included) setUnmodifiedOpen(true);
    }
    setFileCommentsOpen(false);
    requestAnimationFrame(() => viewport.current?.focus({ preventScroll: true }));
  }

  useEffect(() => {
    if (!viewport.current || pasteOpen) return;
    return installClickSelection(viewport.current, (lineIndex) => {
      focusRequest.current = undefined;
      selectLine(lineIndex, false);
    });
  }, [file, pasteOpen]);

  useEffect(() => {
    const shortcuts = [...viewerShortcuts, ...(props.progressEndpoint ? progressShortcuts : []),
      ...(props.onOpenComments ? [{ keys: "c", description: "Open comments on focused line" }, { keys: "C", description: "Open file comments" }] : []),
      ...(frozen || fileSearchOpen ? [{ keys: "Escape", description: "Close file search or frozen reference" }] : []),
    ];
    /** Leave native controls and text selection shortcuts alone. */
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target;
      if (event.defaultPrevented || event.isComposing || filePickerOpen || fileCommentsOpen || lineThreadPicker) return;
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "p" && !pasteOpen && !document.querySelector("[data-comment-overlay], [popover]:popover-open")) {
        event.preventDefault();
        setSearchOpen(false);
        setFilePickerOpen(true);
        return;
      }
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "f" && !pasteOpen && !document.querySelector("[data-comment-overlay]")) {
        event.preventDefault();
        setSearchOpen(true);
        return;
      }
      if (searchOpen) return;
      if (followUpsOpen) { if (event.key === "Escape") { event.preventDefault(); setFollowUpsOpen(false); } return; }
      if (pasteOpen || document.querySelector("[data-comment-overlay], [popover]:popover-open") || event.ctrlKey || event.metaKey || event.altKey) return;
      if (preparedFile.current !== file && !["h", "l", "H", "L", "ArrowRight", "ArrowLeft"].includes(event.key)) return;
      if (!matchesShortcut(event, shortcuts)) return;

      if (event.key === "/") {
        event.preventDefault();
        openFileSearch();
      } else if (event.key === "Escape" && fileSearchOpen) {
        event.preventDefault();
        closeFileSearch();
      } else if (event.key === "Escape" && frozen) {
        event.preventDefault();
        closeFrozen();
      } else if (event.key === "f") {
        event.preventDefault();
        if (!event.repeat) freezeLine();
      } else if (event.key === "!" && props.progressEndpoint) {
        event.preventDefault();
        if (!event.repeat) void followUpChange();
      } else if ((event.key === "N" || event.key === "P") && props.progressEndpoint) {
        event.preventDefault();
        if (!event.repeat) moveFollowUp(event.key === "N" ? 1 : -1);
      } else if (event.key === " " && props.progressEndpoint) {
        const origin = event.composedPath()[0];
        if (origin instanceof Element && origin.closest("button")) return;
        event.preventDefault();
        if (!event.repeat) completeChange(event.shiftKey);
      } else if (event.key === "C" && props.onOpenComments) {
        event.preventDefault();
        if (!event.repeat) setFileCommentsOpen(true);
      } else if (event.key === "c" && props.onOpenComments) {
        const root = viewport.current?.querySelector("diffs-container")?.shadowRoot ?? undefined;
        const row = root?.querySelector<HTMLElement>("[data-biff-focused]");
        const location = row && lineLocation(file, Number(row.dataset.lineIndex!.split(",")[0]));
        if (row && location) {
          event.preventDefault();
          if (!event.repeat) {
            const gutter = Array.from(root!.querySelectorAll<HTMLElement>("[data-gutter] > [data-line-index]")).find((entry) => entry.dataset.lineIndex === row.dataset.lineIndex);
            const button = gutter?.querySelector<HTMLButtonElement>("[data-biff-comments]");
            if (button) button.click();
            else {
              props.onOpenComments({ line: location, anchor: prepareCommentAnchor(row) });
            }
          }
        }
      } else if (event.key === "d" || event.key === "D") {
        event.preventDefault();
        if (!event.repeat) {
          anchorDeletions();
          if (event.shiftKey) {
            deletionPress.current = true;
            setDeletionPeek(true);
          } else {
            setNearbyOpen((open) => !open);
          }
        }
      } else if (event.key === "u" || event.key === "U") {
        event.preventDefault();
        if (file.isPartial && !props.loadDiffFiles) {
          setError("This patch does not include the omitted lines. Open its working-copy or PR review to expand them.");
          return;
        }
        if (!event.repeat) {
          if (event.shiftKey) {
            if (!unmodifiedOpen && !unmodifiedPeek) anchorUnmodified();
            unmodifiedPress.current = true;
            setUnmodifiedPeek(true);
          } else {
            if (!unmodifiedPeek) anchorUnmodified();
            setUnmodifiedOpen((open) => !open);
          }
        }
      } else if (event.key === "n" || event.key === "p") {
        event.preventDefault();
        moveChange(event.key === "n" ? 1 : -1);
      } else if (event.key === "j" || event.key === "k") {
        event.preventDefault();
        moveLine(event.key === "j" ? 1 : -1);
      } else if ((event.key === "H" || event.key === "L") && props.progressEndpoint) {
        event.preventDefault();
        if (!event.repeat) void markViewedAndMove(event.key === "L" ? 1 : -1);
      } else if (event.key === "h" || event.key === "l" || event.key === "ArrowRight" || event.key === "ArrowLeft") {
        event.preventDefault();
        const fileIndex = index + (event.key === "l" || event.key === "ArrowRight" ? 1 : -1);
        if (fileIndex >= 0 && fileIndex < files.length) navigateTo({ fileIndex, hunkIndex: 0 });
      }
    }

    /** Shift+D restores the toggle state when either key is released. */
    function onKeyUp(event: KeyboardEvent) {
      if (unmodifiedPress.current && (event.code === "KeyU" || event.key === "Shift")) {
        unmodifiedPress.current = false;
        if (!unmodifiedOpen) anchorUnmodified();
        setUnmodifiedPeek(false);
      }
      if (!deletionPress.current || (event.code !== "KeyD" && event.key !== "Shift")) return;
      deletionPress.current = false;
      anchorDeletions();
      setDeletionPeek(false);
    }

    /** A lost keyup must not leave temporary deletions stuck open. */
    function endDeletionPeek() {
      scrolling.current?.cancel();
      if (unmodifiedPress.current) {
        unmodifiedPress.current = false;
        if (!unmodifiedOpen) anchorUnmodified();
        setUnmodifiedPeek(false);
      }
      if (!deletionPress.current) return;
      deletionPress.current = false;
      anchorDeletions();
      setDeletionPeek(false);
    }

    const unregister = registerShortcuts(shortcuts, onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", endDeletionPeek);
    return () => {
      unregister();
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", endDeletionPeek);
    };
  }, [files, frozen, pasteOpen, searchOpen, fileSearch, fileSearchOpen, filePickerOpen, fileCommentsOpen, lineThreadPicker, followUpsOpen, followUps.items, selectedFollowUp, position, expanded, sourceVersion, progress, unmodifiedOpen, unmodifiedPeek, props.onOpenComments, props.progressEndpoint, props.loadDiffFiles]);

  return (
    <div className="app" onDragOver={(event) => event.preventDefault()} onDrop={(event) => {
      event.preventDefault();
      if (event.dataTransfer.files.length) void openFiles(Array.from(event.dataTransfer.files));
    }}>
      {props.allowImport !== false && <header>
        <span className="viewer-source" title={source}>{source}</span>
        <div className="actions">
          <button onClick={() => upload.current?.click()}>Open patch</button>
          <button onClick={() => setPasteOpen(true)}>Paste diff</button>
        </div>
        <input hidden ref={upload} type="file" multiple accept=".diff,.patch,text/plain" onChange={(event) => {
          if (event.target.files?.length) void openFiles(Array.from(event.target.files));
          event.target.value = "";
        }} />
      </header>}

      <div className="reading-pane">
      {props.progressEndpoint && reviewProgressTarget && createPortal(<ReviewProgress reviewed={totalReviewedBlocks} total={reviewableBlocks.length} ready={progress.ready && reconciliation.complete} />, reviewProgressTarget)}
      <section className="filebar" aria-label="File navigation">
          <div className="file-navigation">
          <div className="file-position">
            <svg className="file-progress" width="16" height="16" viewBox="0 0 20 20" role="img" aria-label={`${reviewedFileCount} of ${files.length} files reviewed`}>
              <title>{reviewedFileCount} of {files.length} files reviewed</title>
              <circle className="progress-track" cx="10" cy="10" r="7" />
              <circle className="progress-fill" cx="10" cy="10" r="7" pathLength="100" strokeDasharray="100" strokeDashoffset={100 - (files.length ? reviewedFileCount / files.length * 100 : 0)} transform="rotate(-90 10 10)" />
            </svg>
            <span aria-label={`File ${index + 1} of ${files.length}`}><strong>{index + 1}</strong> / {files.length}</span>
          </div>
          <FileRail entries={entries} index={index} viewedFiles={reviewedFiles} unreadThreads={unreadThreadsByFile} onSelect={selectFile} onOpenComments={(fileIndex) => { if (fileIndex !== index) selectFile(fileIndex); setFileCommentsOpen(true); }} currentReviewToggle={props.progressEndpoint &&
              <button type="button" className="file-review-toggle" aria-label="File reviewed" aria-pressed={sourceReady && isFileReviewed(index)} disabled={!progress.ready || !sourceReady || isAutoReviewedFile(file.name)} onClick={() => progress.saveFile(index, !isFileReviewed(index))} title={isAutoReviewedFile(file.name) ? "Auto-reviewed; excluded from hunk totals" : !sourceReady ? "Reconciling…" : isFileReviewed(index) ? "Mark file unreviewed" : "Mark whole file reviewed"}>
                <svg width="16" height="16" viewBox="0 0 20 20" aria-hidden="true"><circle className="progress-track" cx="10" cy="10" r="7" /><circle className="progress-fill" cx="10" cy="10" r="7" pathLength="100" strokeDasharray="100" strokeDashoffset={100 - (fileBlocks.length ? reviewedBlockCount / fileBlocks.length * 100 : sourceReady && isFileReviewed(index) ? 100 : 0)} transform="rotate(-90 10 10)" /></svg>
              </button>
          } currentProgress={props.progressEndpoint &&
              <span className="change-progress" role="progressbar" aria-label="Change review progress" aria-valuemin={0} aria-valuemax={Math.max(1, fileBlocks.length)} aria-valuenow={progress.ready ? reviewedBlockCount : undefined} aria-valuetext={progress.ready ? `${reviewedBlockCount} of ${fileBlocks.length} changes reviewed` : "Loading review progress"}>
                <span aria-hidden="true">{progress.ready ? `${reviewedBlockCount}/${fileBlocks.length}` : "…"}</span>
              </span>
          } />
          {!searchControlTarget && <div className="file-search"><button onClick={() => setSearchOpen(true)} title="Find files and symbols (Ctrl/Cmd+F)" aria-label="Find in review">⌕ Find</button></div>}
          </div>
          {searchControlTarget && createPortal(<button onClick={() => setSearchOpen(true)} title="Find files and symbols (Ctrl/Cmd+F)" aria-label="Find in review">⌕ Find</button>, searchControlTarget)}
          <nav className="file-toolbar" aria-label="File review controls">
          <div className="file-status">
            <button onClick={freezeLine} title="Freeze current line in a reference pane (f)">Freeze</button>
            {props.progressEndpoint && <button className={followUpTargets.length ? "follow-up-active" : ""} onClick={() => setFollowUpsOpen((open) => !open)}>Follow-ups ({followUpTargets.length})</button>}
            {followUpIndex >= 0 && <span className="follow-up-active" role="status">Follow-up {followUpIndex + 1} of {followUpTargets.length}</span>}
            {props.onOpenComments && <button onClick={() => setFileCommentsOpen(true)} title="Unresolved threads: this file / entire review (C)">Comments ({fileThreadCount}/{reviewThreadCount})</button>}
          </div>
          </nav>
      </section>

      {fileSearchOpen && <FileSearch key={file.name} file={file} query={fileSearchQuery} request={fileSearch.request} location={lineLocation(activeDiff.current, position.lineIndex ?? hunks[position.hunkIndex])} loadContents={props.loadDiffFiles ? loadSearchContents : undefined} onQueryChange={(query) => setFileSearch((current) => current && { ...current, query })} onSelect={selectFileSearchResult} onClose={closeFileSearch} />}

      {props.progressEndpoint && <ActivityStatus scope={`load:${props.progressEndpoint}/progress`} label="Prepare review progress" error={progress.error} retry={progress.retry} />}
      {props.progressEndpoint && <BackgroundSaveStatus scope={progress.scope} />}
      <ActivityScope scope={followUps.scope} />
      {followUpsOpen && <aside className="follow-up-list" data-modal-scope aria-label="Follow-ups" onKeyDown={(event) => { if (event.key === "Escape") setFollowUpsOpen(false); }}>
        <ModalHeader title={`Follow-ups (${followUpTargets.length})`} closeLabel="Close follow-ups" onClose={() => setFollowUpsOpen(false)} />
        {!followUpTargets.length && <p>No follow-ups in this review. Press <kbd>!</kbd> on a hunk, or flag a thread.</p>}
        {followUpTargets.map((target) => <div className="follow-up-entry" key={followUpKey(target.item)}><button onClick={() => openFollowUp(target.item)}>{target.item.type === "hunk" ? `${target.item.path}:${target.line} · Hunk` : `${target.item.location.path}:${target.line} · ${target.item.label}`}</button><button aria-label="Clear follow-up" disabled={followUps.busy} onClick={() => { if (target.item.type === "thread") void followUps.thread(target.item.id, false); else if (props.progressHead) void followUps.hunk(target.item, props.progressHead, false); }}>Clear</button></div>)}
      </aside>}

      {error && !pasteOpen && <div className="error" role="alert">{error}<button onClick={() => setError("")} aria-label="Dismiss error">×</button></div>}

      <ActivityStatus label={sourceFailures.current.has(file) ? `Load source · ${file.name}` : `Load source files (${sourceLoads})`} loading={sourceLoads > 0} error={sourceFailures.current.has(file) ? `Could not load source for ${file.name}` : undefined} retry={() => void retrySource()} />
      <DiffPanes reference={frozen && <FrozenDiff key={frozen.request} frozen={frozen} contents={sourceContents.current.get(frozen.file)} loadContents={props.loadDiffFiles ? loadSearchContents : undefined} onClose={closeFrozen} />}>
      <div ref={stage} className="file-stage" data-imports-pending={!sourceReady || preparedFile.current !== file ? "" : undefined} aria-busy={!sourceReady || preparedFile.current !== file}>
      <div className="import-preparing" role="status">Preparing diff…</div>
      <main ref={attachViewport} className="viewport" aria-label="Diff reading surface" aria-hidden={preparedFile.current !== file ? true : undefined} inert={preparedFile.current !== file} tabIndex={0} onClickCapture={(event) => {
        const origin = event.nativeEvent.composedPath()[0];
        const expander = origin instanceof Element ? origin.closest("[data-expand-button], [data-unmodified-lines]") : null;
        if (expander && !expander.hasAttribute("data-fold-toggle")) anchorUnmodified();
      }} onClick={(event) => {
        const origin = event.nativeEvent.composedPath()[0];
        const button = origin instanceof Element ? origin.closest<HTMLElement>("[data-fold-toggle]") : null;
        if (button) setImportExpanded(button.dataset.foldToggle!, button.getAttribute("aria-expanded") !== "true");
      }}>
        <div className="surface">
          {sourceReady && <DiffSurface file={file} contents={sourceContents.current.get(file)} virtualizer={virtualizer} metrics={virtualMetrics} options={{
            resolveFoldedRanges,
            expandUnchanged: unmodifiedOpen || unmodifiedPeek,
            loadDiffFiles: props.loadDiffFiles ? loadDiffContents : undefined,
            // Comment previews occupy the row's bottom padding; outline only its source text.
            unsafeCSS: `${dividerCSS}
              [data-biff-focused] { opacity: 1; outline: 1px solid #bce99e; outline-offset: -1px; box-shadow: inset 3px 0 #bce99e; }
              [data-biff-focused][data-biff-comment-row] { outline: none; box-shadow: none; }
              [data-biff-focused][data-biff-comment-row]::before { content: ""; position: absolute; inset: 0 0 var(--biff-comment-height); outline: 1px solid #bce99e; outline-offset: -1px; box-shadow: inset 3px 0 #bce99e; pointer-events: none; }
            `,
            onPostRender: onRender,
            onDiffTiming,
          }} />}
          <div className="end-note">End of {file.name} · {isAutoReviewedFile(file.name) ? "Auto-reviewed" : `${hunks.length} ${hunks.length === 1 ? "hunk" : "hunks"}`}</div>
        </div>
      </main>
      </div>
      </DiffPanes>
      </div>

      {filePickerOpen && <FilePicker files={files} index={index} viewedFiles={reviewedFiles} hunkProgress={props.progressEndpoint ? fileHunkProgress : undefined} progressReady={progress.ready} onSelect={selectFile} onClose={() => setFilePickerOpen(false)} />}
      {fileCommentsOpen && <FileComments files={files} path={file.name} threads={commentThreads} saveScope={resolutionScope} returnFocus={viewport.current} threadContent={props.commentContent} activeThreadId={props.activeCommentId} onRead={props.onReadComment} onComplete={props.onResolveComment ? resolutions.complete : undefined} onGoToCode={goToCode} onResolve={props.onResolveComment ? resolveComment : undefined} onReply={(selection) => props.onOpenComments?.(selection)} onClose={() => setFileCommentsOpen(false)} />}
      {lineThreadPicker && <LineThreadPicker selection={lineThreadPicker} threads={commentThreads.filter((thread) => lineThreadPicker.threadIds?.includes(thread.id))} onClose={() => setLineThreadPicker(undefined)} onSelect={(thread) => {
        setLineThreadPicker(undefined);
        props.onOpenComments?.({ line: thread.location, threadId: thread.id, anchor: lineThreadPicker.anchor?.row ? prepareCommentAnchor(lineThreadPicker.anchor.row) : lineThreadPicker.anchor });
      }} />}
      {searchOpen && <SearchOverlay files={files} query={searchQuery} onQueryChange={setSearchQuery} selected={searchSelection} onSelectedChange={setSearchSelection} loadContents={props.loadDiffFiles ? loadSearchContents : undefined} onSelect={selectSearchResult} onClose={() => setSearchOpen(false)} />}

      {pasteOpen && <div className="modal-backdrop" onClick={() => setPasteOpen(false)}>
        <section className="modal" role="dialog" aria-modal="true" aria-labelledby="paste-title" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => {
          if (event.key === "Escape") setPasteOpen(false);
          if (event.key === "Tab") {
            const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("textarea, button")).filter((control) => control.getClientRects().length > 0 && !control.matches(":disabled"));
            const next = event.shiftKey ? controls.at(-1) : controls[0];
            const boundary = event.shiftKey ? controls[0] : controls.at(-1);
            if (document.activeElement === boundary) { event.preventDefault(); next?.focus(); }
          }
        }}>
          <ModalHeader title="Bring your own diff." titleId="paste-title" closeLabel="Close paste diff" onClose={() => setPasteOpen(false)} />
          <p>Paste a unified patch from Git, Jujutsu, or GitHub.</p>
          {error && <p role="alert">{error}</p>}
          <textarea autoFocus aria-label="Unified diff" placeholder="diff --git a/example.ts b/example.ts" value={patch} onChange={(event) => setPatch(event.target.value)} />
          <div className="modal-actions"><button onClick={() => setPasteOpen(false)}>Cancel</button><button className="primary" onClick={() => load(patch, "Pasted diff")}>Open diff</button></div>
        </section>
      </div>}
    </div>
  );

  /**
   * Load omitted context while retaining the selected file coordinate.
   *
   * Hydration changes unified indexes, so a saved renderer row index is insufficient.
   */
  async function loadContext(diff: Parameters<FileDiffContentsLoader>[0]) {
    const version = navigationVersion.current;
    try {
      const contents = await fetchContents(diff);
      if (version !== navigationVersion.current) return contents;
      preserveSourceLocation();
      return contents;
    } catch (cause) {
      if (version === navigationVersion.current) {
        setError(cause instanceof Error ? cause.message : "Could not load unmodified lines.");
        setUnmodifiedOpen(false);
        setUnmodifiedPeek(false);
      }
      throw cause;
    }
  }

  /**
   * Keep the latest reading cursor still when background syntax context upgrades the renderer.
   *
   * Source identity survives hydration even if the native renderer changes unified indexes.
   */
  function preserveSourceLocation() {
    if (focusRequest.current || renderedFile.current !== file) return;
    const root = viewport.current?.querySelector("diffs-container")?.shadowRoot;
    const selected = root?.querySelector<HTMLElement>("[data-biff-focused]");
    const location = selected && lineLocation(activeDiff.current, Number(selected.dataset.lineIndex!.split(",")[0]));
    if (!location || !selected) return;
    scrolling.current?.cancel();
    const top = selected.getBoundingClientRect().top;
    focusRequest.current = location;
    pendingScroll.current = false;
    deletionAnchor.current = restore;

    /** Restore by file coordinate after Pierre installs the full-file rows. */
    function restore() {
      const row = findDiffLine(root, activeDiff.current, location!);
      if (row && viewport.current) viewport.current.scrollTop += row.getBoundingClientRect().top - top;
    }
  }
}
