import { useEffect, useState } from "react";
import type { Conversation } from "../shared/types";
import { useResource } from "./api";

/** Refresh discussion without replacing an open thread or its composer with loading state. */
export function useConversation(endpoint: string) {
  const resource = useResource<Conversation>(`${endpoint}/conversation`);
  const [saved, setData] = useState<Conversation>();
  // Refreshing resolution must not temporarily turn the active thread into a new-comment composer.
  useEffect(() => {
    if (!resource.data) return;
    setData(resource.data);
    // The backend may have added bot receipts after the parallel read-state request completed.
    window.dispatchEvent(new Event("biff-comment-reads"));
  }, [resource.data]);
  useEffect(() => {
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") resource.refresh(); }, 120000);
    return () => window.clearInterval(timer);
  }, [endpoint]);
  return { ...resource, data: saved ?? resource.data, setData };
}
