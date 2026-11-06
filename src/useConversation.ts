import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { Conversation } from "../shared/types";
import { useResource } from "./api";
import { commentPublications } from "./commentPublications";
import { backgroundSaves } from "./optimisticSave";

/** Refresh discussion without replacing an open thread or its composer with loading state. */
export function useConversation(endpoint: string) {
  const resource = useResource<Conversation>(`${endpoint}/conversation`, true);
  const [saved, setData] = useState<Conversation>();
  const [source, setSource] = useState(endpoint);
  const version = useSyncExternalStore((listener) => commentPublications.subscribe(listener), () => commentPublications.getSnapshot());
  const saves = useSyncExternalStore((listener) => backgroundSaves.subscribe(listener), () => backgroundSaves.getSnapshot());
  if (source !== endpoint) { setSource(endpoint); setData(undefined); }
  // Refreshing resolution must not temporarily turn the active thread into a new-comment composer.
  useEffect(() => {
    if (!resource.data) return;
    setData((current) => current?.version !== undefined && resource.data?.version !== undefined && current.version > resource.data.version ? current : resource.data);
  }, [resource.data]);
  const current = source === endpoint ? saved ?? resource.data : resource.data;
  const data = useMemo(() => commentPublications.project(endpoint, current, saves), [endpoint, current, version, saves]);
  return { ...resource, data, setData };
}
