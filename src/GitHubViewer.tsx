import { useState } from "react";
import type { FileViewedState, ViewedFiles } from "../shared/types";
import { post, useResource } from "./api";
import { Viewer, type ViewerProps } from "./Viewer";

/**
 * Show and update GitHub's personal Viewed marks.
 *
 * Load marks separately so a failure does not prevent reading the diff.
 */
export function GitHubViewer(props: ViewerProps & { endpoint: string }) {
  const resource = useResource<ViewedFiles>(`${props.endpoint}/viewed`);
  const [updates, setUpdates] = useState<Record<string, FileViewedState>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const files = { ...resource.data?.files, ...updates };

  /** Update the checkbox only after GitHub accepts the mutation. */
  async function toggle(path: string, viewed: boolean) {
    setBusy(true);
    setError("");
    try {
      const result = await post<{ state: FileViewedState }>(`${props.endpoint}/viewed`, { path, viewed });
      setUpdates((current) => ({ ...current, [path]: result.state }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update Viewed status.");
    } finally {
      setBusy(false);
    }
  }

  /** A dismissed mark means GitHub invalidated the previous review after changes. */
  function fileControls(path: string) {
    const state = files[path];
    return <>
      <label className="collapse-control" title="Syncs with your Viewed flag on GitHub">
        <input type="checkbox" checked={state === "VIEWED"} disabled={busy || !state} onChange={(event) => void toggle(path, event.target.checked)} />
        {resource.loading ? "Loading Viewed status…" : state === "DISMISSED" ? "Viewed (changed since)" : "Viewed"}
      </label>
      {(error || resource.error) && <span className="error" role="alert">{error || resource.error}</span>}
    </>;
  }

  return <Viewer {...props} viewedFiles={files} fileControls={fileControls} />;
}
