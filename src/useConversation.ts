import { useEffect, useState } from "react";
import type { Conversation } from "../shared/types";
import { useResource } from "./api";

/** Refresh discussion without replacing an open thread or its composer with loading state. */
export function useConversation(endpoint: string) {
  const resource = useResource<Conversation>(`${endpoint}/conversation`, true);
  const [saved, setData] = useState<Conversation>();
  const [source, setSource] = useState(endpoint);
  if (source !== endpoint) { setSource(endpoint); setData(undefined); }
  // Refreshing resolution must not temporarily turn the active thread into a new-comment composer.
  useEffect(() => {
    if (!resource.data) return;
    setData((current) => current?.version !== undefined && resource.data?.version !== undefined && current.version > resource.data.version ? current : resource.data);
  }, [resource.data]);
  return { ...resource, data: source === endpoint ? saved ?? resource.data : resource.data, setData };
}
