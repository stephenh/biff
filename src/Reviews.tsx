import { useState } from "react";
import { Link, useLocation, useSearch } from "wouter";
import type { GitHubReview, LocalReview, ReviewLine, WorkingCopy } from "../shared/types";
import { useResource } from "./api";
import { Viewer } from "./Viewer";
import { ReviewPanel } from "./ReviewPanel";

/** Local review URLs carry the workspace and revision, including mutable @ and @-. */
export function WorkingCopyReview(props: { id: string }) {
  const revision = new URLSearchParams(useSearch()).get("rev") || "@";
  const [, navigate] = useLocation();
  const resource = useResource<LocalReview>(`/api/workspaces/${props.id}/review?rev=${encodeURIComponent(revision)}`);
  const workspaces = useResource<WorkingCopy[]>("/api/workspaces");
  const data = resource.data;

  return <section className="review-page">
    <div className="source-toolbar">
      <label>Working copy <select aria-label="Working copy" value={props.id} onChange={(event) => navigate(`/workspaces/${event.target.value}?rev=@`)}>{workspaces.data?.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</select></label>
      <label>Revision <select aria-label="JJ revision" value={revision} onChange={(event) => navigate(`/workspaces/${props.id}?rev=${encodeURIComponent(event.target.value)}`)}>
        <option value="@">@ · working commit</option><option value="@-">@- · previous commit</option>
        {data?.revisions.map((entry) => <option key={entry.commit_id} value={entry.change_id}>{entry.change_id.slice(0, 8)} · {entry.description.trim().split("\n")[0] || "(no description)"}</option>)}
        {revision !== "@" && revision !== "@-" && !data?.revisions.some((entry) => entry.change_id === revision) && <option value={revision}>{revision}</option>}
      </select></label>
      <button disabled={resource.loading} onClick={resource.refresh}>Refresh</button>
      <a href={`/workspaces/${props.id}?rev=${encodeURIComponent(revision)}`} target="_blank" rel="noreferrer">New tab ↗</a>
      {data && <span className="muted" title={data.selected.commit_id}>{data.selected.commit_id.slice(0, 8)}</span>}
    </div>
    <LoadState loading={resource.loading} error={resource.error} />
    {data && <PatchViewer key={`${props.id}:${revision}:${resource.version}`} patch={data.patch} source={`${data.workspace.name} · ${revision} · ${data.selected.description.trim() || "(no description)"}`} />}
  </section>;
}

/** One PR view supports the complete diff, individual commits, and a review drawer. */
export function PullRequestReview(props: { owner: string; repo: string; number: string }) {
  const repository = `${props.owner}/${props.repo}`;
  const endpoint = `/api/github/pr/${repository}/${props.number}`;
  const commit = new URLSearchParams(useSearch()).get("commit") || "all";
  const [, navigate] = useLocation();
  const resource = useResource<GitHubReview>(`${endpoint}/review?commit=${encodeURIComponent(commit)}`);
  const [panelOpen, setPanelOpen] = useState(false);
  const [selected, setSelected] = useState<ReviewLine>();
  const [focus, setFocus] = useState<ReviewLine & { request: number }>();
  const data = resource.data;

  /** Ignore repeated renderer callbacks for the same row. */
  function selectLine(line: ReviewLine) {
    setSelected((current) => current?.path === line.path && current.line === line.line && current.side === line.side ? current : line);
  }

  function viewLine(line: ReviewLine) { setFocus({ ...line, request: Date.now() }); setPanelOpen(false); }

  return <section className="review-page">
    <div className="source-toolbar">
      <Link href="/prs">← PRs</Link><strong className="pr-title">{data?.pr.title || `${repository} #${props.number}`}</strong>
      <select aria-label="PR commit" value={commit} onChange={(event) => { setSelected(undefined); navigate(`/pr/${repository}/${props.number}?commit=${event.target.value}`); }}>
        <option value="all">All changes</option>{data?.commits.map((entry) => <option key={entry.sha} value={entry.sha}>{entry.sha.slice(0, 8)} · {entry.commit.message.split("\n")[0]}</option>)}
        {commit !== "all" && !data?.commits.some((entry) => entry.sha === commit) && <option value={commit}>{commit.slice(0, 8)}</option>}
      </select>
      <button disabled={resource.loading} onClick={() => { setSelected(undefined); resource.refresh(); }}>Refresh</button>
      <button onClick={() => setPanelOpen((open) => !open)}>Discussion & review</button>
      <a href={`https://github.com/${repository}/pull/${props.number}`} target="_blank" rel="noreferrer">GitHub ↗</a>
    </div>
    <LoadState loading={resource.loading} error={resource.error} />
    {data && <PatchViewer key={`${endpoint}:${commit}:${resource.version}`} patch={data.patch} source={`${repository} #${props.number} · ${commit === "all" ? "all changes" : commit.slice(0, 8)}`} onSelectLine={selectLine} focus={focus} />}
    {data && panelOpen && <ReviewPanel key={endpoint} endpoint={endpoint} review={data} selected={commit === "all" ? selected : undefined} onClose={() => setPanelOpen(false)} onViewLine={viewLine} />}
  </section>;
}

/** Empty working commits are normal and should not be reported as invalid patches. */
function PatchViewer(props: { patch: string; source: string; onSelectLine?: (line: ReviewLine) => void; focus?: ReviewLine & { request: number } }) {
  if (!props.patch.trim()) return <div className="empty-state"><h2>No changes</h2><p>This revision has an empty diff. Choose another revision or refresh after editing.</p></div>;
  return <Viewer patch={props.patch} source={props.source} allowImport={false} onSelectLine={props.onSelectLine} focus={props.focus} />;
}

function LoadState(props: { loading: boolean; error?: string }) {
  if (props.error) return <p className="error" role="alert">{props.error}</p>;
  return props.loading ? <p className="loading-state" role="status">Loading review…</p> : null;
}
