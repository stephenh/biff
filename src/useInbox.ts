import { useEffect, useRef, useState } from "react";
import type { InboxQueue, QueueView } from "../shared/inbox";
import { request } from "./api";

/**
 * Poll the local snapshot without clearing the currently displayed queue.
 *
 * GitHub refresh cadence and deduplication belong to the backend, not individual browser tabs.
 */
export function useInbox(view: QueueView, archived = false) {
  const [saved, setSaved] = useState<{ view: QueueView; queue: InboxQueue }>();
  const [error, setError] = useState("");
  const loader = useRef<(force?: boolean) => Promise<void>>(async () => {});

  useEffect(() => {
    let cancelled = false;
    let sequence = 0;
    const controller = new AbortController();

    /** Keep visible rows during refreshes and reject responses from obsolete requests or tabs. */
    async function load(force = false) {
      const current = ++sequence;
      try {
        // Keep the existing discovery queues, but present bots alongside other review authors.
        const queues = await Promise.all((view === "requested" ? ["requested", "dependabot"] : [view]).map((queue) => request<InboxQueue>(`/api/inbox?view=${queue}${archived ? "&archived=1" : ""}`, { method: force ? "POST" : "GET", signal: controller.signal })));
        const queue: InboxQueue = {
          ...queues[0]!,
          items: [...new Map(queues.flatMap((entry) => entry.items).map((pr) => [pr.id, pr])).values()],
          updatedAt: queues.every((entry) => entry.updatedAt) ? Math.min(...queues.map((entry) => entry.updatedAt!)) : null,
          refreshing: queues.some((entry) => entry.refreshing),
          truncated: queues.some((entry) => entry.truncated),
          error: queues.map((entry) => entry.error).filter(Boolean).join(" · ") || undefined,
        };
        if (!cancelled && current === sequence) {
          setSaved({ view, queue });
          setError("");
        }
      } catch (cause) {
        if (!cancelled && current === sequence) setError((cause as Error).message);
      }
    }

    function poll() { if (document.visibilityState === "visible") void load(); }
    // Archived history uses cached records unless the reader explicitly refreshes it.
    function focus() { void load(!archived); }
    loader.current = load;
    void load();
    const timer = window.setInterval(poll, 3000);
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", poll);
    return () => {
      cancelled = true;
      controller.abort();
      window.clearInterval(timer);
      window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", poll);
    };
  }, [view, archived]);

  return { data: saved?.view === view ? saved.queue : undefined, error, reload: () => loader.current(), refresh: () => loader.current(true) };
}
