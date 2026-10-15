import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createRoot } from "react-dom/client";
import { parseInput } from "./patches";
import { FileDiff } from "@pierre/diffs/react";
import demo from "../fixtures/demo.diff?raw";
import patch2 from "../fixtures/graphql-service-9658.diff?raw";
import "./style.css";
import { collapseDeletions, isCollapsedDeletion } from "./collapseDeletions";
import { installHoverSelection } from "./hoverSelection";
import { captureLineAnchor } from "./lineAnchor";
import { changeStarts, nextHunk, type HunkPosition } from "./navigation";

/**
 * Show an inline diff with full-size code and collapsible deleted blocks.
 *
 * Patch parsing stays local to the browser.
 */
function App() {
  const [files, setFiles] = useState(() => parseInput(demo));
  const [position, setPosition] = useState<HunkPosition>({ fileIndex: 0, hunkIndex: 0 });
  const index = position.fileIndex;
  const [source, setSource] = useState("Example changes");
  const [fontSize, setFontSize] = useState(22);
  const [collapseOld, setCollapseOld] = useState(true);
  const [nearbyOpen, setNearbyOpen] = useState(false);
  const [deletionPeek, setDeletionPeek] = useState(false);
  const deletionPress = useRef(false);
  const deletionAnchor = useRef<(() => void) | undefined>(undefined);
  const [error, setError] = useState("");
  const [pasteOpen, setPasteOpen] = useState(false);
  const [patch, setPatch] = useState("");
  const viewport = useRef<HTMLDivElement>(null);
  const upload = useRef<HTMLInputElement>(null);
  const pendingScroll = useRef(true);
  const file = files[index];
  const lastScrolledFile = useRef<typeof file | null>(null);
  const hunks = useMemo(() => changeStarts(file), [file]);

  /** Deletion visibility changes preserve the selected line, even when off-center. */
  function anchorDeletions() {
    deletionAnchor.current = captureLineAnchor(viewport.current?.querySelector("diffs-container")?.shadowRoot);
    pendingScroll.current = false;
  }

  /** File selection starts at its first hunk, independently of keyboard navigation. */
  function selectFile(fileIndex: number) {
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
  }

  /** Cross-file navigation starts with that file's normal collapsed view. */
  function navigateTo(next: HunkPosition) {
    if (next.fileIndex !== index) resetDeletionVisibility();
    pendingScroll.current = true;
    setPosition(next);
  }

  /** Step through readable rows, skipping collapsed deletion strips. */
  function moveLine(direction: 1 | -1) {
    const root = viewport.current?.querySelector("diffs-container")?.shadowRoot;
    const rows = Array.from(root?.querySelectorAll<HTMLElement>("[data-line]") ?? [])
      .filter((row) => row.getBoundingClientRect().height > 0);
    const current = rows.findIndex((row) => row.hasAttribute("data-biff-focused"));
    let next = current + direction;
    while (rows[next] && isCollapsedDeletion(rows[next])) next += direction;
    const target = rows[next];
    if (!target) return;

    const lineIndex = Number(target.dataset.lineIndex!.split(",")[0]);
    selectLine(lineIndex, true);
  }

  /** Share the navigation cursor between mouse selection and keyboard movement. */
  function selectLine(lineIndex: number, center: boolean) {
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
    const lineIndex = position.lineIndex ?? hunks[position.hunkIndex];
    if (lineIndex === undefined) {
      element.scrollTop = 0;
      pendingScroll.current = false;
      return;
    }
    const root = element.querySelector("diffs-container")?.shadowRoot;
    const line = root?.querySelector<HTMLElement>(`[data-line][data-line-index^="${lineIndex},"]`);
    if (!line) return;
    for (const previous of root!.querySelectorAll("[data-biff-focused]")) previous.removeAttribute("data-biff-focused");
    line.setAttribute("data-biff-focused", "");
    if (!pendingScroll.current) return;
    const bounds = line.getBoundingClientRect();
    // Animate navigation within a file, but avoid sweeping through unrelated code
    // when opening a new file. Native scrolling also retargets repeated keypresses.
    const smooth = lastScrolledFile.current === file && !matchMedia("(prefers-reduced-motion: reduce)").matches;
    element.scrollTo({
      top: element.scrollTop + bounds.top + bounds.height / 2 - element.getBoundingClientRect().top - element.clientHeight / 2,
      behavior: smooth ? "smooth" : "instant",
    });
    lastScrolledFile.current = file;
    pendingScroll.current = false;
  }

  /** Parse first so a rejected upload leaves the current review intact. */
  function load(text: string, name: string) {
    try {
      const parsed = parseInput(text);
      setFiles(parsed);
      selectFile(0);
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
  }, [file, position, nearbyOpen, deletionPeek]);

  useEffect(() => {
    if (!viewport.current || pasteOpen) return;
    return installHoverSelection(viewport.current, (lineIndex) => selectLine(lineIndex, false));
  }, [file, pasteOpen]);

  useEffect(() => {
    /** Leave native controls and text selection shortcuts alone. */
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target;
      if (pasteOpen || event.ctrlKey || event.metaKey || event.altKey ||
        (target instanceof HTMLElement && target.closest("input, textarea, select, [contenteditable]"))) return;

      if (event.key === "d" || event.key === "D") {
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
      } else if (event.key === "J" || event.key === "K") {
        event.preventDefault();
        navigateTo(nextHunk(files, position, event.key === "J" ? 1 : -1));
      } else if (event.key === "j" || event.key === "k") {
        event.preventDefault();
        moveLine(event.key === "j" ? 1 : -1);
      } else if (event.key === "n" || event.key === "p") {
        event.preventDefault();
        const fileIndex = index + (event.key === "n" ? 1 : -1);
        if (fileIndex >= 0 && fileIndex < files.length) navigateTo({ fileIndex, hunkIndex: 0 });
      }
    }

    /** Shift+D restores the toggle state when either key is released. */
    function onKeyUp(event: KeyboardEvent) {
      if (!deletionPress.current || (event.code !== "KeyD" && event.key !== "Shift")) return;
      deletionPress.current = false;
      anchorDeletions();
      setDeletionPeek(false);
    }

    /** A lost keyup must not leave temporary deletions stuck open. */
    function endDeletionPeek() {
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
  }, [files, pasteOpen, position]);

  return (
    <div className="app" onDragOver={(event) => event.preventDefault()} onDrop={(event) => {
      event.preventDefault();
      if (event.dataTransfer.files.length) void openFiles(Array.from(event.dataTransfer.files));
    }}>
      <header>
        <a className="brand" href="/" aria-label="Biff home">biff<span>big diff. easy eyes.</span></a>
        <div className="actions">
          <button onClick={() => upload.current?.click()}>Open patch</button>
          <button onClick={() => setPasteOpen(true)}>Paste diff</button>
          <nav className="examples" aria-label="Preloaded patches">
            <button className="example-link" onClick={() => load(demo, "patch1 · Example changes")}>patch1</button>
            <button className="example-link" title="homebound-team/graphql-service #9658" onClick={() => load(patch2, "patch2 · graphql-service #9658")}>patch2</button>
          </nav>
          <label className="font-control">Text <input aria-label="Text size" type="range" min="16" max="34" value={fontSize} onChange={(event) => setFontSize(Number(event.target.value))} /><span>{fontSize}px</span></label>
        </div>
        <input hidden ref={upload} type="file" multiple accept=".diff,.patch,text/plain" onChange={(event) => {
          if (event.target.files?.length) void openFiles(Array.from(event.target.files));
          event.target.value = "";
        }} />
      </header>

      <section className="filebar" aria-label="File navigation">
        <div className="file-picker">
          <button aria-label="Previous file" disabled={index === 0} onClick={() => selectFile(index - 1)}>↑</button>
          <button aria-label="Next file" disabled={index === files.length - 1} onClick={() => selectFile(index + 1)}>↓</button>
          <select aria-label="Current file" value={index} onChange={(event) => selectFile(Number(event.target.value))}>
            {files.map((entry, entryIndex) => <option key={entryIndex} value={entryIndex}>{entry.name}</option>)}
          </select>
          <span className="muted">{index + 1} / {files.length}</span>
          <span className="muted" aria-label="Current hunk">Hunk {hunks.length ? position.hunkIndex + 1 : 0} / {hunks.length}</span>
        </div>
        <div className="review-controls">
          <label className="collapse-control"><input type="checkbox" checked={collapseOld} onChange={(event) => { anchorDeletions(); setCollapseOld(event.target.checked); }} />Collapse deleted lines</label>
          <span className="hints"><kbd>j</kbd> <kbd>k</kbd> lines · <kbd>⇧J</kbd> <kbd>⇧K</kbd> changes · <kbd>n</kbd> <kbd>p</kbd> files · <kbd>d</kbd> toggle · <kbd>⇧D</kbd> peek</span>
        </div>
      </section>

      {error && !pasteOpen && <div className="error" role="alert">{error}<button onClick={() => setError("")} aria-label="Dismiss error">×</button></div>}

      <main ref={viewport} className="viewport" aria-label="Diff reading surface" tabIndex={0}>
        <div className="surface" style={{ "--diffs-font-size": `${fontSize}px`, "--diffs-line-height": `${Math.round(fontSize * 1.6)}px` } as CSSProperties}>
          <div className="inline-label"><span>AFTER <small>with compact deletions</small></span><span className="source" title={source}>{source}</span></div>
          <FileDiff fileDiff={file} options={{
            theme: "pierre-dark",
            themeType: "dark",
            diffStyle: "unified",
            unsafeCSS: "[data-biff-focused] { outline: 1px solid #bce99e; outline-offset: -1px; box-shadow: inset 3px 0 #bce99e; }",
            onPostRender: (node, _instance, phase) => {
              collapseDeletions(node, phase !== "unmount" && collapseOld,
                nearbyOpen || deletionPeek ? position.lineIndex ?? hunks[position.hunkIndex] : undefined);
              if (phase !== "unmount") {
                deletionAnchor.current?.();
                deletionAnchor.current = undefined;
                scrollToHunk();
              }
            },
            lineDiffType: "word-alt",
            diffIndicators: "bars",
            overflow: "wrap",
            disableFileHeader: true,
            hunkSeparators: "line-info",
          }} />
          <div className="end-note">End of {file.name} · {hunks.length} {hunks.length === 1 ? "hunk" : "hunks"}</div>
        </div>
      </main>

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
}

createRoot(document.getElementById("root")!).render(<App />);
