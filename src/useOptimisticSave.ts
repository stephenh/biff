import { useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { backgroundSaves } from "./optimisticSave";

/** Share an optimistic queue across remounts while reconciling acknowledged server snapshots. */
export function useOptimisticSave<Value>(scope: string, saved: ReadonlyMap<string, Value>) {
  const queue = useMemo(() => backgroundSaves.queue<Value>(scope), [scope]);
  const loadedScope = useRef<string | undefined>(undefined);
  const version = useSyncExternalStore((listener) => queue.subscribe(listener), () => queue.version);
  useLayoutEffect(() => {
    const fresh = loadedScope.current !== scope && saved.size > 0;
    queue.reconcile(saved, fresh);
    if (fresh) loadedScope.current = scope;
  }, [queue, saved, scope, version]);
  return queue;
}
