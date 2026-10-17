import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { parseInput } from "./patches";
import { groupFiles } from "./fileOrder";
import { FileDiff } from "@pierre/diffs/react";
import type { FileDiffContentsLoader, FileDiffOptions } from "@pierre/diffs";
import "./style.css";
import { collapseDeletions, isCollapsedDeletion } from "./collapseDeletions";
import { installClickSelection } from "./clickSelection";
import { captureLineAnchor } from "./lineAnchor";
import { changeStarts, lineLocation, nextHunk, type HunkPosition } from "./navigation";
import type { FileViewedState, ReviewLine } from "../shared/types";
import { syncLineComments, type CommentSelection, type LineThread } from "./lineComments";
import { CollapseDeletedContext } from "./Settings";
import { FileRail } from "./FileRail";
import { prepareFileSlide, type FileSlide } from "./fileSlide";
import { createSmoothScroll, type SmoothScroll } from "./smoothScroll";
import { useStableCallback } from "./useStableCallback";

export interface ViewerProps {
  /** Backend reviews already hide whitespace; only raw imports need filtering. */
  whitespaceHidden?: boolean;
  patch: string;
  source?: string;
  allowImport?: boolean;
  onSelectLine?: (line: ReviewLine) => void;
  focus?: ReviewLine & { request: number };
  viewedFiles?: Record<string, FileViewedState>;
  fileControls?: (path: string) => ReactNode;
  onMarkViewed?: (path: string) => Promise<boolean>;
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
  const [entries, setEntries] = useState(() => groupFiles(parseInput(props.patch, props.whitespaceHidden)));
  const files = useMemo(() => entries.map((entry) => entry.file), [entries]);
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
  const [patch, setPatch] = useState("");
  const viewport = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const fileSlide = useRef<{ file: typeof files[number]; slide: FileSlide } | undefined>(undefined);
  const focusRequest = useRef<ReviewLine | undefined>(undefined);
  const upload = useRef<HTMLInputElement>(null);
  const pendingScroll = useRef(true);
  const markingViewed = useRef(false);
  const navigationVersion = useRef(0);
  const file = files[index];
  const lastScrolledFile = useRef<typeof file | null>(null);
  const scrolling = useRef<SmoothScroll | undefined>(undefined);
  const followLine = useRef(false);
  const hunks = changeStarts(file);
  const onRender = useStableCallback<Parameters<NonNullable<FileDiffOptions<undefined, undefined>["onPostRender"]>>, void>((node, _instance, phase) => {
    collapseDeletions(node, phase !== "unmount" && collapseOld,
      nearbyOpen || deletionPeek ? position.lineIndex ?? hunks[position.hunkIndex] : undefined);
    if (phase !== "unmount") {
      deletionAnchor.current?.();
      deletionAnchor.current = undefined;
      scrollToHunk();
      syncLineComments(node, file, props.inlineThreads ?? [], props.onOpenComments);
      if (fileSlide.current?.file === file) fileSlide.current.slide.play();
    }
  });
  const loadDiffContents = useStableCallback(loadContext);

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

  /** Capture before changing files; finish interrupted movement before the next slide. */
  function slideToFile(fileIndex: number) {
    if (fileIndex === index || !stage.current || !viewport.current) return;
    fileSlide.current?.slide.cancel();
    fileSlide.current = undefined;
    const slide = prepareFileSlide(stage.current, viewport.current, fileIndex > index ? 1 : -1);
    if (slide) fileSlide.current = { file: files[fileIndex], slide };
  }

  /** Deletion visibility changes preserve the selected line, even when off-center. */
  function anchorDeletions() {
    scrolling.current?.cancel();
    deletionAnchor.current = captureLineAnchor(viewport.current?.querySelector("diffs-container")?.shadowRoot);
    pendingScroll.current = false;
  }

  /** File selection starts at its first hunk, independently of keyboard navigation. */
  function selectFile(fileIndex: number, animate = true) {
    followLine.current = false;
    scrolling.current?.cancel();
    if (animate) slideToFile(fileIndex);
    navigationVersion.current++;
    resetDeletionVisibility();
    pendingScroll.current = true;
    setPosition({ fileIndex, hunkIndex: 0 });
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
    followLine.current = false;
    if (next.fileIndex !== index) scrolling.current?.cancel();
    slideToFile(next.fileIndex);
    navigationVersion.current++;
    if (next.fileIndex !== index) resetDeletionVisibility();
    pendingScroll.current = true;
    setPosition(next);
  }

  /** Advance only after the current file's Viewed mark has been saved. */
  async function markViewedAndNext() {
    if (!props.onMarkViewed || markingViewed.current) return;
    markingViewed.current = true;
    const version = navigationVersion.current;
    try {
      const saved = await props.onMarkViewed(file.name);
      // A slow network response must not redirect a reader who has navigated away.
      if (saved && version === navigationVersion.current && index + 1 < files.length) selectFile(index + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not mark file viewed.");
    } finally {
      markingViewed.current = false;
    }
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
    const lineIndex = position.lineIndex ?? changeStarts(file)[position.hunkIndex];
    if (lineIndex === undefined) {
      scrolling.current?.cancel();
      element.scrollTop = 0;
      pendingScroll.current = false;
      return;
    }
    const root = element.querySelector("diffs-container")?.shadowRoot;
    if (focusRequest.current && root) {
      const request = focusRequest.current;
      const match = Array.from(root.querySelectorAll<HTMLElement>("[data-line]")).find((row) => {
        const location = lineLocation(file, Number(row.dataset.lineIndex!.split(",")[0]));
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
        setError("That comment's line is outside the context included in this diff.");
      }
    }
    const line = root?.querySelector<HTMLElement>(`[data-line][data-line-index^="${lineIndex},"]`);
    if (!line) return;
    for (const previous of root!.querySelectorAll("[data-biff-focused]")) previous.removeAttribute("data-biff-focused");
    line.setAttribute("data-biff-focused", "");
    const location = lineLocation(file, lineIndex);
    if (location) props.onSelectLine?.(location);
    if (!pendingScroll.current) return;
    const bounds = line.getBoundingClientRect();
    // Animate navigation within a file, but avoid sweeping through unrelated code
    // when opening a new file. Repeated keypresses share one moving scroll target.
    const smooth = lastScrolledFile.current === file && !matchMedia("(prefers-reduced-motion: reduce)").matches;
    const openingAtStart = lastScrolledFile.current !== file && position.hunkIndex === 0 && position.lineIndex === undefined;
    const content = element.querySelector("diffs-container")!;
    // Skip the centering spacer on file load so code starts beside the picker.
    const top = openingAtStart
      ? element.scrollTop + content.getBoundingClientRect().top - element.getBoundingClientRect().top - 8
      : element.scrollTop + bounds.top + bounds.height / 2 - element.getBoundingClientRect().top - element.clientHeight / 2;
    scrolling.current ??= createSmoothScroll(element);
    if (followLine.current) scrolling.current.follow(top, smooth);
    else scrolling.current.to(top, smooth);
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
    const container = viewport.current?.querySelector<HTMLElement>("diffs-container");
    if (container) {
      // Cursor-only navigation must not ask Pierre to re-render every code column.
      // Only the nearby-deletion mode needs to change row layout as the cursor moves.
      if (nearbyOpen || deletionPeek) collapseDeletions(container, collapseOld, position.lineIndex ?? hunks[position.hunkIndex]);
    }
    scrollToHunk();
  }, [file, position, nearbyOpen, deletionPeek, unmodifiedOpen, unmodifiedPeek]);

  useLayoutEffect(() => {
    const container = viewport.current?.querySelector<HTMLElement>("diffs-container");
    if (container) {
      collapseDeletions(container, collapseOld, nearbyOpen || deletionPeek ? position.lineIndex ?? hunks[position.hunkIndex] : undefined);
      deletionAnchor.current?.();
      deletionAnchor.current = undefined;
    }
  }, [collapseOld, nearbyOpen, deletionPeek]);

  useEffect(() => {
    const container = viewport.current?.querySelector<HTMLElement>("diffs-container");
    if (container) syncLineComments(container, file, props.inlineThreads ?? [], props.onOpenComments);
  }, [file, props.inlineThreads, props.onOpenComments]);

  useEffect(() => {
    if (!props.focus) return;
    const fileIndex = files.findIndex((entry) => entry.name === props.focus!.path || entry.prevName === props.focus!.path);
    if (fileIndex < 0) return;
    focusRequest.current = props.focus;
    selectFile(fileIndex);
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
      if (pasteOpen || document.querySelector("[data-comment-overlay], [popover]:popover-open") || event.ctrlKey || event.metaKey || event.altKey ||
        (target instanceof HTMLElement && target.closest("input, textarea, select, [contenteditable]"))) return;

      if (event.key === "c" && props.onOpenComments) {
        const button = viewport.current?.querySelector("diffs-container")?.shadowRoot?.querySelector<HTMLButtonElement>("[data-biff-focused] [data-biff-comments] button");
        if (button) {
          event.preventDefault();
          if (!event.repeat) button.click();
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
      } else if (event.key === "J" || event.key === "K") {
        event.preventDefault();
        navigateTo(nextHunk(files, position, event.key === "J" ? 1 : -1));
      } else if (event.key === "j" || event.key === "k") {
        event.preventDefault();
        moveLine(event.key === "j" ? 1 : -1);
      } else if (event.key === "N" && props.onMarkViewed) {
        event.preventDefault();
        if (!event.repeat) void markViewedAndNext();
      } else if (event.key === "n" || event.key === "p" || event.key === "ArrowRight" || event.key === "ArrowLeft") {
        event.preventDefault();
        const fileIndex = index + (event.key === "n" || event.key === "ArrowRight" ? 1 : -1);
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
  }, [files, pasteOpen, position, props.onOpenComments, props.onMarkViewed, props.loadDiffFiles]);

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
          <FileRail entries={entries} index={index} viewedFiles={props.viewedFiles} onSelect={selectFile} />
          <div className="file-status">
            <div className="file-counts">
              <span className="muted">{index + 1} / {files.length}</span>
            </div>
            {props.fileControls?.(file.name)}
          </div>
      </section>

      {error && !pasteOpen && <div className="error" role="alert">{error}<button onClick={() => setError("")} aria-label="Dismiss error">×</button></div>}

      <div ref={stage} className="file-stage">
      <main ref={viewport} className="viewport" aria-label="Diff reading surface" tabIndex={0}>
        <div className="surface">
          <FileDiff fileDiff={file} options={{
            theme: "pierre-dark",
            themeType: "dark",
            diffStyle: "unified",
            expandUnchanged: unmodifiedOpen || unmodifiedPeek,
            loadDiffFiles: props.loadDiffFiles ? loadDiffContents : undefined,
            unsafeCSS: "[data-biff-focused] { outline: 1px solid #bce99e; outline-offset: -1px; box-shadow: inset 3px 0 #bce99e; }",
            onPostRender: onRender,
            lineDiffType: "word-alt",
            diffIndicators: "bars",
            overflow: "wrap",
            disableFileHeader: true,
            hunkSeparators: "line-info",
          }} />
          <div className="end-note">End of {file.name} · {hunks.length} {hunks.length === 1 ? "hunk" : "hunks"}</div>
        </div>
      </main>
      </div>
      </div>

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
      const contents = await props.loadDiffFiles!(diff);
      if (version !== navigationVersion.current) return contents;
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
