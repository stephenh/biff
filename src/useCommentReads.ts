import { useEffect, useMemo, useState } from "react";
import { post, useResource } from "./api";
import type { LineThread } from "./lineComments";
import { useOptimisticSave } from "./useOptimisticSave";

/**
 * Explicit message receipts share one durable source across dashboard and thread views.
 *
 * Queue snapshots per thread, retaining optimistic intent across modal dismissal and navigation.
 */
export function useCommentReads(endpoint: string | undefined, threads: LineThread[], receipts?: string[]) {
  const resource = useResource<string[]>(endpoint ? `${endpoint}/comment-reads` : null);
  const [saved, setSaved] = useState<{ endpoint: string; keys: string[] }>();
  const scope = `comment-reads:${endpoint}`;
  const known = useMemo(() => new Set([...(resource.data ?? []), ...(receipts ?? []), ...(saved && saved.endpoint === endpoint ? saved.keys : [])]), [resource.data, receipts, saved, endpoint]);
  const values = useMemo(() => new Map(threads.map((thread) => [thread.id, JSON.stringify(messageKeys(thread).filter((key) => known.has(key)))])), [threads, known]);
  const queue = useOptimisticSave(scope, values);

  useEffect(() => {
    if (endpoint && resource.data) setSaved((previous) => ({ endpoint, keys: [...new Set([...(previous?.endpoint === endpoint ? previous.keys : []), ...resource.data!])] }));
  }, [endpoint, resource.data]);

  useEffect(() => {
    if (!endpoint) return;
    const channel = new BroadcastChannel("biff-comment-reads");
    channel.onmessage = resource.refresh;
    window.addEventListener("biff-comment-reads", resource.refresh);
    window.addEventListener("focus", resource.refresh);
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") resource.refreshQuiet(); }, 15000);
    return () => {
      channel.close();
      window.clearInterval(timer);
      window.removeEventListener("biff-comment-reads", resource.refresh);
      window.removeEventListener("focus", resource.refresh);
    };
  }, [endpoint]);

  /** Snapshot exact displayed IDs: a reply arriving during this save remains unread. */
  function markRead(thread: LineThread, selected = messageKeys(thread)) {
    if (!endpoint) return;
    const keys = JSON.stringify([...new Set([...JSON.parse(queue.intent(thread.id, values.get(thread.id) ?? "[]")), ...selected.filter((key) => messageKeys(thread).includes(key))])]);
    queue.save(thread.id, keys, values.get(thread.id) ?? "[]", async (snapshot) => {
      await post(`${endpoint}/comment-reads`, { keys: JSON.parse(snapshot) });
      window.dispatchEvent(new Event("biff-comment-reads"));
      const channel = new BroadcastChannel("biff-comment-reads");
      channel.postMessage(null);
      channel.close();
    }, `Read ${thread.location.path}:${thread.location.line}`);
  }

  const annotated = useMemo(() => threads.map((thread) => {
    const read = new Set<string>([...known, ...JSON.parse(queue.value(thread.id, "[]"))]);
    const unreadKeys = messageKeys(thread).filter((key) => !read.has(key));
    return { ...thread, unreadCount: unreadKeys.length, unreadKeys };
  }), [threads, known, queue, queue.version]);
  return { threads: annotated, markRead, scope, activity: resource.activity, error: resource.error };
}

/** Local UUIDs survive edits, publication, and switching between collaboration and ordinary reviews. */
function messageKeys(thread: LineThread): string[] {
  if (thread.draftIndex !== undefined) return [];
  return thread.readKeys ?? thread.comments.map((comment) => `github:${comment.id}`);
}
