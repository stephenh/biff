import { useRef, useState } from "react";
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
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const pending = useRef(new Map<string, { viewed: boolean; promise: Promise<boolean> }>());
  const [errors, setErrors] = useState<Record<string, { message: string; viewed: boolean }>>({});

  /** Deduplicate a file's in-flight save without blocking saves for other files. */
  function toggle(path: string, viewed: boolean): Promise<boolean> {
    const existing = pending.current.get(path);
    if (existing) return existing.viewed === viewed ? existing.promise : existing.promise.then(() => toggle(path, viewed));
    const saving = save(path, viewed);
    pending.current.set(path, { viewed, promise: saving });
    return saving;
  }

  /** Update only this file's saved state, retaining failures until retried. */
  async function save(path: string, viewed: boolean): Promise<boolean> {
    setBusy((current) => ({ ...current, [path]: true }));
    setErrors((current) => {
      const next = { ...current };
      delete next[path];
      return next;
    });
    try {
      const result = await post<{ state: FileViewedState }>(`${props.endpoint}/viewed`, { path, viewed });
      setUpdates((current) => ({ ...current, [path]: result.state }));
      return true;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Could not update Viewed status.";
      setErrors((current) => ({ ...current, [path]: { message, viewed } }));
      return false;
    } finally {
      pending.current.delete(path);
      setBusy((current) => ({ ...current, [path]: false }));
    }
  }

  return <>
    {resource.error && <div className="error" role="alert">Could not load GitHub review status: {resource.error} <button onClick={resource.refresh}>Retry</button></div>}
    {Object.entries(errors).map(([path, failure]) => <div className="error" role="alert" key={path}><span>{path}: {failure.message}</span><button disabled={busy[path]} onClick={() => void toggle(path, failure.viewed)}>Retry</button></div>)}
    <Viewer {...props} viewedFiles={resource.data ? { ...resource.data.files, ...updates } : undefined} onSyncReviewed={toggle} />
  </>;
}
