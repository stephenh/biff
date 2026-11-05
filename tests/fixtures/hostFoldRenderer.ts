import { hydratePartialDiff, parseDiffFromFile, VirtualizedFileDiff, Virtualizer, type FileDiffMetadata, type FileDiffOptions } from "@pierre/diffs";
import { deletionFolds } from "../../src/deletionFolds";
import { parseInput } from "../../src/patches";

const rendererOptions: FileDiffOptions<undefined, undefined> = { diffStyle: "unified", overflow: "wrap", disableFileHeader: true, expandUnchanged: true };

/** Exercise the patched renderer directly, without Viewer or post-render scroll repairs. */
export function mountHostFoldRenderer(chosenAnchor: boolean) {
  const oldSource = Array.from({ length: 1000 }, (_, index) => `const old${index} = ${index};\n`).join("");
  const context = Array.from({ length: 5 }, (_, index) => `const context${index} = ${index};\n`).join("");
  const second = Array.from({ length: 20 }, (_, index) => `const removed${index} = ${index};\n`).join("");
  const tail = Array.from({ length: 1000 }, (_, index) => `const tail${index} = ${index};\n`).join("");
  const file = parseDiffFromFile({ name: "file.ts", contents: `${oldSource}${context}${second}${tail}` }, { name: "file.ts", contents: `const replacement = 1;\n${context}const second = 1;\n${tail}` });
  let firstOpen = true;
  let currentOptions = options();
  const { instance, virtualizer, container } = mountRenderer(file, currentOptions);

  return {
    /** Initial positioning is navigation, not a layout-restoration callback. */
    position() {
      const bounds = instance.getLinePosition(1)!;
      virtualizer.scrollTo({ top: (instance.top ?? 0) + bounds.top - (chosenAnchor ? 140 : 350), behavior: "instant" });
    },
    change() {
      firstOpen = !firstOpen;
      currentOptions = options();
      instance.setOptions(currentOptions);
      instance.render({ fileDiff: file, fileContainer: container });
    },
    changeQueued() {
      firstOpen = !firstOpen;
      currentOptions = options();
      instance.setOptions(currentOptions);
    },
    paint() {
      currentOptions = { ...currentOptions, unsafeCSS: "[data-line] { color: inherit; }" };
      instance.setOptions(currentOptions);
      instance.render({ fileDiff: file, fileContainer: container });
    },
  };

  /** Change both projected heights so a center-row anchor differs from the chosen row. */
  function options(): FileDiffOptions<undefined, undefined> {
    const open = firstOpen;
    return {
      ...rendererOptions,
      resolveFoldedRanges: () => deletionFolds(file, []).map((fold, index) => ({ ...fold, expanded: index === 0 ? open : !open })),
      getLayoutAnchor: chosenAnchor ? () => ({ line: 1, side: "additions", offset: 140 }) : undefined,
    };
  }
}

/** Hydration must retain the old side when preceding additions offset new-file coordinates. */
export function mountHydrationRenderer() {
  const file = parseInput("diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n@@ -500 +500,2 @@\n-const value499 = 499;\n+const first = 1;\n+const extra = 2;\n@@ -900 +900,0 @@\n-const value899 = 899;\n")[0];
  const oldLines = Array.from({ length: 1000 }, (_, index) => `const value${index} = ${index};\n`);
  const newLines = [...oldLines];
  newLines.splice(499, 1, "const first = 1;\n", "const extra = 2;\n");
  newLines.splice(900, 1);
  const options: FileDiffOptions<undefined, undefined> = { ...rendererOptions, expandUnchanged: false, getLayoutAnchor: () => ({ line: 900, side: "deletions", offset: 140 }) };
  const { instance, virtualizer, container } = mountRenderer(file, options);
  return {
    position() {
      const bounds = instance.getLinePosition(900, "deletions")!;
      virtualizer.scrollTo({ top: (instance.top ?? 0) + bounds.top - 140, behavior: "instant" });
    },
    change() {
      const hydrated = hydratePartialDiff("clone", file, { oldFile: { name: file.name, contents: oldLines.join("") }, newFile: { name: file.name, contents: newLines.join("") } });
      instance.setOptions({ ...options, expandUnchanged: true });
      instance.render({ fileDiff: hydrated, fileContainer: container });
    },
  };
}

/** Mount only Pierre's native virtual window; deliberately install no onPostRender callback. */
function mountRenderer(file: FileDiffMetadata, options: FileDiffOptions<undefined, undefined>) {
  const viewport = document.createElement("div");
  viewport.style.cssText = "position:fixed;inset:0;height:700px;overflow:auto;overflow-anchor:none";
  const surface = document.createElement("div");
  // Leave room to place even the final source row off-center without scroll clamping.
  surface.style.paddingBlock = "700px";
  const container = document.createElement("diffs-container");
  surface.append(container);
  viewport.append(surface);
  document.body.replaceChildren(viewport);

  const virtualizer = new Virtualizer({ overscrollSize: 600 });
  virtualizer.setup(viewport);
  const instance = new VirtualizedFileDiff({ ...rendererOptions, ...options }, virtualizer, { lineHeight: 20 });
  instance.render({ fileDiff: file, fileContainer: container });
  return { instance, virtualizer, container };
}
