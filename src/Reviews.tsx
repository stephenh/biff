import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useSearch } from "wouter";
import type { Conversation, DraftComment, GitHubReview, LocalReview, ReviewLine, WorkingCopy } from "../shared/types";
import { post, useResource } from "./api";
import { Viewer } from "./Viewer";
import type { ViewerProps } from "./Viewer";
import type { FileDiffContentsLoader, FileDiffLoadedFiles } from "@pierre/diffs";
import { ReviewPanel } from "./ReviewPanel";
import { GitHubViewer } from "./GitHubViewer";
import { useReviewDraft } from "./reviewDraft";
import { CommentOverlay } from "./CommentOverlay";
import type { CommentSelection, LineThread } from "./lineComments";

/** Local review URLs carry the workspace and revision, including mutable @ and @-. */
export function WorkingCopyReview(props: { id: string }) {
  const revision = new URLSearchParams(useSearch()).get("rev") || "@";
  const [, navigate] = useLocation();
  const resource = useResource<LocalReview>(`/api/workspaces/${props.id}/review?rev=${encodeURIComponent(revision)}`);
  const workspaces = useResource<WorkingCopy[]>("/api/workspaces");
  const data = resource.data;

  useReviewTitle(data ? `${data.workspace.name} / ${data.bookmark || `${revision} · ${data.selected.change_id.slice(0, 8)}`}` : "Working copy");

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
    {data && <PatchViewer key={`${props.id}:${revision}:${resource.version}`} patch={data.patch} source={`${data.workspace.name} · ${revision} · ${data.selected.description.trim() || "(no description)"}`} loadDiffFiles={(file) => post<FileDiffLoadedFiles>(`/api/workspaces/${props.id}/contents`, { commit: data.selected.commit_id, path: file.name })} />}
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
  const data = resource.data;

  useReviewTitle(`${repository} / ${data?.pr.head.ref || `PR #${props.number}`}${commit === "all" ? "" : ` · ${commit.slice(0, 8)}`}`);

  return <section className="review-page">
    <div className="source-toolbar">
      <Link href="/prs">← PRs</Link><div className="pr-title"><strong>{data?.pr.title || `PR #${props.number}`}</strong><span className="muted">{repository} #{props.number}</span></div>
      <select aria-label="PR commit" value={commit} onChange={(event) => navigate(`/pr/${repository}/${props.number}?commit=${event.target.value}`)}>
        <option value="all">All changes</option>{data?.commits.map((entry) => <option key={entry.sha} value={entry.sha}>{entry.sha.slice(0, 8)} · {entry.commit.message.split("\n")[0]}</option>)}
        {commit !== "all" && !data?.commits.some((entry) => entry.sha === commit) && <option value={commit}>{commit.slice(0, 8)}</option>}
      </select>
      <button disabled={resource.loading} onClick={resource.refresh}>Refresh</button>
      <button onClick={() => setPanelOpen((open) => !open)}>Discussion & review</button>
      <a href={`https://github.com/${repository}/pull/${props.number}`} target="_blank" rel="noreferrer">GitHub ↗</a>
    </div>
    <LoadState loading={resource.loading} error={resource.error} />
    {data && <PullRequestContent key={`${endpoint}:${commit}:${resource.version}`} endpoint={endpoint} review={data} source={`${repository} #${props.number} · ${commit === "all" ? "all changes" : commit.slice(0, 8)}`} panelOpen={panelOpen} onClosePanel={() => setPanelOpen(false)} />}
  </section>;
}

/**
 * Share discussion and review drafts between the diff, overlay, and summary panel.
 *
 * Keep PR-level thread coordinates out of single-commit views, where line numbers
 * can describe a different version of the file.
 */
function PullRequestContent(props: { endpoint: string; review: GitHubReview; source: string; panelOpen: boolean; onClosePanel(): void }) {
  const draftState = useReviewDraft(props.endpoint, props.review.pr.head.sha);
  const conversation = useResource<Conversation>(`${props.endpoint}/conversation`);
  const [selected, setSelected] = useState<ReviewLine>();
  const [focus, setFocus] = useState<ReviewLine & { request: number }>();
  const [active, setActive] = useState<CommentSelection>();
  const [bodies, setBodies] = useState<Record<string, string>>({});
  const stale = draftState.draft.commitId !== props.review.pr.head.sha;
  const threads = useMemo(() => buildThreads(conversation.data, stale ? [] : draftState.draft.comments), [conversation.data, draftState.draft.comments, stale]);
  const thread = threads.find((entry) => entry.id === active?.threadId);
  const bodyKey = active ? `${active.line.path}:${active.line.side}:${active.line.line}:${active.threadId ?? "new"}` : "";
  const body = bodies[bodyKey] ?? (thread?.draftIndex !== undefined ? thread.comments[0].body : "");
  const loadDiffFiles: FileDiffContentsLoader = loadContents;

  /** Load context against the SHAs shown by this review, even after a new push. */
  function loadContents(file: Parameters<FileDiffContentsLoader>[0]) {
    return post<FileDiffLoadedFiles>(`${props.endpoint}/contents`, { head: props.review.commit === "all" ? props.review.pr.head.sha : props.review.commit, base: props.review.pr.base.sha, single: props.review.commit !== "all", path: file.name, oldPath: file.prevName ?? file.name });
  }

  /** Ignore repeated renderer callbacks for the same row. */
  function selectLine(line: ReviewLine) {
    setSelected((current) => current?.path === line.path && current.line === line.line && current.side === line.side ? current : line);
  }

  /** Close the discussion drawer so it cannot cover a line's floating composer. */
  function openComments(selection: CommentSelection) {
    props.onClosePanel();
    setActive(selection);
  }

  /** Focus a discussion's exact file coordinate without opening its composer. */
  function viewLine(line: ReviewLine) { setFocus({ ...line, request: Date.now() }); props.onClosePanel(); }

  /** A review comment remains private in the shared browser draft until submission. */
  function saveReviewComment() {
    if (!active || stale || !body.trim()) return;
    const comment = { ...active.line, body };
    draftState.setDraft((current) => ({ ...current, comments: thread?.draftIndex !== undefined ? current.comments.map((entry, index) => index === thread.draftIndex ? comment : entry) : [...current.comments, comment] }));
    clearComposer();
    setActive(undefined);
  }

  /** Publish new threads and replies through their distinct GitHub endpoints. */
  async function saveComment() {
    if (!active || !body.trim()) return;
    if (thread && thread.draftIndex === undefined) await post(`${props.endpoint}/comment`, { body, replyTo: thread.comments[0].id });
    else await post(`${props.endpoint}/inline-comment`, { commitId: props.review.pr.head.sha, comment: { ...active.line, body } });
    if (thread?.draftIndex !== undefined) draftState.setDraft((current) => ({ ...current, comments: current.comments.filter((_, index) => index !== thread.draftIndex) }));
    clearComposer();
    conversation.refresh();
    setActive(undefined);
  }

  /** Remove saved text so reopening a review draft reads its latest saved body. */
  function clearComposer() {
    setBodies((current) => {
      const next = { ...current };
      delete next[bodyKey];
      return next;
    });
  }

  return <>
    {props.review.patch.trim() ? props.review.commit === "all" ? <GitHubViewer endpoint={props.endpoint} patch={props.review.patch} source={props.source} allowImport={false} onSelectLine={selectLine} focus={focus} inlineThreads={threads} onOpenComments={openComments} loadDiffFiles={loadDiffFiles} /> : <Viewer patch={props.review.patch} source={props.source} allowImport={false} loadDiffFiles={loadDiffFiles} /> : <div className="empty-state"><h2>No changes</h2><p>This revision has an empty diff.</p></div>}
    {conversation.error && !props.panelOpen && <p className="error" role="alert">Could not load comments: {conversation.error} <button onClick={conversation.refresh}>Retry</button></p>}
    {props.panelOpen && <ReviewPanel endpoint={props.endpoint} review={props.review} selected={props.review.commit === "all" ? selected : undefined} onClose={props.onClosePanel} onViewLine={viewLine} draftState={draftState} conversation={conversation} onCompose={(line) => openComments({ line })} />}
    {active && <CommentOverlay key={bodyKey} endpoint={props.endpoint} selection={active} thread={thread} threads={threads} onSelectThread={(entry) => setActive({ ...active, line: entry.location, threadId: entry.id })} body={body} onBodyChange={(value) => setBodies((current) => ({ ...current, [bodyKey]: value }))} stale={stale} storageError={draftState.storageError} onClose={() => setActive(undefined)} onSaveComment={saveComment} onSaveReviewComment={saveReviewComment} />}
  </>;
}

/** Empty working commits are normal and should not be reported as invalid patches. */
function PatchViewer(props: ViewerProps & { patch: string; source: string }) {
  if (!props.patch.trim()) return <div className="empty-state"><h2>No changes</h2><p>This revision has an empty diff. Choose another revision or refresh after editing.</p></div>;
  return <Viewer {...props} allowImport={false} />;
}

/** Group replies under their roots and give local review comments their own previews. */
function buildThreads(conversation: Conversation | undefined, drafts: DraftComment[]): LineThread[] {
  const inline = conversation?.inline ?? [];
  const threads: LineThread[] = inline.filter((entry) => !entry.in_reply_to_id && entry.path && entry.line != null).map((entry) => ({
    id: `comment-${entry.id}`, location: { path: entry.path!, line: entry.line!, side: entry.side ?? "RIGHT" },
    comments: [entry, ...inline.filter((reply) => reply.in_reply_to_id === entry.id)],
  }));
  return [...threads, ...drafts.map((draft, index) => ({ id: `draft-${index}`, location: draft, draftIndex: index, comments: [{ id: -index - 1, body: draft.body, user: { login: "You (draft)" }, html_url: "" }] }))];
}

function LoadState(props: { loading: boolean; error?: string }) {
  if (props.error) return <p className="error" role="alert">{props.error}</p>;
  return props.loading ? <p className="loading-state" role="status">Loading review…</p> : null;
}

/** Keep each review tab identifiable and restore the app title on leaving it. */
function useReviewTitle(title: string) {
  useEffect(() => {
    const previous = document.title;
    document.title = `${title} — Biff`;
    return () => { document.title = previous; };
  }, [title]);
}
