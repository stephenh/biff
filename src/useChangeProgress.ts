import { useEffect, useMemo, useRef, useState } from "react";
import type { FileDiffMetadata } from "@pierre/diffs";
import { matchesChange, type ReviewedChange } from "../shared/progress";
import { identifyChanges, type ChangeBlock } from "./changeProgress";
import { post, useResource } from "./api";

/** Load durable progress and keep mutations acknowledged before advancing the review. */
export function useChangeProgress(files: FileDiffMetadata[], endpoint?: string, head?: string) {
  const resource = useResource<ReviewedChange[]>(endpoint ? `${endpoint}/progress` : null);
  const [blocks, setBlocks] = useState<ChangeBlock[]>([]);
  const [identified, setIdentified] = useState(false);
  const [saved, setSaved] = useState<ReviewedChange[]>();
  const [busy, setBusy] = useState(false);
  const writing = useRef(false);
  const [error, setError] = useState("");
  const [undo, setUndo] = useState<{ block: ChangeBlock; reviewed: boolean }>();
  const channel = useRef<BroadcastChannel | undefined>(undefined);
  useEffect(() => {
    let active = true;
    if (endpoint) void identifyChanges(files).then((result) => { if (active) { setBlocks(result); setIdentified(true); } }, (cause) => { if (active) setError(String(cause)); });
    return () => { active = false; };
  }, [files, endpoint]);
  useEffect(() => { if (resource.data) setSaved(resource.data); }, [resource.data]);
  useEffect(() => {
    if (!endpoint) return;
    function refresh() { if (!busy) resource.refresh(); }
    const updates = new BroadcastChannel(`biff-progress:${endpoint}`);
    channel.current = updates;
    updates.onmessage = refresh;
    window.addEventListener("focus", refresh);
    return () => { window.removeEventListener("focus", refresh); updates.close(); channel.current = undefined; };
  }, [endpoint, busy]);

  /** Carry unique marks across movement, but require coordinates if either side is duplicated. */
  const reviewed = useMemo(() => {
    /** Keep the predicate stable so cursor movement does not rebuild diff styles. */
    function isReviewed(block: ChangeBlock) { return (saved ?? []).some((entry) => matchesChange(entry, block)); }
    return isReviewed;
  }, [saved]);

  /** Persist first so a failed write never makes a change look completed. */
  async function save(block: ChangeBlock, value: boolean, remember = true): Promise<boolean> {
    if (!endpoint || !head || writing.current || resource.loading || !saved) return false;
    writing.current = true;
    setBusy(true); setError("");
    try {
      const previous = reviewed(block);
      const result = await post<ReviewedChange[]>(`${endpoint}/progress`, { ...block, head, reviewed: value });
      setSaved(result);
      channel.current?.postMessage("updated");
      setUndo(remember ? { block, reviewed: previous } : undefined);
      return true;
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); return false; }
    finally { writing.current = false; setBusy(false); }
  }
  return { blocks, reviewed, save, undo, busy: busy || resource.loading, ready: saved !== undefined && identified, error: error || resource.error, retry: resource.refresh };
}
