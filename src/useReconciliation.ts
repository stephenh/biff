import { useEffect, useState } from "react";
import type { ReconciliationStatus } from "../shared/reconciliation";
import { post, request } from "./api";

/** Poll one review inventory; navigation changes polling speed, not the API's scope. */
export function useReconciliation(endpoint: string | undefined, head: string | undefined, base: string | null, file: string) {
  const [result, setResult] = useState<{ endpoint: string; status: ReconciliationStatus }>();
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const status = result && result.endpoint === endpoint && result.status.head === head && result.status.base === base ? result.status : undefined;

  useEffect(() => {
    if (!endpoint || status?.state === "ready") return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let busy = false;
    let finished = false;
    setError("");

    /** Never overlap requests or poll a hidden tab; terminal states require explicit retry. */
    async function poll() {
      if (busy || finished || controller.signal.aborted || document.visibilityState === "hidden") return;
      clearTimeout(timer);
      busy = true;
      try {
        const next = await request<ReconciliationStatus>(`${endpoint}/reconciliation`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        if (next.head !== head || next.base !== base) {
          setError("This review comparison changed. Refresh the page to load the latest diff.");
          finished = true;
          return;
        }
        setResult({ endpoint: endpoint!, status: next });
        finished = next.state === "ready" || next.state === "failed";
        if (!finished) timer = setTimeout(() => void poll(), next.files[file] === "ready" ? 2000 : 500);
      } catch (cause) {
        if (!controller.signal.aborted) { setError(cause instanceof Error ? cause.message : String(cause)); finished = true; }
      } finally { busy = false; }
    }

    void poll();
    document.addEventListener("visibilitychange", poll);
    return () => { controller.abort(); clearTimeout(timer); document.removeEventListener("visibilitychange", poll); };
  }, [endpoint, head, base, file, attempt]);

  /** Retry the same comparison without remounting the diff or discarding pending user work. */
  async function retry() {
    if (!endpoint) return;
    try {
      await post(`${endpoint}/reconciliation`, {});
      window.dispatchEvent(new CustomEvent("biff-reconciliation-retry", { detail: endpoint }));
      setAttempt((value) => value + 1);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  return { status, ready: !endpoint || status?.files[file] === "ready", complete: !endpoint || status?.state === "ready", error: error || status?.error, retry };
}
