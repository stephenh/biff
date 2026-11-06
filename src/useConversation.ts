import { useMemo, useSyncExternalStore } from "react";
import type { Conversation } from "../shared/types";
import { latestVersion, useResource } from "./api";
import { commentPublications } from "./commentPublications";
import { backgroundSaves } from "./optimisticSave";

/** Refresh discussion without replacing an open thread or its composer with loading state. */
export function useConversation(endpoint: string) {
  const resource = useResource<Conversation>(`${endpoint}/conversation`, { cached: true, reconcile: latestVersion });
  const version = useSyncExternalStore((listener) => commentPublications.subscribe(listener), () => commentPublications.getSnapshot());
  const saves = useSyncExternalStore((listener) => backgroundSaves.subscribe(listener), () => backgroundSaves.getSnapshot());
  const data = useMemo(() => commentPublications.project(endpoint, resource.data, saves), [endpoint, resource.data, version, saves]);
  return { ...resource, data };
}
