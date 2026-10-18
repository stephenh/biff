import { useState } from "react";
import { Link } from "wouter";
import type { WorkingCopy } from "../shared/types";
import { post, request, useResource } from "./api";
export { PullRequests } from "./PullRequests";

/** Persistent entry points to stable local repository directories. */
export function WorkingCopies() {
  const resource = useResource<WorkingCopy[]>("/api/workspaces");
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function add(discover: boolean) {
    setBusy(true); setError("");
    try {
      await post(`/api/workspaces${discover ? "/discover" : ""}`, { path });
      setPath(""); resource.refresh();
    } catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  }

  async function remove(id: string) {
    try { await request(`/api/workspaces/${id}`, { method: "DELETE" }); resource.refresh(); }
    catch (error) { setError((error as Error).message); }
  }

  return <main className="dashboard">
    <div className="page-heading"><div><h1>Working Copies</h1><p>Your repositories. Pick up where the code is.</p></div><button onClick={resource.refresh}>Refresh</button></div>
    <form className="register-form" onSubmit={(event) => { event.preventDefault(); void add(false); }}>
      <input aria-label="Working copy path" placeholder="~/homebound/graphql-service" value={path} onChange={(event) => setPath(event.target.value)} />
      <button className="primary" disabled={busy || !path.trim()}>Add working copy</button>
      <button type="button" disabled={busy || !path.trim()} onClick={() => void add(true)}>Discover in folder</button>
    </form>
    <p className="muted">Run <code>biff</code> from a JJ working copy to register and open it. Or discover repositories inside a folder such as <code>~/homebound</code>.</p>
    {(error || resource.error) && <p role="alert" className="error">{error || resource.error}</p>}
    {resource.loading && <p role="status">Loading working copies…</p>}
    <div className="workspace-grid">{resource.data?.map((entry) => <article className="workspace-card" key={entry.id}>
      <Link href={`/workspaces/${entry.id}`} className="card-title">{entry.name}</Link>
      <p className="muted">{entry.path}</p>
      <div className="card-actions"><Link href={`/workspaces/${entry.id}`}>All changes</Link><button className="text-button" onClick={() => void remove(entry.id)}>Forget</button></div>
    </article>)}</div>
    {resource.data?.length === 0 && <p className="empty-state">Add your first working copy above.</p>}
  </main>;
}
