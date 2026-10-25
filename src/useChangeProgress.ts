import { useEffect, useMemo, useState } from "react";
import type { FileDiffMetadata } from "@pierre/diffs";
import { changeKey, isAutoReviewedFile, matchesChange, type ChangeIdentity, type ReviewedChange } from "../shared/progress";
import { identifyChanges, identifyMetadata, type ChangeBlock } from "./changeProgress";
import { post, useResource } from "./api";
import { useOptimisticSave } from "./useOptimisticSave";

/** Preview per-file batches immediately; shared queues retain writes and retry across navigation. */
export function useChangeProgress(files: FileDiffMetadata[], endpoint?: string, head?: string) {
  const resource = useResource<ReviewedChange[]>(endpoint ? `${endpoint}/progress` : null);
  const [blocks, setBlocks] = useState<ChangeBlock[]>([]);
  const [metadata, setMetadata] = useState<ChangeIdentity[]>([]);
  const [identified, setIdentified] = useState(false);
  const [saved, setSaved] = useState<ReviewedChange[]>();
  const [error, setError] = useState("");
  const [undo, setUndo] = useState<{ block: ChangeBlock; reviewed: boolean }>();
  const scope = `progress:${endpoint}`;
  const units = useMemo(() => [...blocks, ...metadata], [blocks, metadata]);
  const values = useMemo(() => new Map(files.map((file) => [file.name, JSON.stringify(units.filter((unit) => unit.path === file.name).map((unit) => [changeKey(unit), (saved ?? []).some((record) => matchesChange(record, unit))]))])), [files, units, saved]);
  const queue = useOptimisticSave(scope, saved && identified ? values : new Map<string, string>());

  useEffect(() => {
    let active = true;
    setIdentified(false);
    if (endpoint) void identifyChanges(files).then(async (result) => {
      const extra = await identifyMetadata(files, head);
      if (active) { setBlocks(result); setMetadata(extra); setIdentified(true); }
    }).catch((cause) => { if (active) setError(String(cause)); });
    return () => { active = false; };
  }, [files, endpoint, head]);
  useEffect(() => { if (resource.data) setSaved(resource.data); }, [resource.data]);
  useEffect(() => {
    if (!endpoint) return;
    // Local and PR URLs differ even when their durable review is shared.
    const updates = new BroadcastChannel("biff-progress");
    updates.onmessage = resource.refresh;
    window.addEventListener("focus", resource.refresh);
    return () => { window.removeEventListener("focus", resource.refresh); updates.close(); };
  }, [endpoint]);

  const reviewed = useMemo(() => {
    /** Carry unique approvals across line shifts while respecting duplicate coordinates. */
    function isReviewed(unit: ChangeIdentity) {
      if (isAutoReviewedFile(unit.path)) return true;
      const current = new Map<string, boolean>(JSON.parse(queue.value(unit.path, values.get(unit.path) ?? "[]")));
      return current.get(changeKey(unit)) ?? (saved ?? []).some((record) => matchesChange(record, unit));
    }
    return isReviewed;
  }, [saved, values, queue.version]);

  /** Space can advance in the same event; persistence never controls navigation. */
  function save(block: ChangeBlock, value: boolean, remember = true): boolean {
    const previous = reviewed(block);
    if (!persist(block.path, [block], value)) return false;
    setUndo(remember ? { block, reviewed: previous } : undefined);
    return true;
  }

  /** File actions are atomic batches of text and non-text review units. */
  function saveFile(fileIndex: number, value: boolean): boolean {
    const path = files[fileIndex]?.name;
    if (!path || !persist(path, units.filter((unit) => unit.path === path), value)) return false;
    setUndo(undefined);
    return true;
  }

  /** Serialize overlapping file/hunk actions per file; other files save independently. */
  function persist(path: string, changed: ChangeIdentity[], value: boolean): boolean {
    if (!endpoint || !head || !saved || !identified) return false;
    const confirmed = values.get(path) ?? "[]";
    const current = new Map<string, boolean>(JSON.parse(queue.intent(path, confirmed)));
    for (const unit of changed) current.set(changeKey(unit), value);
    const own = units.filter((unit) => unit.path === path);
    const intent = JSON.stringify(own.map((unit) => [changeKey(unit), current.get(changeKey(unit)) ?? false]));
    queue.save(path, intent, confirmed, async (state, acknowledged, attempted) => {
      const desired = new Map<string, boolean>(JSON.parse(state));
      const previous = new Map<string, boolean>(JSON.parse(acknowledged));
      const uncertain = new Map<string, boolean>(JSON.parse(attempted ?? acknowledged));
      const changes = own.filter((identity) => {
        const key = changeKey(identity);
        return desired.get(key) !== previous.get(key) || desired.get(key) !== uncertain.get(key);
      }).map((identity) => ({ identity, reviewed: desired.get(changeKey(identity)) ?? false }));
      const records = await post<ReviewedChange[]>(`${endpoint}/progress`, { head, changes });
      // Different files save independently; a full response must not undo another file's acknowledgement.
      setSaved((previous) => [...(previous ?? []).filter((record) => record.path !== path), ...records.filter((record) => record.path === path)]);
      const updates = new BroadcastChannel("biff-progress");
      updates.postMessage("updated"); updates.close();
    }, `Review ${path}`);
    return true;
  }

  return { blocks, metadata, reviewed, save, saveFile, undo, scope, ready: saved !== undefined && identified, error: error || resource.error, retry: resource.refresh };
}
