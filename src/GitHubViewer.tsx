import { useEffect, useMemo } from "react";
import type { ViewedFiles } from "../shared/types";
import { post, useResource } from "./api";
import { Viewer, type ViewerProps } from "./Viewer";
import { useOptimisticSave } from "./useOptimisticSave";
import { BackgroundSaveStatus } from "./BackgroundSaveStatus";
import { ActivityStatus } from "./ActivityStatus";

/** Display backend-owned GitHub synchronization; browser navigation cannot abandon its retries. */
export function GitHubViewer(props: ViewerProps & { endpoint: string }) {
  const resource = useResource<ViewedFiles>(`${props.endpoint}/viewed`);
  const scope = `viewed-sync:${props.endpoint}`;
  const saved = useMemo(() => new Map<string, number>(), []);
  const saves = useOptimisticSave(scope, saved);

  useEffect(() => {
    const timer = window.setInterval(resource.refreshQuiet, 5000);
    const updates = new BroadcastChannel("biff-progress");
    updates.onmessage = resource.refreshQuiet;
    return () => { window.clearInterval(timer); updates.close(); };
  }, [props.endpoint]);

  /** Retry the durable server job; report acknowledgement separately from loading fresh status. */
  function retry() {
    saves.save("review", Date.now(), 0, async () => {
      const result = await post<ViewedFiles>(`${props.endpoint}/viewed-sync`, {});
      resource.refresh();
      if (result.syncError) throw new Error(result.syncError);
      if (result.syncErrors?.length) throw new Error(`GitHub Viewed sync failed for ${result.syncErrors.length} files; see details.`);
    }, "GitHub Viewed synchronization");
  }

  return <>
    <ActivityStatus label="Synchronize GitHub Viewed flags" kind="syncing" loading={resource.data?.syncing} error={resource.data?.syncError} retry={retry} />
    {resource.data?.syncErrors?.map((entry) => <ActivityStatus key={entry.path} label={`GitHub Viewed · ${entry.path}`} error={entry.error} retry={retry} />)}
    <BackgroundSaveStatus scope={scope} />
    <Viewer {...props} viewedFiles={resource.data?.files} />
  </>;
}
