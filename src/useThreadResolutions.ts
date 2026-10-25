import { useMemo } from "react";
import type { LineThread } from "./lineComments";
import { useOptimisticSave } from "./useOptimisticSave";

/** Share optimistic resolution state between the file browser and review-wide comments. */
export function useThreadResolutions(scope: string, threads: LineThread[], persist?: (id: string, resolved: boolean, keys?: string[], complete?: boolean) => Promise<void>) {
  const saved = useMemo(() => new Map(threads.filter((thread) => thread.resolved !== undefined).map((thread) => [thread.id, ""])), [threads]);
  const saves = useOptimisticSave(scope, saved);
  const annotated = useMemo(() => threads.map((thread) => {
    if (thread.resolved === undefined) return thread;
    const pending = saves.pending(thread.id);
    if (!pending) return thread;
    const intent = JSON.parse(saves.value(thread.id, "{}")) as { resolved: boolean; complete: boolean; keys: string[] };
    // This is only a pending preview; the backend decides completion ownership and permissions.
    const resolved = intent.complete ? thread.resolved || Boolean(thread.comments[0]?.own && thread.canResolve) : intent.resolved;
    const unreadKeys = (thread.unreadKeys ?? []).filter((key) => !intent.keys.includes(key));
    return { ...thread, resolved, ...(intent.complete || resolved ? { unreadKeys, unreadCount: unreadKeys.length } : {}), canResolve: thread.canResolve || (!resolved && thread.canReopen), canReopen: thread.canReopen || (resolved && thread.canResolve) };
  }), [threads, saves.version]);

  /** Update the thread immediately; its resource-scoped queue outlives the comments modal. */
  function resolve(id: string, resolved: boolean, complete = false) {
    const thread = threads.find((thread) => thread.id === id);
    if (!thread || !persist) return;
    const keys = thread.comments.map((comment) => comment.readKey ?? `github:${comment.id}`);
    const intent = JSON.stringify({ resolved, complete, keys, request: crypto.randomUUID() });
    saves.save(id, intent, "", async (value) => {
      const action = JSON.parse(value) as { resolved: boolean; complete: boolean; keys: string[] };
      await persist(id, action.resolved, action.keys, action.complete);
    }, `Thread ${thread.location.path}:${thread.location.line}`);
  }

  return { threads: annotated, resolve, complete: (thread: LineThread) => resolve(thread.id, true, true) };
}
