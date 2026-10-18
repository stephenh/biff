import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useLocation, useSearch } from "wouter";
import type { Conversation, DraftComment, GitHubReview, LocalReview, ReviewLine, StackPosition } from "../shared/types";
import { post, useResource } from "./api";
import { SearchControlTarget, Viewer } from "./Viewer";
import type { ViewerProps } from "./Viewer";
import type { FileDiffContentsLoader, FileDiffLoadedFiles } from "@pierre/diffs";
import { ReviewPanel } from "./ReviewPanel";
import { GitHubViewer } from "./GitHubViewer";
import { useReviewDraft } from "./reviewDraft";
import { CommentOverlay } from "./CommentOverlay";
import type { CommentSelection, LineThread } from "./lineComments";
import { LinkedLocalReview, ReviewLifetime } from "./ReviewLifetime";
import { useLocalDiscussion } from "./LocalDiscussion";
import { useCommentReads } from "./useCommentReads";
import { useInboxRead } from "./useInboxRead";

/** Local review URLs carry the workspace and revision, including mutable @ and @-. */
export function WorkingCopyReview(props: { id: string }) {
  const search = useSearch();
  const revision = new URLSearchParams(search).get("rev") || "all";
  const resource = useResource<LocalReview>(`/api/workspaces/${props.id}/review?${search}`);
  return <WorkspaceReviewView id={props.id} revision={revision} data={resource.data} loading={resource.loading} error={resource.error} />;
}

/** One workspace view owns navigation, source loading, and progress, with optional collaboration controls. */
export function WorkspaceReviewView(props: {
  id: string; revision: string; data?: LocalReview; loading?: boolean; error?: string;
  controls?: ReactNode; children?: ReactNode; viewer?: Pick<ViewerProps, "inlineThreads" | "onOpenComments" | "onOpenFollowUpThread" | "followUpThreadsReady">;
}) {
  const [, navigate] = useLocation();
  const data = props.data;
  const revision = props.revision;
  const query = new URLSearchParams(useSearch());
  const baseValue = data?.baseOverride || query.get("base") || "";
  const [baseInput, setBaseInput] = useState(baseValue);
  const [searchControlTarget, setSearchControlTarget] = useState<HTMLSpanElement | null>(null);
  useEffect(() => { setBaseInput(baseValue); }, [baseValue]);
  const local = useLocalDiscussion(!props.viewer && data?.identity ? `/api/workspaces/${props.id}/changes/${data.progressScope}` : undefined, { commitId: data?.selected.commit_id, baseCommitId: data?.base?.commit_id });

  /** Keep bookmark and base selection when inspecting an individual commit. */
  function selectRange(bookmark: string, changes = "all", base = data?.baseOverride || "") {
    const query = new URLSearchParams({ bookmark, changes });
    // Keep descendant commits selectable when changing the base or commit of an inferred range.
    if (data?.followWorkingCopy && bookmark === data.bookmark) query.set("follow", "1");
    if (base) query.set("base", base);
    navigate(`/workspaces/${props.id}?${query}`);
  }

  useReviewTitle(data ? `${data.workspace.name} / ${data.bookmark || `${revision} · ${data.selected.change_id.slice(0, 8)}`}` : "Working copy");

  return <SearchControlTarget.Provider value={searchControlTarget}><section className="review-page">
    <div className="source-toolbar">
      <div className="review-title">
        <strong>{data?.tip ? <select className="review-title-select" aria-label="Bookmark" value={data.bookmark || ""} onChange={(event) => selectRange(event.target.value)}><option value="">@</option>{data.bookmarks?.map((name) => <option key={name}>{name}</option>)}</select>
        : <select className="review-title-select" aria-label="JJ revision" value={revision} onChange={(event) => navigate(`/workspaces/${props.id}?rev=${encodeURIComponent(event.target.value)}`)}>
        <option value="@">@ · working commit</option><option value="@-">@- · previous commit</option>
        {data?.revisions.map((entry) => <option key={entry.commit_id} value={entry.change_id}>{entry.change_id.slice(0, 8)} · {entry.description.trim().split("\n")[0] || "(no description)"}</option>)}
        {revision !== "@" && revision !== "@-" && !data?.revisions.some((entry) => entry.change_id === revision) && <option value={revision}>{revision}</option>}
        </select>}</strong>
        <div className="review-metadata"><span className="muted">{data?.workspace.name || "Working copy"}</span></div>
      </div>
      {(data?.tip || revision === "all") && <details className="base-override">
        <summary className="muted" title={data?.base?.commit_id}>Base: {data?.baseLabel || baseValue || "automatic"}{!baseValue && data?.baseLabel ? " (automatic)" : ""}</summary>
        <form onSubmit={(event) => { event.preventDefault(); selectRange(data?.bookmark || query.get("bookmark") || "", "all", baseInput.trim()); event.currentTarget.closest("details")?.removeAttribute("open"); }}>
          <label>Override base <input aria-label="Base revision" placeholder="Bookmark or revision; Enter to save" value={baseInput} onChange={(event) => setBaseInput(event.target.value)} /></label>
          <button type="button" onClick={() => { setBaseInput(""); selectRange(data?.bookmark || query.get("bookmark") || "", "all", ""); }}>Use automatic base</button>
        </form>
      </details>}
      {data && <span className="muted" title={data.selected.commit_id}>{data.selected.commit_id.slice(0, 8)}</span>}
      <div className="review-toolbar-actions">
        {data?.tip && <select aria-label="Changes" value={data.changes} onChange={(event) => selectRange(data.bookmark || "", event.target.value)}><option value="all">All changes</option>{data.revisions.map((entry) => <option key={entry.commit_id} value={entry.change_id}>{entry.change_id.slice(0, 8)} · {entry.description.trim().split("\n")[0] || "(no description)"}</option>)}</select>}
        <span ref={setSearchControlTarget} />
        {props.controls}
        {local.controls}
        {data?.identity && <ReviewLifetime key={data.identity.id} snapshot={data} endpoint={`/api/workspaces/${props.id}/changes/${data.progressScope}`} />}
      </div>
    </div>
    <LoadState loading={Boolean(props.loading)} error={props.error} />
    {data && <PatchViewer key={`${props.id}:${data.selected.commit_id}:${data.base?.commit_id}:${data.changes}`} inlineThreads={local.threads} onOpenComments={data.identity ? local.open : undefined} onOpenFollowUpThread={(id) => { if (id.startsWith("local:")) local.openFollowUp(id); else if (data.identity?.pr) navigate(`/pr/${data.identity.pr}?followUp=${encodeURIComponent(id)}`); }} {...props.viewer} progressEndpoint={`/api/workspaces/${props.id}/changes/${data.progressScope || data.selected.change_id}`} progressHead={data.selected.commit_id} patch={data.patch} source={`${data.workspace.name} · ${data.tip ? data.bookmark || "@" : revision} · ${data.selected.description.trim() || "(no description)"}`} loadDiffFiles={(file) => post<FileDiffLoadedFiles>(`/api/workspaces/${props.id}/contents`, { commit: data.selected.commit_id, base: data.changes === "all" ? data.base?.commit_id : undefined, path: file.name })} />}
    {local.content}
    {props.children}
  </section></SearchControlTarget.Provider>;
}

/** One PR view supports the complete diff, individual commits, and a review drawer. */
export function PullRequestReview(props: { owner: string; repo: string; number: string }) {
  const repository = `${props.owner}/${props.repo}`;
  const endpoint = `/api/github/pr/${repository}/${props.number}`;
  const commit = new URLSearchParams(useSearch()).get("commit") || "all";
  const [, navigate] = useLocation();
  const resource = useResource<GitHubReview>(`${endpoint}/review?commit=${encodeURIComponent(commit)}`);
  const stack = useResource<StackPosition | null>(`${endpoint}/stack`);
  const [panelOpen, setPanelOpen] = useState(false);
  const [stackOpen, setStackOpen] = useState(false);
  const [searchControlTarget, setSearchControlTarget] = useState<HTMLSpanElement | null>(null);
  const data = resource.data;

  useReviewTitle(`${props.repo} ${data?.pr.title || `PR #${props.number}`}${commit === "all" ? "" : ` · ${commit.slice(0, 8)}`}`);

  return <SearchControlTarget.Provider value={searchControlTarget}><section className="review-page">
    <div className="source-toolbar">
      <div className="review-title">
        <strong>{data?.pr.title || `PR #${props.number}`}</strong>
        <div className="review-metadata">
          <span className="muted">{repository} #{props.number} {stack.data && <span className="pr-stack">
            <button className="pr-stack-trigger" title="Switch PR in the stack" aria-label={`Stack position ${stack.data.position} of ${stack.data.total}`} aria-expanded={stackOpen} onMouseDown={(event) => { if (stackOpen) event.preventDefault(); }} onClick={() => setStackOpen((open) => !open)}>{stack.data.position} / {stack.data.total}</button>
            {stackOpen && <select autoFocus className="pr-stack-select" aria-label="Stack PR" value={props.number} onBlur={() => setStackOpen(false)} onKeyDown={(event) => {
              if (event.key === "Escape") {
                setStackOpen(false);
                const trigger = event.currentTarget.previousElementSibling;
                if (trigger instanceof HTMLElement) trigger.focus();
              }
            }} onChange={(event) => { setStackOpen(false); navigate(`/pr/${repository}/${event.target.value}`); }}>
              {stack.data.pulls.map((pr, index) => <option key={pr.number} value={pr.number}>{index + 1}. #{pr.number} · {pr.title}</option>)}
            </select>}
          </span>}</span>
        </div>
      </div>
      <select aria-label="PR commit" value={commit} onChange={(event) => navigate(`/pr/${repository}/${props.number}?commit=${event.target.value}`)}>
        <option value="all">All changes</option>{data?.commits.map((entry) => <option key={entry.sha} value={entry.sha}>{entry.sha.slice(0, 8)} · {entry.commit.message.split("\n")[0]}</option>)}
        {commit !== "all" && !data?.commits.some((entry) => entry.sha === commit) && <option value={commit}>{commit.slice(0, 8)}</option>}
      </select>
      <span ref={setSearchControlTarget} />
      <button onClick={() => setPanelOpen((open) => !open)}>Discussion & review</button>
      <a className="pr-github-link" href={`https://github.com/${repository}/pull/${props.number}`} target="_blank" rel="noreferrer">GitHub ↗</a>
      {data && !resource.loading && <LinkedLocalReview key={resource.version} endpoint={endpoint} base={data.pr.base.ref} />}
    </div>
    <LoadState loading={resource.loading} error={resource.error} />
    {data && <PullRequestContent key={`${endpoint}:${commit}:${resource.version}`} endpoint={endpoint} review={data} source={`${repository} #${props.number} · ${commit === "all" ? "all changes" : commit.slice(0, 8)}`} panelOpen={panelOpen} onClosePanel={() => setPanelOpen(false)} />}
  </section></SearchControlTarget.Provider>;
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
  const [focus, setFocus] = useState<ReviewLine & { request: number }>();
  const [active, setActive] = useState<CommentSelection>();
  const [bodies, setBodies] = useState<Record<string, string>>({});
  const stale = draftState.draft.commitId !== props.review.pr.head.sha;
  const threads = useMemo(() => buildThreads(conversation.data, stale ? [] : draftState.draft.comments), [conversation.data, draftState.draft.comments, stale]);
  const thread = threads.find((entry) => entry.id === active?.threadId);
  const bodyKey = active ? `${active.line.path}:${active.line.side}:${active.line.line}:${active.threadId ?? "new"}` : "";
  const body = bodies[bodyKey] ?? (thread?.draftIndex !== undefined ? thread.comments[0].body : "");
  const loadDiffFiles: FileDiffContentsLoader = loadContents;
  const local = useLocalDiscussion(props.review.commit === "all" ? props.endpoint : undefined, { commitId: props.review.pr.head.sha, baseCommitId: props.review.pr.base.sha }, conversation.refresh, openLocalThread);
  const reads = useCommentReads(props.endpoint, threads, active?.threadId);
  const visibleThreads = useMemo(() => [...reads.threads.filter((thread) => !thread.outdated), ...local.threads], [reads.threads, local.threads]);

  /** Outdated GitHub discussions remain accessible even when their line no longer exists. */
  function openFollowUpThread(id: string) {
    props.onClosePanel();
    if (id.startsWith("local:")) { local.openFollowUp(id); return; }
    const target = threads.find((entry) => `github:${entry.comments[0]?.id}` === id);
    if (target) {
      if (!target.outdated) viewLine(target.location);
      setActive({ threadId: target.id, line: target.location });
    }
  }
  const inboxEvents = props.panelOpen && conversation.data ? [
    ...conversation.data.comments.map((comment) => `general:${comment.id}`),
    ...conversation.data.inline.map((comment) => `inline:${comment.id}`),
    ...conversation.data.reviews.filter((review) => review.state !== "PENDING").map((review) => `review:${review.id}`),
  ] : (thread?.comments ?? []).filter((comment) => typeof comment.id === "number" && comment.id > 0).map((comment) => `inline:${comment.id}`);
  const inboxError = useInboxRead(props.endpoint, props.review.commit === "all" ? props.review.pr.head.sha : undefined, inboxEvents);

  /** Load context against the SHAs shown by this review, even after a new push. */
  function loadContents(file: Parameters<FileDiffContentsLoader>[0]) {
    return post<FileDiffLoadedFiles>(`${props.endpoint}/contents`, { head: props.review.commit === "all" ? props.review.pr.head.sha : props.review.commit, base: props.review.pr.base.sha, single: props.review.commit !== "all", path: file.name, oldPath: file.prevName ?? file.name });
  }

  /** Close the discussion drawer so it cannot cover a line's floating composer. */
  function openComments(selection: CommentSelection) {
    props.onClosePanel();
    if (selection.threadId?.startsWith("local:")) local.open(selection);
    else setActive(selection);
  }

  /** Focus a discussion's exact file coordinate without opening its composer. */
  function viewLine(line: ReviewLine) { setFocus({ ...line, request: Date.now() }); props.onClosePanel(); }

  /** Navigate using the root comment's coordinates, including when a reply was clicked. */
  function openThread(id: string, line: ReviewLine) {
    viewLine(line);
    openComments({ line, threadId: id });
  }

  /** Local threads share the same navigation but retain their local reply composer. */
  function openLocalThread(selection: CommentSelection) {
    viewLine(selection.line);
    local.open(selection);
  }

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

  /** Save a PR-side note to the same durable local discussion without a GitHub write. */
  async function saveLocalComment() {
    if (!active || !body.trim()) return;
    await local.create(active, body);
    clearComposer();
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
    {local.content}
    {inboxError && <p role="alert" className="error">{inboxError}</p>}
    {reads.error && <p role="alert" className="error">Could not save or load comment read state: {reads.error}</p>}
    {props.review.patch.trim() ? props.review.commit === "all" ? <GitHubViewer endpoint={props.endpoint} progressEndpoint={props.endpoint} progressHead={props.review.pr.head.sha} patch={props.review.patch} source={props.source} allowImport={false} focus={focus} inlineThreads={visibleThreads} onOpenComments={openComments} onOpenFollowUpThread={openFollowUpThread} followUpThreadsReady={Boolean(conversation.data) && local.ready} loadDiffFiles={loadDiffFiles} whitespaceHidden /> : <Viewer patch={props.review.patch} source={props.source} allowImport={false} loadDiffFiles={loadDiffFiles} whitespaceHidden /> : <div className="empty-state"><h2>No changes</h2><p>This revision has an empty diff.</p></div>}
    {conversation.error && !props.panelOpen && <p className="error" role="alert">Could not load comments: {conversation.error} <button onClick={conversation.refresh}>Retry</button></p>}
    {props.panelOpen && <ReviewPanel localDiscussion={local.discussion} endpoint={props.endpoint} review={props.review} onClose={props.onClosePanel} onViewLine={viewLine} onOpenThread={openThread} draftState={draftState} conversation={conversation} />}
    {active && <CommentOverlay key={bodyKey} endpoint={props.endpoint} selection={active} thread={thread} threads={threads} onSelectThread={(entry) => setActive({ ...active, line: entry.location, threadId: entry.id })} body={body} onBodyChange={(value) => setBodies((current) => ({ ...current, [bodyKey]: value }))} stale={stale} storageError={draftState.storageError} onClose={() => setActive(undefined)} onSaveComment={saveComment} onSaveReviewComment={saveReviewComment} onSaveLocalComment={saveLocalComment} onCommentChanged={conversation.refresh} />}
  </>;
}

/** Empty working commits are normal and should not be reported as invalid patches. */
function PatchViewer(props: ViewerProps & { patch: string; source: string }) {
  if (!props.patch.trim()) return <div className="empty-state"><h2>No changes</h2><p>This revision has an empty diff. Choose another revision or refresh after editing.</p></div>;
  return <Viewer {...props} allowImport={false} whitespaceHidden />;
}

/** Group replies under their roots and give local review comments their own previews. */
function buildThreads(conversation: Conversation | undefined, drafts: DraftComment[]): LineThread[] {
  const inline = conversation?.inline ?? [];
  const threads: LineThread[] = inline.filter((entry) => !entry.in_reply_to_id && entry.path).map((entry) => ({
    id: `comment-${entry.id}`, location: { path: entry.path!, line: entry.line ?? entry.original_line ?? 1, side: entry.side ?? "RIGHT" }, outdated: entry.line == null,
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
