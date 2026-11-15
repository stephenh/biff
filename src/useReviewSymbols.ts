import { useEffect, useMemo, useState } from "react";
import type { FileDiffMetadata } from "@pierre/diffs";
import type { SymbolIndex } from "../shared/symbols";

export interface ReviewSymbolSource { endpoint: string; head: string; base?: string; single?: boolean }
const emptyIndex: SymbolIndex = { symbols: [], completed: 0, total: 0, state: "indexing", errors: [] };

/**
 * Begin speculative work only after the viewer has painted.
 *
 * Poll a separate job without loading source text, and prevent old comparisons from
 * populating the current index when navigation or a refresh replaces the review.
 */
export function useReviewSymbols(source: ReviewSymbolSource | undefined, files: FileDiffMetadata[], painted: boolean) {
  const manifest = useMemo(() => painted && source ? files.map((file) => ({ path: file.name, oldPath: file.prevName ?? file.name })) : [], [files, painted, Boolean(source)]);
  const body = useMemo(() => JSON.stringify({ head: source?.head, base: source?.base, single: source?.single, files: manifest }), [source?.head, source?.base, source?.single, manifest]);
  const endpoint = source?.endpoint;
  const [result, setResult] = useState<{ key: string; index: SymbolIndex }>();
  const [attempt, setAttempt] = useState(0);
  const key = useMemo(() => `${endpoint}:${body}`, [endpoint, body]);

  useEffect(() => {
    if (!endpoint || !painted) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let retry = attempt > 0;
    let busy = false;
    let finished = false;
    /** Poll the admitted job without fetching or parsing full source in the browser. */
    async function poll() {
      if (controller.signal.aborted || busy || finished || document.visibilityState === "hidden") return;
      clearTimeout(timer);
      busy = true;
      try {
        const response = await fetch(endpoint!, { method: "POST", headers: { "Content-Type": "application/json" },
          body: retry ? JSON.stringify({ ...JSON.parse(body), retry: true }) : body, signal: controller.signal });
        if (!response.ok) throw new Error((await response.json()).error ?? "Could not index review symbols");
        const index: unknown = await response.json();
        if (!isSymbolIndex(index)) throw new Error("Invalid symbol index response");
        if (controller.signal.aborted) return;
        setResult((previous) => previous?.key === key && previous.index.completed === index.completed
          && previous.index.state === index.state && previous.index.errors.join("\n") === index.errors.join("\n") ? previous : { key, index });
        retry = false;
        finished = index.state !== "indexing";
        if (index.state === "indexing") timer = setTimeout(() => void poll(), 750);
      } catch (error) {
        if (!controller.signal.aborted) {
          finished = true;
          setResult((previous) => ({ key, index: { ...(previous?.key === key ? previous.index : emptyIndex),
            state: "failed", errors: [error instanceof Error ? error.message : String(error)] } }));
        }
      } finally { busy = false; }
    }
    // The first diff is already visible; leave a quiet interval for its interactive source requests.
    timer = setTimeout(() => void poll(), 150);
    document.addEventListener("visibilitychange", poll);
    return () => { controller.abort(); clearTimeout(timer); document.removeEventListener("visibilitychange", poll); };
  }, [endpoint, body, painted, attempt, key]);

  return { index: result?.key === key ? result.index : { ...emptyIndex, total: files.length }, retry: () => setAttempt((value) => value + 1),
    scope: `symbols:${endpoint}:${source?.head}:${source?.base}:${source?.single === true}` };
}

/** A stale server or malformed response must report failure, not break the reading surface. */
function isSymbolIndex(value: unknown): value is SymbolIndex {
  if (!value || typeof value !== "object") return false;
  const index = value as Partial<SymbolIndex>;
  return Array.isArray(index.symbols) && Array.isArray(index.errors) && index.errors.every((error) => typeof error === "string")
    && Number.isSafeInteger(index.completed) && Number.isSafeInteger(index.total)
    && ["indexing", "complete", "failed"].includes(index.state ?? "");
}
