import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { parseInput } from "./patches";
import { groupFiles } from "./fileOrder";
import { FileDiff } from "@pierre/diffs/react";
import type { FileDiffContentsLoader, FileDiffLoadedFiles, FileDiffMetadata, FileDiffOptions } from "@pierre/diffs";
import "./style.css";
import { collapseDeletions, isCollapsedDeletion, updateDeletionVisibility } from "./collapseDeletions";
import { installClickSelection } from "./clickSelection";
import { captureLineAnchor } from "./lineAnchor";
import { changeStarts, lineLocation, nextHunk, type HunkPosition } from "./navigation";
import type { FileViewedState, ReviewLine } from "../shared/types";
import { syncLineComments, type CommentSelection, type LineThread } from "./lineComments";
import { CollapseDeletedContext } from "./Settings";
import { FileRail } from "./FileRail";
import { prepareFileSlide, type FileSlide } from "./fileSlide";
import { highlightMovedLines } from "./movedLines";
import { createSmoothScroll, type SmoothScroll } from "./smoothScroll";
import { useStableCallback } from "./useStableCallback";
import { foldedImportAt, firstNonImportChange, importGroups, importGroupId } from "./importFolds";
import { importSourceMayHelp } from "./importGroups";
import { useChangeProgress } from "./useChangeProgress";
import { isImportOnly, type ChangeBlock } from "./changeProgress";
import { SearchOverlay } from "./SearchOverlay";
import { FilePicker } from "./FilePicker";
import type { SearchLine } from "./search";

/** Review pages host Find in their source toolbar; standalone viewers keep it in the diff toolbar. */
export const SearchControlTarget = createContext<HTMLElement | null>(null);

export interface ViewerProps {
  progressEndpoint?: string;
  progressHead?: string;
  /** Backend reviews already hide whitespace; only raw imports need filtering. */
  whitespaceHidden?: boolean;
  patch: string;
  source?: string;
  allowImport?: boolean;
  onSelectLine?: (line: ReviewLine | undefined) => void;
  focus?: ReviewLine & { request: number };
  viewedFiles?: Record<string, FileViewedState>;
  onSyncReviewed?: (path: string, reviewed: boolean) => Promise<boolean>;
  loadDiffFiles?: FileDiffContentsLoader;
  inlineThreads?: LineThread[];
  onOpenComments?: (selection: CommentSelection) => void;
}

/**
 * Show an inline diff with full-size code and collapsible deleted blocks.
 *
 * Patch parsing stays local to the browser.
 */
export function Viewer(props: ViewerProps) {
  const searchControlTarget = useContext(SearchControlTarget);
  const [entries, setEntries] = useState(() => groupFiles(parseInput(props.patch, props.whitespaceHidden)));
  const files = useMemo(() => entries.map((entry) => entry.file), [entries]);
  const progress = useChangeProgress(files, props.progressEndpoint, props.progressHead);
  const syncedReviews = useRef(new Map<string, boolean>());
  const [position, setPosition] = useState<HunkPosition>(() => ({ fileIndex: restoredFileIndex(files), hunkIndex: 0 }));
  const index = position.fileIndex;
  const [source, setSource] = useState(props.source ?? "Example changes");
  const collapseOld = useContext(CollapseDeletedContext);
  const previousCollapse = useRef(collapseOld);
  const [nearbyOpen, setNearbyOpen] = useState(false);
  const [deletionPeek, setDeletionPeek] = useState(false);
  const [unmodifiedOpen, setUnmodifiedOpen] = useState(false);
  const [unmodifiedPeek, setUnmodifiedPeek] = useState(false);
  const unmodifiedPress = useRef(false);
  const deletionPress = useRef(false);
  const deletionAnchor = useRef<(() => void) | undefined>(undefined);
  const [error, setError] = useState("");
  const [pasteOpen, setPasteOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [filePickerOpen, setFilePickerOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchSelection, setSearchSelection] = useState<string>();
  const [patch, setPatch] = useState("");
  const viewport = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const fileSlide = useRef<{ file: typeof files[number]; slide: FileSlide } | undefined>(undefined);
  const focusRequest = useRef<ReviewLine | undefined>(undefined);
  const upload = useRef<HTMLInputElement>(null);
  const pendingScroll = useRef(true);
  const openAtFileStart = useRef(true);
  const navigationVersion = useRef(0);
  const file = files[index];
  const lastScrolledFile = useRef<typeof file | null>(null);
  const scrolling = useRef<SmoothScroll | undefined>(undefined);
  const scrollHeight = useRef<number | undefined>(undefined);
  const resizeRemainder = useRef(0);
  const followLine = useRef(false);
  const sourceRequests = useRef(new WeakMap<FileDiffMetadata, Promise<FileDiffLoadedFiles>>());
  const importSources = useRef(new WeakMap<FileDiffMetadata, FileDiffLoadedFiles>());
  const importFailures = useRef(new WeakSet<FileDiffMetadata>());
  const [sourceVersion, setSourceVersion] = useState(0);
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
  const fileImportGroups = importGroups(file, importSources.current.get(file));
  const fileBlocks = progress.blocks.filter((block) => block.fileIndex === index && !isImportOnly(block, fileImportGroups));
  const reviewedBlockCount = fileBlocks.filter(progress.reviewed).length;
  // Cursor movement must not reclassify every file in a large review.
  const reviewedFiles = useMemo<Record<string, FileViewedState>>(() => props.progressEndpoint ? Object.fromEntries(files.map((entry, fileIndex) => [entry.name, isFileReviewed(fileIndex) ? "VIEWED" : "UNVIEWED"])) : props.viewedFiles ?? {}, [files, index, sourceVersion, progress.blocks, progress.fileIdentities, progress.reviewed, props.progressEndpoint, props.viewedFiles]);
  const reviewedFileCount = files.filter((entry) => reviewedFiles[entry.name] === "VIEWED").length;
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
  const sourceReady = (!needsImportSource || importSources.current.has(file) || importFailures.current.has(file)) && (!props.progressEndpoint || progress.ready || Boolean(progress.error));
  const resolveFoldedRanges = useMemo<NonNullable<FileDiffOptions<undefined, undefined>["resolveFoldedRanges"]>>(() => (diff) => {
    const definitions = importGroups(diff, importSources.current.get(file));
    return definitions.map((group) => {
      const count = (props.inlineThreads ?? []).filter((thread) => (thread.location.path === diff.name || thread.location.path === diff.prevName) && group.keys.includes(`${thread.location.side}:${thread.location.line}`)).length;
      return { id: importGroupId(group), start: group.start, end: group.end, label: `${group.changes} Import ${group.changes === 1 ? "change" : "changes"}${count ? ` · ${count} ${count === 1 ? "thread" : "threads"}` : ""}`, expanded: group.keys.some((key) => expanded.has(key)), includeLeadingContext: group.leading };
    });
  }, [file, sourceVersion, expanded, props.inlineThreads]);
  const onRender = useStableCallback<Parameters<NonNullable<FileDiffOptions<undefined, undefined>["onPostRender"]>>, void>((node, instance, phase) => {
    if (phase === "unmount") collapseDeletions(node, false);
    if (phase !== "unmount") {
      renderedFile.current = file;
      activeDiff.current = instance.fileDiff ?? file;
      syncReviewedStyle(node);
      highlightMovedLines(node, file);
      collapseDeletions(node, collapseOld);
      syncDeletionVisibility(node);
      deletionAnchor.current?.();
      deletionAnchor.current = undefined;
      scrollToHunk();
      syncLineComments(node, file, props.inlineThreads ?? [], props.onOpenComments);
      finishImportPreparation();
    }
  });
  const loadDiffContents = useStableCallback(loadContext);
  const loadSearchContents = useStableCallback(fetchContents);

  useLayoutEffect(() => {
    const container = viewport.current?.querySelector<HTMLElement>("diffs-container");
    if (container) syncReviewedStyle(container);
  }, [reviewedCSS]);

  /** Progress only changes paint; keep it out of Pierre's options to avoid rebuilding rows mid-scroll. */
  function syncReviewedStyle(container: HTMLElement) {
    const root = container.shadowRoot;
    if (!root) return;
    let style = root.querySelector<HTMLStyleElement>("[data-reviewed-style]");
    if (!style) { style = document.createElement("style"); style.dataset.reviewedStyle = ""; root.append(style); }
    if (style.textContent !== reviewedCSS) style.textContent = reviewedCSS;
  }

  useEffect(() => {
    if (!needsImportSource) return;
    let active = true;
    // Full source resolves partial multiline imports and omitted import-only gaps.
    // Hold the initial pane until classification finishes to avoid an expanded-import flash.
    void fetchContents(file).then(() => { if (active) setSourceVersion((version) => version + 1); }, () => {
      if (active) { importFailures.current.add(file); setSourceVersion((version) => version + 1); }
    });
    return () => { active = false; };
  }, [file, needsImportSource]);

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
    try { sessionStorage.setItem(fileSelectionKey(), file.name); }
    catch { /* Reading a review still works when browser storage is unavailable. */ }
  }, [file]);

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
    return importGroups(activeDiff.current.name === file.name ? activeDiff.current : file, importSources.current.get(file));
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
    if (renderedFile.current !== file || pendingScroll.current || needsImportSource && !importSources.current.has(file) && !importFailures.current.has(file)) return;
    preparedFile.current = file;
    stage.current?.removeAttribute("data-imports-pending");
    stage.current?.setAttribute("aria-busy", "false");
    if (viewport.current) { viewport.current.inert = false; viewport.current.removeAttribute("aria-hidden"); }
    if (fileSlide.current?.file === file) fileSlide.current.slide.play();
  }

  /** Share a full-source request between import recognition and native context expansion. */
  function fetchContents(diff: FileDiffMetadata): Promise<FileDiffLoadedFiles> {
    const existing = sourceRequests.current.get(diff);
    if (existing) return existing;
    const request = Promise.resolve().then(() => props.loadDiffFiles!(diff)).then((contents) => {
      importSources.current.set(diff, contents);
      importFailures.current.delete(diff);
      // Prepare classification while this file is still in the background too.
      importGroups(diff, contents);
      return contents;
    }, (error: unknown) => { sourceRequests.current.delete(diff); throw error; });
    sourceRequests.current.set(diff, request);
    return request;
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

  /** Navigate pending blocks across files, retaining the current selection at either boundary. */
  function nextUnreviewed(direction: 1 | -1, exclude?: ChangeBlock) {
    const current = progress.blocks.findIndex((block) => block.fileIndex === index && block.hunkIndex === position.hunkIndex);
    for (let cursor = current + direction; cursor >= 0 && cursor < progress.blocks.length; cursor += direction) {
      const block = progress.blocks[cursor];
      if (block === exclude || progress.reviewed(block)) continue;
      const targetFile = files[block.fileIndex];
      const definitions = importGroups(targetFile, importSources.current.get(targetFile));
      if (isImportOnly(block, definitions)) continue;
      const keys = expandedImports.get(targetFile.name) ?? new Set<string>();
      const visible = firstNonImportChange(targetFile, definitions, keys, block.hunkIndex);
      if (!visible || visible.hunkIndex !== block.hunkIndex) continue;
      navigateTo({ fileIndex: block.fileIndex, hunkIndex: block.hunkIndex, lineIndex: visible.index });
      return;
    }
  }

  /** Space saves the selected edit and moves forward only if navigation has not changed. */
  async function completeChange() {
    if (!currentBlock || progress.busy || !progress.ready) return;
    if (isImportOnly(currentBlock, fileImportGroups)) { nextUnreviewed(1); return; }
    const version = navigationVersion.current;
    if (await progress.save(currentBlock, true) && navigationVersion.current === version) nextUnreviewed(1, currentBlock);
  }

  /** Capture before changing files; finish interrupted movement before the next slide. */
  function slideToFile(fileIndex: number) {
    if (fileIndex === index || !stage.current || !viewport.current) return;
    fileSlide.current?.slide.cancel();
    fileSlide.current = undefined;
    if (preparedFile.current !== file) return;
    const slide = prepareFileSlide(stage.current, viewport.current, fileIndex > index ? 1 : -1);
    if (slide) fileSlide.current = { file: files[fileIndex], slide };
  }

  /** Deletion visibility changes preserve the selected line, even when off-center. */
  function anchorDeletions() {
    scrolling.current?.cancel();
    deletionAnchor.current = captureLineAnchor(viewport.current?.querySelector("diffs-container")?.shadowRoot);
    pendingScroll.current = false;
  }

  /** Apply the same reveal rules after renderer updates and cursor movement. */
  function syncDeletionVisibility(container: HTMLElement) {
    updateDeletionVisibility(container, collapseOld, nearbyOpen || deletionPeek ? position.lineIndex ?? hunks[position.hunkIndex] : undefined, deletionOnlyLine);
  }

  /** File selection starts at its first hunk, independently of keyboard navigation. */
  function selectFile(fileIndex: number, animate = true) {
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

  /** Clear per-file reveal state in the same render as the file change. */
  function resetDeletionVisibility() {
    deletionPress.current = false;
    deletionAnchor.current = undefined;
    setNearbyOpen(false);
    setDeletionPeek(false);
    unmodifiedPress.current = false;
    setUnmodifiedOpen(false);
    setUnmodifiedPeek(false);
  }

  /** Cross-file navigation starts with that file's normal collapsed view. */
  function navigateTo(next: HunkPosition) {
    openAtFileStart.current = next.fileIndex !== index && next.hunkIndex === 0;
    followLine.current = false;
    if (next.fileIndex !== index) scrolling.current?.cancel();
    slideToFile(next.fileIndex);
    navigationVersion.current++;
    if (next.fileIndex !== index) resetDeletionVisibility();
    pendingScroll.current = true;
    setPosition(next);
  }

  // Import GitHub marks once, then mirror shared Biff progress (including block completion).
  // Recording attempts before sending prevents a failed request from retrying on every render.
  useEffect(() => {
    if (!props.onSyncReviewed || !props.viewedFiles || !progress.ready || progress.busy) return;
    for (const [fileIndex, entry] of files.entries()) {
      const reviewed = isFileReviewed(fileIndex);
      if (!syncedReviews.current.has(entry.name)) {
        const remote = props.viewedFiles[entry.name] === "VIEWED";
        syncedReviews.current.set(entry.name, remote);
        if (remote && !reviewed) {
          // A failed local import must not clear a valid mark on GitHub.
          syncedReviews.current.set(entry.name, false);
          void progress.saveFile(fileIndex, true).then((saved) => {
            if (saved) syncedReviews.current.set(entry.name, true);
          });
          continue;
        }
      }
      if (syncedReviews.current.get(entry.name) !== reviewed) {
        syncedReviews.current.set(entry.name, reviewed);
        void props.onSyncReviewed(entry.name, reviewed);
      }
    }
  }, [files, progress, props.viewedFiles, props.onSyncReviewed]);

  /** Navigate immediately; saving the reviewed file must not block further navigation. */
  async function markViewedAndMove(direction: 1 | -1) {
    if (!props.progressEndpoint) return;
    const path = file.name;
    const fileIndex = index;
    const next = index + direction;
    if (next >= 0 && next < files.length) selectFile(next);
    try {
      if (props.progressEndpoint && !await progress.saveFile(fileIndex, true)) return;
    } catch (cause) {
      setError(`${path}: ${cause instanceof Error ? cause.message : "Could not mark file viewed."}`);
    }
  }

  /** Metadata changes require explicit file review; ordinary text files can complete block by block. */
  function isFileReviewed(fileIndex: number): boolean {
    const identity = progress.fileIdentities[fileIndex];
    if (identity && progress.reviewed(identity)) return true;
    const entry = files[fileIndex];
    if (entry.prevName || entry.prevMode || !entry.hunks.length) return false;
    if ((entry.type === "new" || entry.type === "deleted") && entry.mode && entry.mode !== "100644") return false;
    const groups = importGroups(entry, importSources.current.get(entry));
    const blocks = progress.blocks.filter((block) => block.fileIndex === fileIndex && !isImportOnly(block, groups));
    return blocks.length > 0 && blocks.every(progress.reviewed);
  }

  /** Step through readable rows, skipping collapsed deletion strips. */
  function moveLine(direction: 1 | -1) {
    const root = viewport.current?.querySelector("diffs-container")?.shadowRoot;
    const rows = Array.from(root?.querySelectorAll<HTMLElement>("[data-line]") ?? []);
    const current = rows.findIndex((row) => row.hasAttribute("data-biff-focused"));
    let next = current + direction;
    // Only measure candidate rows, rather than every line in a large PR on each repeat.
    while (rows[next] && (isCollapsedDeletion(rows[next]) || rows[next].getBoundingClientRect().height === 0)) next += direction;
    const target = rows[next];
    if (!target) return;

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

  /** Use rendered row positions because wrapping and collapsed deletions change heights. */
  function scrollToHunk() {
    const element = viewport.current;
    if (!element) return;
    if (needsImportSource && !importSources.current.has(file) && !importFailures.current.has(file)) return;
    const lineIndex = position.lineIndex ?? changeStarts(file)[position.hunkIndex];
    if (lineIndex === undefined) {
      scrolling.current?.cancel();
      element.scrollTop = 0;
      pendingScroll.current = false;
      return;
    }
    const root = element.querySelector("diffs-container")?.shadowRoot;
    if (!root) return;
    if (props.progressEndpoint && progress.ready && openAtFileStart.current && lastScrolledFile.current !== file) {
      const candidates = progress.blocks.filter((block) => block.fileIndex === index && !progress.reviewed(block));
      const target = candidates.find((block) => !foldedImportAt(currentImportGroups(), expanded, block.selected));
      if (target && position.lineIndex !== target.selected) {
        setPosition({ fileIndex: index, hunkIndex: target.hunkIndex, lineIndex: target.selected });
        return;
      }
    }
    if (focusRequest.current && root) {
      const request = focusRequest.current;
      if (unmodifiedOpen && activeDiff.current.isPartial && props.loadDiffFiles) return;
      if (revealImportLocation(request)) return;
      const match = Array.from(root.querySelectorAll<HTMLElement>("[data-line]")).find((row) => {
        const location = lineLocation(activeDiff.current, Number(row.dataset.lineIndex!.split(",")[0]));
        return location?.line === request.line && location.side === request.side;
      });
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
    if (!sourceLine) return;
    const line = sourceLine;
    for (const previous of root!.querySelectorAll("[data-biff-focused]")) previous.removeAttribute("data-biff-focused");
    line.setAttribute("data-biff-focused", "");
    const location = lineLocation(file, lineIndex);
    if (location) props.onSelectLine?.(location);
    if (!pendingScroll.current) return;
    const bounds = line.getBoundingClientRect();
    // Animate navigation within a file, but avoid sweeping through unrelated code
    // when opening a new file. Repeated keypresses share one moving scroll target.
    const smooth = lastScrolledFile.current === file && !matchMedia("(prefers-reduced-motion: reduce)").matches;
    const openingAtStart = lastScrolledFile.current !== file && openAtFileStart.current;
    const content = element.querySelector("diffs-container")!;
    // Skip the centering spacer on file load so code starts beside the picker.
    const top = openingAtStart
      ? element.scrollTop + content.getBoundingClientRect().top - element.getBoundingClientRect().top - 8
      : element.scrollTop + bounds.top + bounds.height / 2 - element.getBoundingClientRect().top - element.clientHeight / 2;
    scrolling.current ??= createSmoothScroll(element);
    if (followLine.current) scrolling.current.follow(top, smooth);
    else scrolling.current.to(top, smooth);
    scrollHeight.current = element.clientHeight;
    resizeRemainder.current = 0;
    lastScrolledFile.current = file;
    pendingScroll.current = false;
  }

  /** Parse first so a rejected upload leaves the current review intact. */
  function load(text: string, name: string) {
    try {
      const parsed = parseInput(text);
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
    if (container && renderedFile.current === file) syncLineComments(container, file, props.inlineThreads ?? [], props.onOpenComments);
  }, [file, props.inlineThreads, props.onOpenComments]);

  useEffect(() => {
    if (!props.focus) return;
    const fileIndex = files.findIndex((entry) => entry.name === props.focus!.path || entry.prevName === props.focus!.path);
    if (fileIndex < 0) return;
    selectFile(fileIndex);
    focusRequest.current = props.focus;
    if (props.focus.side === "LEFT") setNearbyOpen(true);
  }, [props.focus]);

  useEffect(() => {
    if (!viewport.current || pasteOpen) return;
    return installClickSelection(viewport.current, (lineIndex) => selectLine(lineIndex, false));
  }, [file, pasteOpen]);

  useEffect(() => {
    /** Leave native controls and text selection shortcuts alone. */
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target;
      if (filePickerOpen) return;
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
      if (pasteOpen || document.querySelector("[data-comment-overlay], [popover]:popover-open") || event.ctrlKey || event.metaKey || event.altKey ||
        (target instanceof HTMLElement && target.closest("input, textarea, select, [contenteditable]"))) return;
      if (preparedFile.current !== file && !["h", "l", "H", "L", "ArrowRight", "ArrowLeft"].includes(event.key)) return;

      if (event.key === " " && props.progressEndpoint) {
        const origin = event.composedPath()[0];
        if (origin instanceof Element && origin.closest("button")) return;
        event.preventDefault();
        if (!event.repeat) void completeChange();
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
              const bounds = row.getBoundingClientRect();
              props.onOpenComments({ line: location, anchor: { top: bounds.top, bottom: bounds.bottom } });
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
          anchorDeletions();
          if (event.shiftKey) {
            unmodifiedPress.current = true;
            setUnmodifiedPeek(true);
          } else {
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
        anchorDeletions();
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
        anchorDeletions();
        setUnmodifiedPeek(false);
      }
      if (!deletionPress.current) return;
      deletionPress.current = false;
      anchorDeletions();
      setDeletionPeek(false);
    }

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", endDeletionPeek);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", endDeletionPeek);
    };
  }, [files, pasteOpen, searchOpen, filePickerOpen, position, expanded, sourceVersion, progress, props.onOpenComments, props.progressEndpoint, props.loadDiffFiles]);

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
      <section className="filebar" aria-label="File navigation">
          <div className="file-position">
            <svg className="file-progress" width="16" height="16" viewBox="0 0 20 20" role="img" aria-label={`${reviewedFileCount} of ${files.length} files reviewed`}>
              <title>{reviewedFileCount} of {files.length} files reviewed</title>
              <circle className="progress-track" cx="10" cy="10" r="7" />
              <circle className="progress-fill" cx="10" cy="10" r="7" pathLength="100" strokeDasharray="100" strokeDashoffset={100 - (files.length ? reviewedFileCount / files.length * 100 : 0)} transform="rotate(-90 10 10)" />
            </svg>
            <span aria-label={`File ${index + 1} of ${files.length}`}><strong>{index + 1}</strong> / {files.length}</span>
          </div>
          <FileRail entries={entries} index={index} viewedFiles={reviewedFiles} onSelect={selectFile} />
          <div className="file-status">
            {searchControlTarget
              ? createPortal(<button onClick={() => setSearchOpen(true)} title="Find files and symbols (Ctrl/Cmd+F)" aria-label="Find in review">⌕ Find</button>, searchControlTarget)
              : <button onClick={() => setSearchOpen(true)} title="Find files and symbols (Ctrl/Cmd+F)" aria-label="Find in review">⌕ Find</button>}
            {props.progressEndpoint && <span className="change-progress" role="progressbar" aria-label="Change review progress" aria-valuemin={0} aria-valuemax={Math.max(1, fileBlocks.length)} aria-valuenow={progress.ready ? reviewedBlockCount : undefined} aria-valuetext={progress.ready ? `${reviewedBlockCount} of ${fileBlocks.length} changes reviewed` : "Loading review progress"} title={progress.ready ? `${reviewedBlockCount} of ${fileBlocks.length} changes reviewed` : "Loading review progress"}>
              <svg width="16" height="16" viewBox="0 0 20 20" aria-hidden="true"><circle className="progress-track" cx="10" cy="10" r="7" /><circle className="progress-fill" cx="10" cy="10" r="7" pathLength="100" strokeDasharray="100" strokeDashoffset={100 - (fileBlocks.length ? reviewedBlockCount / fileBlocks.length * 100 : 0)} transform="rotate(-90 10 10)" /></svg>
              <span aria-hidden="true">{progress.ready ? `${reviewedBlockCount}/${fileBlocks.length}` : "…"}</span>
            </span>}
            {props.progressEndpoint && <label className="collapse-control" title={props.onSyncReviewed ? "Shared Biff progress, synced with GitHub's Viewed flag" : "Biff progress shared by linked local and PR reviews"}>
              <input type="checkbox" aria-label="File reviewed" checked={isFileReviewed(index)} disabled={!progress.ready || progress.busy || Boolean(props.onSyncReviewed && !props.viewedFiles)} onChange={(event) => void progress.saveFile(index, event.target.checked)} /> Reviewed
            </label>}
          </div>
      </section>

      {props.progressEndpoint && progress.error && <div className="error" role="alert">{progress.error} <button onClick={progress.retry}>Retry loading progress</button></div>}

      {error && !pasteOpen && <div className="error" role="alert">{error}<button onClick={() => setError("")} aria-label="Dismiss error">×</button></div>}

      <div ref={stage} className="file-stage" data-imports-pending={preparedFile.current !== file ? "" : undefined} aria-busy={preparedFile.current !== file}>
      <div className="import-preparing" role="status">Preparing diff…</div>
      <main ref={viewport} className="viewport" aria-label="Diff reading surface" aria-hidden={preparedFile.current !== file ? true : undefined} inert={preparedFile.current !== file} tabIndex={0} onClick={(event) => {
        const origin = event.nativeEvent.composedPath()[0];
        const button = origin instanceof Element ? origin.closest<HTMLElement>("[data-fold-toggle]") : null;
        if (button) setImportExpanded(button.dataset.foldToggle!, button.getAttribute("aria-expanded") !== "true");
      }}>
        <div className="surface">
          {sourceReady && <FileDiff fileDiff={file} options={{
            resolveFoldedRanges,
            theme: "pierre-dark",
            themeType: "dark",
            diffStyle: "unified",
            expandUnchanged: unmodifiedOpen || unmodifiedPeek,
            loadDiffFiles: props.loadDiffFiles ? loadDiffContents : undefined,
            unsafeCSS: "[data-biff-focused] { opacity: 1; outline: 1px solid #bce99e; outline-offset: -1px; box-shadow: inset 3px 0 #bce99e; }",
            onPostRender: onRender,
            lineDiffType: "word-alt",
            diffIndicators: "bars",
            overflow: "wrap",
            disableFileHeader: true,
            hunkSeparators: "line-info",
          }} />}
          <div className="end-note">End of {file.name} · {hunks.length} {hunks.length === 1 ? "hunk" : "hunks"}</div>
        </div>
      </main>
      </div>
      </div>

      {filePickerOpen && <FilePicker files={files} index={index} viewedFiles={reviewedFiles} onSelect={selectFile} onClose={() => setFilePickerOpen(false)} />}
      {searchOpen && <SearchOverlay files={files} query={searchQuery} onQueryChange={setSearchQuery} selected={searchSelection} onSelectedChange={setSearchSelection} loadContents={props.loadDiffFiles ? loadSearchContents : undefined} onSelect={selectSearchResult} onClose={() => setSearchOpen(false)} />}

      {pasteOpen && <div className="modal-backdrop" onClick={() => setPasteOpen(false)}>
        <section className="modal" role="dialog" aria-modal="true" aria-labelledby="paste-title" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => {
          if (event.key === "Escape") setPasteOpen(false);
          if (event.key === "Tab") {
            const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("textarea, button"));
            const next = event.shiftKey ? controls.at(-1) : controls[0];
            const boundary = event.shiftKey ? controls[0] : controls.at(-1);
            if (document.activeElement === boundary) { event.preventDefault(); next?.focus(); }
          }
        }}>
          <h1 id="paste-title">Bring your own diff.</h1>
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
      if (focusRequest.current) return contents;
      const root = viewport.current?.querySelector("diffs-container")?.shadowRoot;
      const selected = root?.querySelector<HTMLElement>("[data-biff-focused]");
      const location = selected && lineLocation(diff, Number(selected.dataset.lineIndex!.split(",")[0]));
      if (location && selected) {
        scrolling.current?.cancel();
        const top = selected.getBoundingClientRect().top;
        focusRequest.current = location;
        pendingScroll.current = false;
        deletionAnchor.current = restore;

        /** Restore by file coordinate after Pierre installs the full-file rows. */
        function restore() {
          const row = Array.from(root?.querySelectorAll<HTMLElement>("[data-line]") ?? []).find((entry) => {
            const candidate = lineLocation(diff, Number(entry.dataset.lineIndex!.split(",")[0]));
            return candidate?.side === location!.side && candidate.line === location!.line;
          });
          if (row && viewport.current) viewport.current.scrollTop += row.getBoundingClientRect().top - top;
        }
      }
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
}

/** Scope the remembered file to this tab's repository and selected revision. */
function fileSelectionKey(): string {
  const url = new URL(window.location.href);
  url.searchParams.sort();
  return `biff:selected-file:${url.pathname}${url.search}`;
}

/** Restore by path rather than index because refreshes can add or reorder files. */
function restoredFileIndex(files: { name: string }[]): number {
  try {
    const name = sessionStorage.getItem(fileSelectionKey());
    return Math.max(0, files.findIndex((file) => file.name === name));
  } catch { return 0; }
}
