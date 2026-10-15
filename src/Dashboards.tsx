import { useState } from "react";
import { Link, useSearch } from "wouter";
import type { PullRequestSummary, WorkingCopy } from "../shared/types";
import { post, request, useResource } from "./api";

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
      <button disabled={busy || !path.trim()}>Add working copy</button>
      <button type="button" disabled={busy || !path.trim()} onClick={() => void add(true)}>Discover in folder</button>
    </form>
    <p className="muted">Run <code>biff</code> from a JJ working copy to register and open it. Or discover repositories inside a folder such as <code>~/homebound</code>.</p>
    {(error || resource.error) && <p role="alert" className="error">{error || resource.error}</p>}
    {resource.loading && <p role="status">Loading working copies…</p>}
    <div className="workspace-grid">{resource.data?.map((entry) => <article className="workspace-card" key={entry.id}>
      <Link href={`/workspaces/${entry.id}?rev=@`} className="card-title">{entry.name}</Link>
      <p className="muted">{entry.path}</p>
      <div className="card-actions"><Link href={`/workspaces/${entry.id}?rev=@`}>Working commit @</Link><Link href={`/workspaces/${entry.id}?rev=@-`}>Previous @-</Link><a href={`/workspaces/${entry.id}?rev=@`} target="_blank" rel="noreferrer">New tab ↗</a><button className="text-button" onClick={() => void remove(entry.id)}>Forget</button></div>
    </article>)}</div>
    {resource.data?.length === 0 && <p className="empty-state">Add your first working copy above.</p>}
  </main>;
}

/** Lightweight review queues with ordinary links that work in new tabs. */
export function PullRequests() {
  const search = new URLSearchParams(useSearch());
  const view = search.get("view") === "requested" ? "requested" : "authored";
  const resource = useResource<PullRequestSummary[]>(`/api/github/prs?view=${view}`);
  const [filter, setFilter] = useState("");
  const [prUrl, setPrUrl] = useState("");
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/.*)?$/.exec(prUrl.trim());
  const filtered = resource.data?.filter((pr) => `${pr.title} ${pr.repository.nameWithOwner} ${pr.number} ${pr.author.login}`.toLowerCase().includes(filter.trim().toLowerCase()));

  return <main className="dashboard">
    <div className="page-heading"><div><h1>Pull Requests</h1><p>Your GitHub review queue, without leaving Biff.</p></div><button onClick={resource.refresh}>Refresh</button></div>
    <div className="dashboard-tools"><nav className="tabs"><Link className={view === "authored" ? "active" : ""} href="/prs">My open PRs</Link><Link className={view === "requested" ? "active" : ""} href="/prs?view=requested">Needs my review</Link></nav><input aria-label="Filter PRs" placeholder="Filter by author, repository, title, or number" value={filter} onChange={(event) => setFilter(event.target.value)} /></div>
    <div className="register-form"><input aria-label="GitHub PR URL" placeholder="Or paste any GitHub PR URL…" value={prUrl} onChange={(event) => setPrUrl(event.target.value)} />{match && <Link className="button-link" href={`/pr/${match[1]}/${match[2]}/${match[3]}`}>Open PR</Link>}</div>
    {resource.error && <p role="alert" className="error">{resource.error}</p>}
    {resource.loading && <p role="status">Loading GitHub PRs…</p>}
    <div className="pr-list">{filtered?.map((pr) => <article className="pr-card" key={pr.url}>
      <div><span className={`badge ${pr.isDraft ? "draft" : "open"}`}>{pr.isDraft ? "Draft" : "Open"}</span><Link className="card-title" href={prPath(pr)}>{pr.title}</Link><p className="muted">{pr.repository.nameWithOwner} #{pr.number} · {pr.author.login} · updated {new Date(pr.updatedAt).toLocaleDateString()}</p></div>
      <a href={prPath(pr)} target="_blank" rel="noreferrer" aria-label={`Open PR ${pr.number} in new tab`}>↗</a>
    </article>)}</div>
    {filtered?.length === 0 && <p className="empty-state">No matching open PRs.</p>}
    {resource.data?.length === 100 && <p className="muted">Showing the 100 most recently updated PRs.</p>}
  </main>;
}

function prPath(pr: PullRequestSummary) { return `/pr/${pr.repository.nameWithOwner}/${pr.number}`; }
