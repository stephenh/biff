import { useRef } from "react";
import type { FollowUp } from "../shared/followUps";
import type { ChangeIdentity } from "../shared/progress";
import { matchesChange } from "../shared/progress";
import { post, useResource } from "./api";
import { useSaveFeedback } from "./useSaveFeedback";
import { notifyResource, useResourceEvents } from "./resourceEvents";

/** Keep personal flags synchronized across the diff, thread dialogs, and other tabs. */
export function useFollowUps(endpoint?: string) {
  const resource = useResource<FollowUp[]>(endpoint ? `${endpoint}/follow-ups` : null);
  const saved = resource.data;
  const scope = `follow-up:${endpoint}`;
  const { busy, setBusy, setError } = useSaveFeedback(scope, "Save follow-up", retry);
  const writing = useRef(false);
  const lastWrite = useRef<unknown>(undefined);
  useResourceEvents(resource.refreshQuiet, endpoint ? "biff-follow-ups" : undefined);

  /** Publish only after the server has committed the follow-up and any accompanying completion. */
  async function save(body: unknown): Promise<boolean> {
    if (!endpoint || writing.current) return false;
    writing.current = true;
    lastWrite.current = body;
    setBusy(true); setError("");
    try {
      resource.setData(await post<FollowUp[]>(`${endpoint}/follow-ups`, body));
      notifyResource("biff-follow-ups");
      notifyResource("biff-progress");
      return true;
    } catch (cause) { setError((cause as Error).message); return false; }
    finally { writing.current = false; setBusy(false); }
  }

  function hasHunk(block: ChangeIdentity) { return (saved ?? []).some((item) => item.type === "hunk" && matchesChange(item, block)); }
  function hasThread(id: string) { return (saved ?? []).some((item) => item.type === "thread" && (item.id === id || `github:${item.githubId}` === id)); }
  function hunk(block: ChangeIdentity, head: string, enabled: boolean) { return save({ ...block, type: "hunk", head, enabled }); }
  function thread(id: string, enabled: boolean) { return save({ type: "thread", id, enabled }); }
  /** Replay an explicit set operation, or reload when the failure preceded any edit. */
  function retry() { if (lastWrite.current !== undefined) void save(lastWrite.current); }
  return { items: saved ?? [], ready: saved !== undefined, busy, scope, activity: resource.activity, hasHunk, hasThread, hunk, thread };
}
