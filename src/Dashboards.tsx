import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useSearch } from "wouter";
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

/** Lightweight review queues with ordinary links that work in new tabs. */
export function PullRequests() {
  const [, navigate] = useLocation();
  const search = new URLSearchParams(useSearch());
  const view = search.get("view") === "requested" ? "requested" : "authored";
  const resource = useResource<PullRequestSummary[]>(`/api/github/prs?view=${view}`);
  const [filter, setFilter] = useState("");
  const [prUrl, setPrUrl] = useState("");
  const list = useRef<HTMLDivElement>(null);
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/.*)?$/.exec(prUrl.trim());
  const path = match ? `/pr/${match[1]}/${match[2]}/${match[3]}` : undefined;
  const filtered = resource.data?.filter((pr) => `${pr.title} ${pr.repository.nameWithOwner} ${pr.number} ${pr.author.login}`.toLowerCase().includes(filter.trim().toLowerCase()));

  useEffect(() => {
    // An asynchronous queue load must not steal focus from someone already typing.
    if (document.activeElement?.closest("input, textarea, select, [contenteditable], [role=dialog], [popover]:popover-open") || list.current?.contains(document.activeElement)) return;
    list.current?.querySelector<HTMLAnchorElement>(".card-title")?.focus();
  }, [resource.data, view]);

  useEffect(() => {
    /** Switch queues horizontally and move link focus vertically so Enter stays native. */
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey ||
        !["j", "k", "h", "l", "g"].includes(event.key)) return;
      if (event.composedPath().some((target) => target instanceof HTMLElement && target.closest("input, textarea, select, [contenteditable]")) ||
        document.querySelector('dialog[open], [role="dialog"]:not([popover]), [popover]:popover-open')) return;

      if (event.key === "h" || event.key === "l") {
        event.preventDefault();
        navigate(event.key === "h" ? "/prs" : "/prs?view=requested");
        return;
      }

      const links = Array.from(list.current?.querySelectorAll<HTMLAnchorElement>(".card-title") ?? []);
      if (!links.length) return;
      const index = links.findIndex((link) => link.closest(".pr-card")?.contains(document.activeElement));
      if (event.key === "g") {
        if (index >= 0) {
          event.preventDefault();
          if (!event.repeat) window.open(links[index]!.dataset.githubUrl, "_blank", "noopener,noreferrer");
        }
        return;
      }
      const next = index < 0 ? 0 : Math.max(0, Math.min(links.length - 1, index + (event.key === "j" ? 1 : -1)));
      event.preventDefault();
      links[next]!.focus({ preventScroll: true });
      links[next]!.scrollIntoView({ block: "nearest" });
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigate]);

  return <main className="dashboard">
    <div className="page-heading"><div><h1>Pull Requests</h1><p>Your GitHub review queue, without leaving Biff.</p></div><button onClick={resource.refresh}>Refresh</button></div>
    <div className="dashboard-tools"><nav className="tabs"><Link className={view === "authored" ? "active" : ""} href="/prs">My open PRs</Link><Link className={view === "requested" ? "active" : ""} href="/prs?view=requested">Needs my review</Link></nav><input aria-label="Filter PRs" placeholder="Filter by author, repository, title, or number" value={filter} onChange={(event) => setFilter(event.target.value)} /></div>
    <form className="register-form" onSubmit={(event) => { event.preventDefault(); if (path) navigate(path); }}><input aria-label="GitHub PR URL" placeholder="Or paste any GitHub PR URL…" value={prUrl} onChange={(event) => setPrUrl(event.target.value)} />{path && <Link className="button-link" href={path}>Open PR</Link>}</form>
    {resource.error && <p role="alert" className="error">{resource.error}</p>}
    {resource.loading && <p role="status">Loading GitHub PRs…</p>}
    <div className="pr-list" ref={list} onKeyDown={(event) => {
      if (event.key !== "Enter" || !event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || event.nativeEvent.isComposing) return;
      const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a.card-title") : null;
      if (!link) return;
      event.preventDefault();
      if (!event.repeat) window.open(link.href, "_blank", "noopener,noreferrer");
    }}>{filtered?.map((pr) => <article className="pr-card" key={pr.url}>
      <div><span className={`badge ${pr.isDraft ? "draft" : "open"}`}>{pr.isDraft ? "Draft" : "Open"}</span><Link className="card-title" href={prPath(pr)} data-github-url={pr.url}>{pr.title}</Link><p className="muted">{pr.repository.nameWithOwner} #{pr.number} · {pr.author.login} · updated {new Date(pr.updatedAt).toLocaleDateString()}</p></div>
      <a href={prPath(pr)} target="_blank" rel="noreferrer" aria-label={`Open PR ${pr.number} in new tab`}>↗</a>
    </article>)}</div>
    {filtered?.length === 0 && <p className="empty-state">No matching open PRs.</p>}
    {resource.data?.length === 100 && <p className="muted">Showing the 100 most recently updated PRs.</p>}
  </main>;
}

function prPath(pr: PullRequestSummary) { return `/pr/${pr.repository.nameWithOwner}/${pr.number}`; }
