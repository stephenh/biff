import { useEffect, useState } from "react";

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
  const [state, setState] = useState<{ data?: T; error?: string; loading: boolean }>({ loading: Boolean(url) });
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!url) { setState({ loading: false }); return; }
    const controller = new AbortController();
    setState({ loading: true });
    request<T>(url, { signal: controller.signal }).then(
      (data) => { if (!controller.signal.aborted) setState({ data, loading: false }); },
      (error: Error) => { if (!controller.signal.aborted) setState({ error: error.message, loading: false }); },
    );
    return () => controller.abort();
  }, [url, version]);
  function refresh() { setVersion((current) => current + 1); }
  return { ...state, refresh, version };
}
