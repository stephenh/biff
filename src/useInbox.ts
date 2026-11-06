import { useCallback, useEffect, useRef, useState } from "react";
import type { InboxQueue, QueueView } from "../shared/inbox";
import { request } from "./api";
import { useActivity } from "./activity";
import { useResourceEvents } from "./resourceEvents";

/**
 * Poll the local snapshot without clearing the currently displayed queue.
 *
 * GitHub refresh cadence and deduplication belong to the backend, not individual browser tabs.
 */
export function useInbox(view: QueueView, archived = false) {
  const key = `${view}:${archived}`;
  const [saved, setSaved] = useState<{ key: string; queue?: InboxQueue; error?: string }>();
  const loader = useRef<(force?: boolean) => Promise<void>>(async () => {});
  const queue = saved?.key === key ? saved.queue : undefined;
  const error = saved?.key === key ? saved.error ?? "" : "";
  const reload = useCallback(function reload() { return loader.current(); }, []);
  useActivity({ scope: `inbox:${view}`, label: "Refresh PR inbox", loading: !queue || queue.refreshing, error: error || queue?.error, retry: () => void loader.current(true) });

  useEffect(() => {
    let cancelled = false;
    let sequence = 0;
    const controller = new AbortController();

    /** Keep visible rows during refreshes and reject responses from obsolete requests or tabs. */
    async function load(force = false) {
      const current = ++sequence;
      try {
        const queue = await request<InboxQueue>(`/api/inbox?view=${view}${archived ? "&archived=1" : ""}`, { method: force ? "POST" : "GET", signal: controller.signal });
        if (!cancelled && current === sequence) {
          setSaved({ key, queue });
        }
      } catch (cause) {
        if (!cancelled && current === sequence) setSaved((previous) => ({ key, queue: previous?.key === key ? previous.queue : undefined, error: cause instanceof Error ? cause.message : String(cause) }));
      }
    }

    // Focus reads SQLite and lets the backend's due-time/cooldown policy decide whether to sync.
    // Only an explicit Refresh or Retry should bypass that policy.
    loader.current = load;
    void load();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [view, archived]);
  useResourceEvents(reload, "biff-comment-reads", 3000);

  return { data: queue, error, reload, refresh: () => loader.current(true) };
}
