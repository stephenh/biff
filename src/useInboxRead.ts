import { useEffect, useState } from "react";
import { post } from "./api";

/**
 * Acknowledge only the revision and discussion supplied by the visible review.
 *
 * A background tab must wait until the reader actually visits it before saving read markers.
 */
export function useInboxRead(endpoint: string, head: string | undefined, events: string[]) {
  const [error, setError] = useState("");
  const keys = JSON.stringify(events);
  useEffect(() => {
    let cancelled = false;
    let saved = false;
    let pending = false;
    async function acknowledge() {
      if (saved || pending || document.visibilityState !== "visible" || (!head && keys === "[]")) return;
      pending = true;
      try {
        await post(`${endpoint}/inbox`, { action: "seen", head, events: JSON.parse(keys) });
        saved = true;
        if (!cancelled) setError("");
      } catch (cause) { if (!cancelled) setError(`Could not save inbox read state: ${(cause as Error).message}`); }
      finally { pending = false; }
    }
    void acknowledge();
    document.addEventListener("visibilitychange", acknowledge);
    window.addEventListener("focus", acknowledge);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", acknowledge);
      window.removeEventListener("focus", acknowledge);
    };
  }, [endpoint, head, keys]);
  return error;
}
