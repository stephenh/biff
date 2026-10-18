import { useEffect, useRef, useState } from "react";
import type { FollowUp } from "../shared/followUps";
import type { ChangeIdentity } from "../shared/progress";
import { matchesChange } from "../shared/progress";
import { post, useResource } from "./api";

/** Keep personal flags synchronized across the diff, thread dialogs, and other tabs. */
export function useFollowUps(endpoint?: string) {
  const resource = useResource<FollowUp[]>(endpoint ? `${endpoint}/follow-ups` : null);
  const [saved, setSaved] = useState<FollowUp[]>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const writing = useRef(false);
  useEffect(() => { setSaved(undefined); }, [endpoint]);
  useEffect(() => { if (resource.data) setSaved(resource.data); }, [resource.data]);
  useEffect(() => {
    if (!endpoint) return;
    const channel = new BroadcastChannel("biff-follow-ups");
    channel.onmessage = resource.refresh;
    window.addEventListener("biff-follow-ups", resource.refresh);
    window.addEventListener("focus", resource.refresh);
    return () => {
      channel.close();
      window.removeEventListener("biff-follow-ups", resource.refresh);
      window.removeEventListener("focus", resource.refresh);
    };
  }, [endpoint]);

  /** Publish only after the server has committed the follow-up and any accompanying completion. */
  async function save(body: unknown): Promise<boolean> {
    if (!endpoint || writing.current) return false;
    writing.current = true;
    setBusy(true); setError("");
    try {
      setSaved(await post<FollowUp[]>(`${endpoint}/follow-ups`, body));
      window.dispatchEvent(new Event("biff-follow-ups"));
      const channel = new BroadcastChannel("biff-follow-ups");
      channel.postMessage(null); channel.close();
      const progress = new BroadcastChannel("biff-progress");
      progress.postMessage(null); progress.close();
      return true;
    } catch (cause) { setError((cause as Error).message); return false; }
    finally { writing.current = false; setBusy(false); }
  }

  function hasHunk(block: ChangeIdentity) { return (saved ?? []).some((item) => item.type === "hunk" && matchesChange(item, block)); }
  function hasThread(id: string) { return (saved ?? []).some((item) => item.type === "thread" && (item.id === id || `github:${item.githubId}` === id)); }
  function hunk(block: ChangeIdentity, head: string, enabled: boolean) { return save({ ...block, type: "hunk", head, enabled }); }
  function thread(id: string, enabled: boolean) { return save({ type: "thread", id, enabled }); }
  return { items: saved ?? [], ready: saved !== undefined, busy, error: error || resource.error, hasHunk, hasThread, hunk, thread };
}
