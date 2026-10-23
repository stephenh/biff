import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation, useSearch } from "wouter";
import type { GitHubReview, LocalReview, ReviewLine, StackPosition } from "../shared/types";
import { post, useResource } from "./api";
import { SearchControlTarget, Viewer } from "./Viewer";
import type { ViewerProps } from "./Viewer";
import type { FileDiffContentsLoader, FileDiffLoadedFiles } from "@pierre/diffs";
import { PullRequestOverview } from "./PullRequestOverview";
import { PullRequestComments } from "./PullRequestComments";
import { GitHubCommentThread } from "./GitHubCommentThread";
import { GitHubViewer } from "./GitHubViewer";
import { removePublishedReviewComment, useReviewDraft } from "./reviewDraft";
import { CommentOverlay } from "./CommentOverlay";
import type { CommentSelection, LineThread } from "./lineComments";
import { LinkedLocalReview, ReviewLifetime } from "./ReviewLifetime";
import { useLocalDiscussion } from "./LocalDiscussion";
import { useCommentReads } from "./useCommentReads";
import { ReviewProgressTarget } from "./ReviewProgress";
import { backgroundSaves } from "./optimisticSave";
import { buildDiscussionThreads, buildThreads, saveThreadResolution } from "./githubCommentThreads";
import { useConversation } from "./useConversation";

interface ComposerBody { body: string }
interface CommentSubmission { entry?: ComposerBody; body: string; id: string }

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
  controls?: ReactNode; children?: ReactNode; viewer?: Pick<ViewerProps, "inlineThreads" | "commentThreads" | "commentContent" | "activeCommentId" | "onResolveComment" | "onOpenComments" | "onOpenFollowUpThread" | "followUpThreadsReady">;
}) {
  const [, navigate] = useLocation();
  const data = props.data;
  const revision = props.revision;
  const [searchControlTarget, setSearchControlTarget] = useState<HTMLSpanElement | null>(null);
  const [reviewProgressTarget, setReviewProgressTarget] = useState<HTMLDivElement | null>(null);
  const local = useLocalDiscussion(!props.viewer && data?.identity ? `/api/workspaces/${props.id}/changes/${data.progressScope}` : undefined, { commitId: data?.selected.commit_id, baseCommitId: data?.base?.commit_id });

  /** Keep the review range when inspecting an individual commit. */
  function selectRange(bookmark: string, changes = "all") {
    const query = new URLSearchParams({ bookmark, changes });
    // Keep descendant commits selectable when changing the base or commit of an inferred range.
    if (data?.followWorkingCopy && bookmark === data.bookmark) query.set("follow", "1");
    navigate(`/workspaces/${props.id}?${query}`);
  }

  useReviewTitle(data ? `${data.workspace.name} / ${data.bookmark || `${revision} · ${data.selected.change_id.slice(0, 8)}`}` : "Working copy");

  return <SearchControlTarget.Provider value={searchControlTarget}><ReviewProgressTarget.Provider value={reviewProgressTarget}><section className="review-page">
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
      {(data?.tip || revision === "all") && <span className="muted" title={data?.base?.commit_id}>Base: {data?.baseLabel || "automatic"}</span>}
      {data && <span className="muted" title={data.selected.commit_id}>{data.selected.commit_id.slice(0, 8)}</span>}
      <div className="review-progress-slot" ref={setReviewProgressTarget} />
      <div className="review-toolbar-actions">
        {data?.tip && <select aria-label="Changes" value={data.changes} onChange={(event) => selectRange(data.bookmark || "", event.target.value)}><option value="all">All changes</option>{data.revisions.map((entry) => <option key={entry.commit_id} value={entry.change_id}>{entry.change_id.slice(0, 8)} · {entry.description.trim().split("\n")[0] || "(no description)"}</option>)}</select>}
        <span ref={setSearchControlTarget} />
        {props.controls}
        {local.controls}
        {data?.identity && <ReviewLifetime key={data.identity.id} snapshot={data} endpoint={`/api/workspaces/${props.id}/changes/${data.progressScope}`} />}
      </div>
    </div>
    <LoadState loading={Boolean(props.loading)} error={props.error} />
    {data && <PatchViewer key={`${props.id}:${data.selected.commit_id}:${data.base?.commit_id}:${data.changes}`} inlineThreads={local.threads} commentThreads={local.allThreads} commentContent={local.commentContent} activeCommentId={local.activeThreadId} onResolveComment={local.resolveThread} onOpenComments={data.identity ? local.open : undefined} onOpenFollowUpThread={(id) => { if (id.startsWith("local:")) local.openFollowUp(id); else if (data.identity?.pr) navigate(`/pr/${data.identity.pr}?followUp=${encodeURIComponent(id)}`); }} {...props.viewer} progressEndpoint={`/api/workspaces/${props.id}/changes/${data.progressScope || data.selected.change_id}`} progressHead={data.selected.commit_id} patch={data.patch} source={`${data.workspace.name} · ${data.tip ? data.bookmark || "@" : revision} · ${data.selected.description.trim() || "(no description)"}`} loadDiffFiles={(file) => post<FileDiffLoadedFiles>(`/api/workspaces/${props.id}/contents`, { commit: data.selected.commit_id, base: data.changes === "all" ? data.base?.commit_id : undefined, path: file.name })} />}
    {local.content}
    {props.children}
  </section></ReviewProgressTarget.Provider></SearchControlTarget.Provider>;
}

/** One PR view supports the diff, a metadata overview, and the shared comment browser. */
export function PullRequestReview(props: { owner: string; repo: string; number: string }) {
  const repository = `${props.owner}/${props.repo}`;
  const endpoint = `/api/github/pr/${repository}/${props.number}`;
  const commit = new URLSearchParams(useSearch()).get("commit") || "all";
  const [, navigate] = useLocation();
  const resource = useResource<GitHubReview>(`${endpoint}/review?commit=${encodeURIComponent(commit)}`);
  const stack = useResource<StackPosition | null>(`${endpoint}/stack`);
  const [panelOpen, setPanelOpen] = useState<"overview" | "comments" | undefined>(new URLSearchParams(useSearch()).get("comments") === "unread" ? "comments" : undefined);
  const [stackOpen, setStackOpen] = useState(false);
  const [searchControlTarget, setSearchControlTarget] = useState<HTMLSpanElement | null>(null);
  const [reviewProgressTarget, setReviewProgressTarget] = useState<HTMLDivElement | null>(null);
  const data = resource.data;

  useReviewTitle(`${props.repo} ${data?.pr.title || `PR #${props.number}`}${commit === "all" ? "" : ` · ${commit.slice(0, 8)}`}`);

  return <SearchControlTarget.Provider value={searchControlTarget}><ReviewProgressTarget.Provider value={reviewProgressTarget}><section className="review-page">
    <div className="source-toolbar">
      <div className="review-title">
        <strong>{data?.pr.title || `PR #${props.number}`}</strong>
        <div className="review-metadata">
          <span className="muted"><a className="pr-github-link" href={`https://github.com/${repository}/pull/${props.number}`} target="_blank" rel="noreferrer" title="Open PR on GitHub in a new tab">{repository} #{props.number}</a> {stack.data && <span className="pr-stack">
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
      <div className="review-progress-slot" ref={setReviewProgressTarget} />
      <select aria-label="PR commit" value={commit} onChange={(event) => navigate(`/pr/${repository}/${props.number}?commit=${event.target.value}`)}>
        <option value="all">All changes</option>{data?.commits.map((entry) => <option key={entry.sha} value={entry.sha}>{entry.sha.slice(0, 8)} · {entry.commit.message.split("\n")[0]}</option>)}
        {commit !== "all" && !data?.commits.some((entry) => entry.sha === commit) && <option value={commit}>{commit.slice(0, 8)}</option>}
      </select>
      <span ref={setSearchControlTarget} />
       <button onClick={() => setPanelOpen("overview")}>PR overview</button>
       <button onClick={() => setPanelOpen("comments")}>Review comments</button>
      {data && !resource.loading && <LinkedLocalReview key={resource.version} endpoint={endpoint} />}
    </div>
    <LoadState loading={resource.loading} error={resource.error} />
    {data && <PullRequestContent key={`${endpoint}:${commit}:${resource.version}`} endpoint={endpoint} review={data} source={`${repository} #${props.number} · ${commit === "all" ? "all changes" : commit.slice(0, 8)}`} panelOpen={panelOpen} onClosePanel={() => setPanelOpen(undefined)} />}
  </section></ReviewProgressTarget.Provider></SearchControlTarget.Provider>;
}

/**
 * Share discussion and review drafts between the diff, overlay, and summary panel.
 *
 * Keep PR-level thread coordinates out of single-commit views, where line numbers
 * can describe a different version of the file.
 */
function PullRequestContent(props: { endpoint: string; review: GitHubReview; source: string; panelOpen?: "overview" | "comments"; onClosePanel(): void }) {
  const draftState = useReviewDraft(props.endpoint, props.review.pr.head.sha);
  const conversation = useConversation(props.endpoint);
  const [focus, setFocus] = useState<ReviewLine & { request: number }>();
  const [active, setActive] = useState<CommentSelection>();
  const [bodies, setBodies] = useState<Record<string, ComposerBody>>({});
  const submissions = useRef(new Map<string, CommentSubmission>());
  const stale = draftState.draft.commitId !== props.review.pr.head.sha;
  const threads = useMemo(() => buildThreads(conversation.data, stale ? [] : draftState.draft.comments), [conversation.data, draftState.draft.comments, stale]);
  const discussionThreads = useMemo(() => buildDiscussionThreads(conversation.data, threads, props.review.pr.user.login), [conversation.data, threads, props.review.pr.user.login]);
  const thread = discussionThreads.find((entry) => entry.id === active?.threadId);
  const bodyKey = active ? `${active.line.path}:${active.line.side}:${active.line.line}:${active.threadId ?? "new"}` : "";
  const bodyEntry = bodies[bodyKey];
  const body = bodyEntry?.body ?? (thread?.draftIndex !== undefined ? thread.comments[0].body : "");
  const loadDiffFiles: FileDiffContentsLoader = loadContents;
  const local = useLocalDiscussion(props.review.commit === "all" ? props.endpoint : undefined, { commitId: props.review.pr.head.sha, baseCommitId: props.review.pr.base.sha }, conversation.refresh, openLocalThread);
  const reads = useCommentReads(props.endpoint, discussionThreads);
  const inlineReads = useMemo(() => reads.threads.filter((entry) => entry.id.startsWith("comment-") || entry.id.startsWith("draft-")), [reads.threads]);
  const visibleThreads = useMemo(() => [...inlineReads.filter((thread) => !thread.outdated), ...local.threads], [inlineReads, local.threads]);
  const commentThreads = useMemo(() => [...reads.threads, ...local.allThreads], [reads.threads, local.allThreads]);

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

  /** Load context against the SHAs shown by this review, even after a new push. */
  function loadContents(file: Parameters<FileDiffContentsLoader>[0]) {
    return post<FileDiffLoadedFiles>(`${props.endpoint}/contents`, { head: props.review.commit === "all" ? props.review.pr.head.sha : props.review.commit, base: props.review.pr.base.sha, single: props.review.commit !== "all", path: file.name, oldPath: file.prevName ?? file.name });
  }

  /** Close the overview so it cannot cover a line's floating composer. */
  function openComments(selection: CommentSelection) {
    props.onClosePanel();
    if (selection.threadId?.startsWith("local:")) local.open(selection);
    else setActive(selection);
  }

  /** Acknowledge the saved state before refreshing permissions, so a failed refresh is not a failed write. */
  async function resolveComment(id: string, resolved: boolean) {
    if (id.startsWith("local:")) { await local.resolveThread(id, resolved); return; }
    await saveThreadResolution(props.endpoint, conversation, id, resolved);
  }

  /** Focus a discussion's exact file coordinate without opening its composer. */
  function viewLine(line: ReviewLine) { setFocus({ ...line, request: Date.now() }); props.onClosePanel(); }

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

  /**
   * Return to the review immediately and publish an immutable submission in the background.
   *
   * Keep the draft until GitHub acknowledges it. Identity checks prevent an older submission
   * from clearing text typed into a reopened composer while its request was still pending.
   */
  function saveComment() {
    if (!active || !body.trim()) return;
    const key = bodyKey;
    const entry = bodyEntry;
    const text = body;
    const line = { ...active.line };
    const head = props.review.pr.head.sha;
    const reviewComment = thread?.draftIndex === undefined ? undefined : draftState.draft.comments[thread.draftIndex];
    let submission = submissions.current.get(key);
    if (!submission || submission.entry !== entry || submission.body !== text) {
      submission = { entry, body: text, id: crypto.randomUUID() };
      submissions.current.set(key, submission);
    }
    const requestId = submission.id;
    setActive(undefined);
    active.onSubmitted?.();

    backgroundSaves.submit(`github-comments:${props.endpoint}`, `${head}:${line.path}:${line.side}:${line.line}`, requestId, `Comment ${line.path}:${line.line}`, async () => {
      const headers = { "Idempotency-Key": requestId };
      await post(`${props.endpoint}/inline-comment`, { commitId: head, comment: { ...line, body: text } }, headers);
      if (reviewComment) {
        draftState.setDraft((current) => ({ ...current, comments: current.comments.filter((comment) => comment !== reviewComment) }));
        // The GitHub write is already acknowledged; a browser-storage failure must not invite reposting.
        try { removePublishedReviewComment(props.endpoint, head, reviewComment); } catch { /* The mounted draft hook reports storage failures. */ }
      }
      setBodies((current) => {
        if (current[key] !== entry) return current;
        const next = { ...current };
        delete next[key];
        return next;
      });
      conversation.refresh();
    });
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

  const readThread = reads.threads.find((entry) => entry.id === thread?.id);
  const composer = active && (readThread && readThread.draftIndex === undefined ? <GitHubCommentThread key={readThread.id} endpoint={props.endpoint} selection={active} thread={readThread} reads={reads} threads={reads.threads} onSelectThread={(entry) => setActive({ ...active, line: entry.location, threadId: entry.id })} onClose={() => setActive(undefined)} onChanged={conversation.refresh} /> : <CommentOverlay key={bodyKey} endpoint={props.endpoint} selection={active} thread={thread} reads={reads} threads={threads} onSelectThread={(entry) => setActive({ ...active, line: entry.location, threadId: entry.id })} body={body} onBodyChange={(value) => setBodies((current) => ({ ...current, [bodyKey]: { body: value } }))} stale={stale} storageError={draftState.storageError} onClose={() => setActive(undefined)} onSaveComment={saveComment} onSaveReviewComment={saveReviewComment} onSaveLocalComment={saveLocalComment} onCommentChanged={conversation.refresh} />);

  return <>
    {local.content}
    {reads.error && <p role="alert" className="error">Could not save or load comment read state: {reads.error}</p>}
    {props.review.patch.trim() ? props.review.commit === "all" ? <GitHubViewer endpoint={props.endpoint} progressEndpoint={props.endpoint} progressHead={props.review.pr.head.sha} patch={props.review.patch} source={props.source} allowImport={false} focus={focus} inlineThreads={visibleThreads} commentThreads={commentThreads} commentContent={active?.embedded ? composer : local.commentContent} activeCommentId={active?.embedded ? active.threadId : local.activeThreadId} onResolveComment={resolveComment} onOpenComments={openComments} onOpenFollowUpThread={openFollowUpThread} followUpThreadsReady={Boolean(conversation.data) && local.ready} loadDiffFiles={loadDiffFiles} whitespaceHidden /> : <Viewer patch={props.review.patch} source={props.source} allowImport={false} loadDiffFiles={loadDiffFiles} whitespaceHidden /> : <div className="empty-state"><h2>No changes</h2><p>This revision has an empty diff.</p></div>}
    {conversation.error && !props.panelOpen && <p className="error" role="alert">Could not load comments: {conversation.error} <button onClick={conversation.refresh}>Retry</button></p>}
    {props.panelOpen === "overview" && <PullRequestOverview endpoint={props.endpoint} pr={props.review.pr} onClose={props.onClosePanel} draftState={draftState} onSubmitted={conversation.refresh} />}
    {props.panelOpen === "comments" && <PullRequestComments endpoint={props.endpoint} pr={props.review.pr} conversation={conversation} local={local} unreadOnly={new URLSearchParams(window.location.search).get("comments") === "unread"} onClose={props.onClosePanel} />}
    {!active?.embedded && composer}
  </>;
}

/** Empty working commits are normal and should not be reported as invalid patches. */
function PatchViewer(props: ViewerProps & { patch: string; source: string }) {
  if (!props.patch.trim()) return <div className="empty-state"><h2>No changes</h2><p>This revision has an empty diff. Choose another revision or refresh after editing.</p></div>;
  return <Viewer {...props} allowImport={false} whitespaceHidden />;
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
