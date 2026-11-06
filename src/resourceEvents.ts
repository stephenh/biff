import { useEffect } from "react";

const sender = crypto.randomUUID();

/** Route focus, polling, and cross-tab invalidation through the resource's existing refresh path. */
export function useResourceEvents(refresh: () => void, channel: string | undefined, interval?: number) {
  useEffect(() => {
    if (!channel) return;
    function refreshVisible() { if (document.visibilityState === "visible") refresh(); }
    const updates = new BroadcastChannel(channel);
    // The window event already reached this tab; receiving our broadcast must not fetch twice.
    updates.onmessage = (event) => { if (event.data?.sender !== sender) refreshVisible(); };
    window.addEventListener(channel, refreshVisible);
    window.addEventListener("focus", refreshVisible);
    document.addEventListener("visibilitychange", refreshVisible);
    const timer = interval ? window.setInterval(refreshVisible, interval) : undefined;
    return () => {
      updates.close();
      window.clearInterval(timer);
      window.removeEventListener(channel, refreshVisible);
      window.removeEventListener("focus", refreshVisible);
      document.removeEventListener("visibilitychange", refreshVisible);
    };
  }, [refresh, channel, interval]);
}

/** Notify this tab and other tabs once each, without turning a successful write into a reload. */
export function notifyResource(channel: string) {
  window.dispatchEvent(new Event(channel));
  const updates = new BroadcastChannel(channel);
  updates.postMessage({ sender });
  updates.close();
}
