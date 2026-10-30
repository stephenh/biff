import { useEffect, useRef, useState } from "react";
import { useActivity } from "./activity";

/** Decode API errors without replacing useful jj/gh diagnostics with a generic failure. */
export async function request<T>(url: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(url, options);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body as T;
}

export async function post<T>(url: string, body: unknown, headers: Record<string, string> = {}): Promise<T> {
  return request<T>(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
}

/** Abort obsolete loads so a slow previous source cannot overwrite the current review. */
export function useResource<T>(url: string | null) {
  const [state, setState] = useState<{ url?: string | null; data?: T; error?: string; loading: boolean }>({ url, loading: Boolean(url) });
  const visible: typeof state = state.url === url ? state : { loading: Boolean(url) };
  const [version, setVersion] = useState(0);
  const quiet = useRef(false);
  useEffect(() => { quiet.current = false; }, [url]);
  const activity = useActivity({ scope: url ? `load:${url}` : undefined, label: resourceLabel(url), loading: visible.loading && !quiet.current, error: visible.error, retry: refresh });
  useEffect(() => {
    if (!url) { setState({ url, loading: false }); return; }
    const controller = new AbortController();
    setState((current) => ({ ...(current.url === url ? current : {}), url, loading: true }));
    request<T>(url, { signal: controller.signal }).then(
      (data) => { if (!controller.signal.aborted) setState({ url, data, loading: false }); },
      (error: Error) => { if (!controller.signal.aborted) setState((current) => ({ ...current, url, error: error.message, loading: false })); },
    );
    return () => controller.abort();
  }, [url, version]);
  useEffect(() => {
    /** Failed state reads can resume after the shared reconciliation prerequisite is retried. */
    function retryReconciliation(event: Event) {
      if (state.error && url?.startsWith(`${(event as CustomEvent<string>).detail}/`)) refresh();
    }
    window.addEventListener("biff-reconciliation-retry", retryReconciliation);
    return () => window.removeEventListener("biff-reconciliation-retry", retryReconciliation);
  }, [url, state.error]);
  function refresh() { quiet.current = false; setVersion((current) => current + 1); }
  /** Routine polling reports failures but does not make the app look perpetually busy. */
  function refreshQuiet() { quiet.current = true; setVersion((current) => current + 1); }
  return { ...visible, refresh, refreshQuiet, activity, version };
}

/** Use domain labels rather than raw API URLs in shared activity details. */
function resourceLabel(url: string | null): string {
  if (!url) return "Load data";
  const path = url.split("?")[0];
  const action = path.split("/").at(-1)!;
  const names: Record<string, string> = { review: "Load review", progress: "Load review progress", "follow-ups": "Load follow-ups", "comment-reads": "Load comment read state", conversation: "Load GitHub comments", discussion: "Load local comments", status: "Refresh PR status", stack: "Load PR stack", identity: "Find linked review", workspaces: "Load working copies", viewed: "Read GitHub Viewed status", metadata: "Load PR overview", mentions: "Find repository users", "failed-checks": "Load failed CI checks" };
  const pr = path.match(/\/github\/pr\/([^/]+)\/([^/]+)\/(\d+)/);
  return `${names[action] ?? "Load data"}${pr ? ` · ${pr[1]}/${pr[2]} #${pr[3]}` : ""}`;
}
