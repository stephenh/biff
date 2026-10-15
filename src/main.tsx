import { useEffect, useRef, useState, type CSSProperties } from "react";
import { createRoot } from "react-dom/client";
import { parseInput } from "./patches";
import { FileDiff } from "@pierre/diffs/react";
import demo from "../fixtures/demo.diff?raw";
import patch2 from "../fixtures/graphql-service-9658.diff?raw";
import "./style.css";
import { collapseDeletions } from "./collapseDeletions";

/**
 * Show an inline diff with full-size code and collapsible deleted blocks.
 *
 * Patch parsing stays local to the browser.
 */
function App() {
  const [files, setFiles] = useState(() => parseInput(demo));
  const [index, setIndex] = useState(0);
  const [source, setSource] = useState("Example changes");
  const [fontSize, setFontSize] = useState(22);
  const [collapseOld, setCollapseOld] = useState(true);
  const [error, setError] = useState("");
  const [pasteOpen, setPasteOpen] = useState(false);
  const [patch, setPatch] = useState("");
  const viewport = useRef<HTMLDivElement>(null);
  const upload = useRef<HTMLInputElement>(null);
  const file = files[index];

  /** Parse first so a rejected upload leaves the current review intact. */
  function load(text: string, name: string) {
    try {
      const parsed = parseInput(text);
      setFiles(parsed);
      setIndex(0);
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
    const element = viewport.current;
    if (!element) return;
    element.scrollTop = 0;
  }, [file]);

  useEffect(() => {
    /** Leave native controls and text selection shortcuts alone. */
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target;
      if (pasteOpen || event.ctrlKey || event.metaKey || event.altKey ||
        (target instanceof HTMLElement && target.closest("input, textarea, select, button, [contenteditable]"))) return;

      if (event.key === "j" || event.key === "k") {
        event.preventDefault();
        setIndex((current) => Math.max(0, Math.min(files.length - 1, current + (event.key === "j" ? 1 : -1))));
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [files.length, pasteOpen]);

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
          <button aria-label="Previous file" disabled={index === 0} onClick={() => setIndex(index - 1)}>↑</button>
          <button aria-label="Next file" disabled={index === files.length - 1} onClick={() => setIndex(index + 1)}>↓</button>
          <select aria-label="Current file" value={index} onChange={(event) => setIndex(Number(event.target.value))}>
            {files.map((entry, entryIndex) => <option key={entryIndex} value={entryIndex}>{entry.name}</option>)}
          </select>
          <span className="muted">{index + 1} / {files.length}</span>
        </div>
        <div className="review-controls">
          <label className="collapse-control"><input type="checkbox" checked={collapseOld} onChange={(event) => setCollapseOld(event.target.checked)} />Collapse deleted lines</label>
          <span className="hints"><kbd>j</kbd> <kbd>k</kbd> files</span>
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
            onPostRender: (node, _instance, phase) => {
              collapseDeletions(node, phase !== "unmount" && collapseOld);
            },
            lineDiffType: "word-alt",
            diffIndicators: "bars",
            overflow: "wrap",
            disableFileHeader: true,
            hunkSeparators: "line-info",
          }} />
          <div className="end-note">End of {file.name} · {file.hunks.length} {file.hunks.length === 1 ? "hunk" : "hunks"}</div>
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
