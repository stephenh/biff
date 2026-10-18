import { useEffect, useMemo, useState } from "react";
import { post, useResource } from "./api";
import type { LineThread } from "./lineComments";

/** Persist only messages displayed in an open thread, including replies arriving while it is open. */
export function useCommentReads(endpoint: string | undefined, threads: LineThread[], activeThreadId?: string) {
  const resource = useResource<string[]>(endpoint ? `${endpoint}/comment-reads` : null);
  const [saved, setSaved] = useState<{ endpoint: string; keys: string[] }>();
  const [error, setError] = useState("");
  const active = threads.find((thread) => thread.id === activeThreadId);
  const activeKeys = JSON.stringify(active ? messageKeys(active) : []);

  useEffect(() => {
    if (endpoint && resource.data) setSaved((previous) => ({ endpoint, keys: [...new Set([...(previous?.endpoint === endpoint ? previous.keys : []), ...resource.data!])] }));
  }, [endpoint, resource.data]);

  useEffect(() => {
    const channel = new BroadcastChannel("biff-comment-reads");
    channel.onmessage = resource.refresh;
    window.addEventListener("biff-comment-reads", resource.refresh);
    window.addEventListener("focus", resource.refresh);
    return () => {
      channel.close();
      window.removeEventListener("biff-comment-reads", resource.refresh);
      window.removeEventListener("focus", resource.refresh);
    };
  }, [endpoint]);

  useEffect(() => {
    setError("");
    if (!endpoint || activeKeys === "[]") return;
    let cancelled = false;
    void post<string[]>(`${endpoint}/comment-reads`, { keys: JSON.parse(activeKeys) }).then((keys) => {
      if (!cancelled) setSaved((previous) => ({ endpoint, keys: [...new Set([...(previous?.endpoint === endpoint ? previous.keys : []), ...keys])] }));
      window.dispatchEvent(new Event("biff-comment-reads"));
      const channel = new BroadcastChannel("biff-comment-reads");
      channel.postMessage(null);
      channel.close();
    }).catch((cause: Error) => { if (!cancelled) setError(cause.message); });
    return () => { cancelled = true; };
  }, [endpoint, activeKeys]);

  const annotated = useMemo(() => {
    const read = new Set([...(resource.data ?? []), ...(saved && saved.endpoint === endpoint ? saved.keys : [])]);
    return threads.map((thread) => ({ ...thread, unreadCount: messageKeys(thread).filter((key) => !read.has(key)).length }));
  }, [threads, resource.data, saved, endpoint]);
  return {
    threads: annotated,
    error: error || resource.error,
  };
}

/** Local UUIDs survive edits, publication, and switching between collaboration and ordinary reviews. */
function messageKeys(thread: LineThread): string[] {
  if (thread.draftIndex !== undefined) return [];
  return thread.readKeys ?? thread.comments.map((comment) => `github:${comment.id}`);
}
