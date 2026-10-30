import { useEffect, useMemo } from "react";
import type { ViewedFiles } from "../shared/types";
import { post, useResource } from "./api";
import { Viewer, type ViewerProps } from "./Viewer";
import { useOptimisticSave } from "./useOptimisticSave";
import { BackgroundSaveStatus } from "./BackgroundSaveStatus";

/** Display backend-owned GitHub synchronization; browser navigation cannot abandon its retries. */
export function GitHubViewer(props: ViewerProps & { endpoint: string }) {
  const resource = useResource<ViewedFiles>(`${props.endpoint}/viewed`);
  const scope = `viewed-sync:${props.endpoint}`;
  const saved = useMemo(() => new Map<string, number>(), []);
  const saves = useOptimisticSave(scope, saved);

  useEffect(() => {
    const timer = window.setInterval(resource.refresh, 5000);
    const updates = new BroadcastChannel("biff-progress");
    updates.onmessage = resource.refresh;
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
    {resource.error && <div className="error" role="alert">Could not load GitHub review status: {resource.error} <button onClick={resource.refresh}>Retry</button></div>}
    {resource.data?.syncing && !resource.data.syncError && !resource.data.syncErrors?.length && <div className="viewed-sync-pending muted" role="status">Updating GitHub Viewed status…</div>}
    {(resource.data?.syncError || Boolean(resource.data?.syncErrors?.length)) && <div className="error viewed-sync-error" role="alert">
      <div>{resource.data?.syncError && <span>GitHub Viewed sync: {resource.data.syncError}</span>}
        {Boolean(resource.data?.syncErrors?.length) && <details>
          <summary>GitHub Viewed sync needs attention for {resource.data!.syncErrors!.length} {resource.data!.syncErrors!.length === 1 ? "file" : "files"}</summary>
          <div className="viewed-sync-details">{resource.data!.syncErrors!.map((entry) => <p key={entry.path}>{entry.path}: {entry.error}</p>)}</div>
        </details>}
      </div>
      <button onClick={retry}>Retry</button>
    </div>}
    <BackgroundSaveStatus scope={scope} />
    <Viewer {...props} viewedFiles={resource.data?.files} />
  </>;
}
