import { useMemo } from "react";
import type { LineThread } from "./lineComments";
import { useOptimisticSave } from "./useOptimisticSave";

/** Share optimistic resolution state between the file browser and review-wide comments. */
export function useThreadResolutions(scope: string, threads: LineThread[], persist?: (id: string, resolved: boolean) => Promise<void>) {
  const saved = useMemo(() => new Map(threads.filter((thread) => thread.resolved !== undefined).map((thread) => [thread.id, thread.resolved!])), [threads]);
  const saves = useOptimisticSave(scope, saved);
  const annotated = useMemo(() => threads.map((thread) => {
    if (thread.resolved === undefined) return thread;
    const resolved = saves.value(thread.id, thread.resolved);
    const pending = saves.pending(thread.id);
    return { ...thread, resolved, canResolve: thread.canResolve || (pending && !resolved && thread.canReopen), canReopen: thread.canReopen || (pending && resolved && thread.canResolve) };
  }), [threads, saves.version]);

  /** Update the thread immediately; its resource-scoped queue outlives the comments modal. */
  function resolve(id: string, resolved: boolean) {
    const thread = threads.find((thread) => thread.id === id);
    if (!thread || !persist) return;
    saves.save(id, resolved, Boolean(thread.resolved), (value) => persist(id, value), `Thread ${thread.location.path}:${thread.location.line}`);
  }

  return { threads: annotated, resolve };
}
