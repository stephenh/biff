import { useRef, useState } from "react";
import { Link } from "wouter";
import type { WorkingCopy } from "../shared/types";
import { post, request, useResource } from "./api";
import { ActivityScope } from "./ActivityStatus";
import { useSaveFeedback } from "./useSaveFeedback";
export { PullRequests } from "./PullRequests";

/** Persistent entry points to stable local repository directories. */
export function WorkingCopies() {
  const resource = useResource<WorkingCopy[]>("/api/workspaces");
  const [path, setPath] = useState("");
  const lastAction = useRef<() => void>(() => {});
  const scope = "working-copies:update";
  const { busy, setBusy, setError } = useSaveFeedback(scope, "Update working copies", () => lastAction.current());

  async function add(discover: boolean) {
    lastAction.current = () => void add(discover);
    setBusy(true); setError("");
    try {
      await post(`/api/workspaces${discover ? "/discover" : ""}`, { path });
      setPath(""); resource.refresh();
    } catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  }

  return <main className="dashboard">
    <div className="page-heading"><div><h1>Working Copies</h1><p>Your repositories. Pick up where the code is.</p></div><button onClick={resource.refresh}>Refresh</button></div>
    <form className="register-form" onSubmit={(event) => { event.preventDefault(); void add(false); }}>
      <input aria-label="Working copy path" placeholder="~/homebound/graphql-service" value={path} onChange={(event) => setPath(event.target.value)} />
      <button className="primary" disabled={busy || !path.trim()}>Add working copy</button>
      <button type="button" disabled={busy || !path.trim()} onClick={() => void add(true)}>Discover in folder</button>
    </form>
    <p className="muted">Run <code>biff</code> from a JJ working copy to register and open it. Or discover repositories inside a folder such as <code>~/homebound</code>.</p>
    <ActivityScope scope={scope} />
    {resource.loading && !resource.data && <p className="muted" aria-busy="true">Loading working copies…</p>}
    <div className="workspace-grid">{resource.data?.map((entry) => <WorkingCopyCard key={entry.id} entry={entry} onChanged={resource.refresh} />)}</div>
    {resource.data?.length === 0 && <p className="empty-state">Add your first working copy above.</p>}
  </main>;
}

/** Each forgotten repository retains its own failure and retry across navigation. */
function WorkingCopyCard(props: { entry: WorkingCopy; onChanged(): void }) {
  const entry = props.entry;
  const scope = `forget-workspace:${entry.id}`;
  const { busy, setBusy, setError } = useSaveFeedback(scope, `Forget working copy · ${entry.path}`, () => void remove());

  /** Keep the repository visible until removal is acknowledged. */
  async function remove() {
    setBusy(true);
    try { await request(`/api/workspaces/${entry.id}`, { method: "DELETE" }); props.onChanged(); }
    catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  }

  return <article className="workspace-card">
    <Link href={`/workspaces/${entry.id}`} className="card-title">{entry.name}</Link>
    <p className="muted">{entry.path}</p>
    <ActivityScope scope={scope} />
    <div className="card-actions"><Link href={`/workspaces/${entry.id}`}>All changes</Link><button className="text-button" disabled={busy} onClick={() => void remove()}>Forget</button></div>
  </article>;
}
