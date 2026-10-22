import { DiffHunksRenderer, type FileDiffMetadata } from "@pierre/diffs";
import { recordFileTiming } from "./diffMetrics";

/** Visible and speculative renders must use the same highlighting options to share tokens. */
export const diffHighlightOptions = { theme: "pierre-dark", lineDiffType: "word-block", cacheHighlights: true } as const;

/**
 * Prepare each file once across the review, yielding between files so navigation can run.
 *
 * Do not restart on file switches. An open file shares the same token cache and
 * can prepare itself first; failures here stay retryable in the visible renderer.
 */
export function warmDiffHighlights(files: FileDiffMetadata[]): () => void {
  let stopped = false;
  let next = 0;
  let timer: ReturnType<typeof setTimeout>;

  /** Finish one file before queuing another turn on the browser event loop. */
  async function warmNext() {
    if (stopped || next >= files.length) return;
    const file = files[next++];
    if (file.hunks.length) {
      const started = performance.now();
      const renderer = new DiffHunksRenderer({ ...diffHighlightOptions, onDiffTiming: (timing) => recordFileTiming(file, { ...timing, pass: `prewarm ${timing.pass ?? "rows"}` }) });
      try {
        await renderer.asyncRender(file);
        recordFileTiming(file, { phase: "highlight prewarm (inclusive)", durationMs: performance.now() - started, outcome: "ready" });
      } catch {
        recordFileTiming(file, { phase: "highlight prewarm (inclusive)", durationMs: performance.now() - started, outcome: "failed; retry on open" });
      } finally { renderer.cleanUp(); }
    }
    if (!stopped) timer = setTimeout(() => void warmNext(), 0);
  }

  timer = setTimeout(() => void warmNext(), 0);
  return () => { stopped = true; clearTimeout(timer); };
}
