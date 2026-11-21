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

/**
 * Release HTTP/1.1 connections held by background review tabs.
 *
 * A few open reviews can otherwise exhaust the browser's per-origin pool. Both
 * review and discussion streams send current state when a visible tab reconnects.
 */
export function subscribeVisibleEvents(url: string, onMessage: (event: MessageEvent<string>) => void, onError?: () => void) {
  let events: EventSource | undefined;

  /** Follow visibility rather than focus so side-by-side reviews stay live. */
  function syncVisibility() {
    if (document.visibilityState === "visible") {
      if (events) return;
      const source = new EventSource(url);
      events = source;
      source.onmessage = (event) => { if (events === source) onMessage(event); };
      source.onerror = () => { if (events === source) onError?.(); };
    } else {
      events?.close();
      events = undefined;
    }
  }

  document.addEventListener("visibilitychange", syncVisibility);
  syncVisibility();
  return () => {
    document.removeEventListener("visibilitychange", syncVisibility);
    events?.close();
    events = undefined;
  };
}
