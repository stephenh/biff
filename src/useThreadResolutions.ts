import { useMemo } from "react";
import type { LineThread } from "./lineComments";
import { useOptimisticSave } from "./useOptimisticSave";
import { publicationPending } from "./commentPublications";

interface ResolutionIntent { resolved: boolean; complete: boolean; keys: string[] }

/** Share optimistic resolution state between the file browser and review-wide comments. */
export function useThreadResolutions(scope: string, threads: LineThread[], persist?: (id: string, resolved: boolean, keys?: string[], complete?: boolean) => Promise<void>) {
  const saved = useMemo(() => new Map<string, ResolutionIntent | undefined>(threads.filter((thread) => thread.resolved !== undefined).map((thread) => [thread.id, undefined])), [threads]);
  const saves = useOptimisticSave(scope, saved);
  const annotated = useMemo(() => threads.map((thread) => {
    if (thread.resolved === undefined) return thread;
    const intent = saves.value(thread.id, undefined);
    if (!saves.pending(thread.id) || !intent) return thread;
    // This is only a pending preview; the backend decides completion ownership and permissions.
    const resolved = intent.complete ? thread.resolved || Boolean(thread.comments[0]?.own && thread.canResolve) : intent.resolved;
    const unreadKeys = thread.kind === "general" ? thread.unreadKeys ?? [] : (thread.unreadKeys ?? []).filter((key) => !intent.keys.includes(key));
    return { ...thread, resolved, ...(intent.complete || resolved ? { unreadKeys, unreadCount: unreadKeys.length } : {}), canResolve: thread.canResolve || (!resolved && thread.canReopen), canReopen: thread.canReopen || (resolved && thread.canResolve) };
  }), [threads, saves.version]);

  /** Update the thread immediately; its resource-scoped queue outlives the comments modal. */
  function resolve(id: string, resolved: boolean, complete = false) {
    const thread = threads.find((thread) => thread.id === id);
    if (!thread || !persist || thread.comments[0] && publicationPending(thread.comments[0])) return;
    const keys = thread.comments.filter((comment) => !publicationPending(comment)).map((comment) => comment.readKey ?? `github:${comment.id}`);
    saves.save(id, { resolved, complete, keys }, undefined, async (intent) => {
      if (intent) await persist(id, intent.resolved, intent.keys, intent.complete);
    }, thread.kind === "general" ? `PR comment by ${thread.comments[0]?.user.login}` : `Thread ${thread.location.path}:${thread.location.line}`);
  }

  return { threads: annotated, resolve, complete: (thread: LineThread) => resolve(thread.id, true, true) };
}
