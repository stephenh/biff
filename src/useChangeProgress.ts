import { useEffect, useMemo, useRef, useState } from "react";
import type { FileDiffMetadata } from "@pierre/diffs";
import { matchesChange, type ChangeIdentity, type ReviewedChange } from "../shared/progress";
import { identifyChanges, identifyFiles, type ChangeBlock } from "./changeProgress";
import { post, useResource } from "./api";

/**
 * Load durable progress and acknowledge mutations before advancing the review.
 *
 * File navigation queues writes so rapid shortcuts cannot discard intermediate files.
 */
export function useChangeProgress(files: FileDiffMetadata[], endpoint?: string, head?: string) {
  const resource = useResource<ReviewedChange[]>(endpoint ? `${endpoint}/progress` : null);
  const [blocks, setBlocks] = useState<ChangeBlock[]>([]);
  const [fileIdentities, setFileIdentities] = useState<ChangeIdentity[]>([]);
  const [identified, setIdentified] = useState(false);
  const [saved, setSaved] = useState<ReviewedChange[]>();
  const [busy, setBusy] = useState(false);
  const writing = useRef(false);
  const queue = useRef(Promise.resolve());
  const pending = useRef(0);
  const refreshNeeded = useRef(false);
  const [error, setError] = useState("");
  const [undo, setUndo] = useState<{ block: ChangeBlock; reviewed: boolean }>();
  const channel = useRef<BroadcastChannel | undefined>(undefined);
  useEffect(() => {
    let active = true;
    setIdentified(false);
    if (endpoint) void identifyChanges(files).then(async (result) => {
      const identities = await identifyFiles(files, result, head);
      if (active) { setBlocks(result); setFileIdentities(identities); setIdentified(true); }
    }).catch((cause) => { if (active) setError(String(cause)); });
    return () => { active = false; };
  }, [files, endpoint, head]);
  useEffect(() => { if (resource.data) setSaved(resource.data); }, [resource.data]);
  useEffect(() => {
    if (!endpoint) return;
    function refresh() {
      if (pending.current > 0) refreshNeeded.current = true;
      else resource.refresh();
    }
    // Local and PR URLs differ even when their durable review is shared.
    const updates = new BroadcastChannel("biff-progress");
    channel.current = updates;
    updates.onmessage = refresh;
    window.addEventListener("focus", refresh);
    return () => { window.removeEventListener("focus", refresh); updates.close(); channel.current = undefined; };
  }, [endpoint]);

  /** Carry unique marks across movement, but require coordinates if either side is duplicated. */
  const reviewed = useMemo(() => {
    /** Keep the predicate stable so cursor movement does not rebuild diff styles. */
    function isReviewed(block: ChangeIdentity) {
      // Generated schema/lock files at the root and history files anywhere stay reviewed after edits.
      if (block.path === "schema.graphql" || block.path === "yarn.lock" || block.path === ".history.json" || block.path.endsWith("/.history.json")) return true;
      return (saved ?? []).some((entry) => matchesChange(entry, block));
    }
    return isReviewed;
  }, [saved]);

  /** Persist first so a failed write never makes a change look completed. */
  async function save(block: ChangeBlock, value: boolean, remember = true): Promise<boolean> {
    if (!endpoint || !head || writing.current || resource.loading || !saved) return false;
    writing.current = true;
    try {
      const previous = reviewed(block);
      if (!await persist(block, value)) return false;
      setUndo(remember ? { block, reviewed: previous } : undefined);
      return true;
    } finally { writing.current = false; }
  }

  /** Persist file completion and its blocks atomically, queuing rapid cross-file navigation. */
  async function saveFile(fileIndex: number, value: boolean): Promise<boolean> {
    const identity = fileIdentities[fileIndex];
    if (!identity || !saved) return false;
    const result = await persist(identity, value, blocks.filter((block) => block.fileIndex === fileIndex));
    if (result) setUndo(undefined);
    return result;
  }

  /** Keep responses ordered so fast file navigation cannot restore an older progress snapshot. */
  function persist(identity: ChangeIdentity, value: boolean, blocks?: ChangeIdentity[]): Promise<boolean> {
    if (!endpoint || !head) return Promise.resolve(false);
    pending.current++;
    setBusy(true); setError("");
    const result = queue.current.then(async () => {
      try {
        setSaved(await post<ReviewedChange[]>(`${endpoint}/progress`, { ...identity, head, reviewed: value, blocks }));
        channel.current?.postMessage("updated");
        return true;
      } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); return false; }
      finally {
        pending.current--;
        setBusy(pending.current > 0);
        if (!pending.current && refreshNeeded.current) { refreshNeeded.current = false; resource.refresh(); }
      }
    });
    queue.current = result.then(() => {});
    return result;
  }
  return { blocks, fileIdentities, reviewed, save, saveFile, undo, busy: busy || resource.loading, ready: saved !== undefined && identified, error: error || resource.error, retry: resource.refresh };
}
