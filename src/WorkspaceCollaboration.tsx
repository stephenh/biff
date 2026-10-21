import { useEffect, useRef, useState } from "react";
import type { ReviewSession, ReviewThread } from "../shared/localReview";
import { post, request } from "./api";
import { WorkspaceReviewView } from "./Reviews";
import type { CommentSelection, LineThread } from "./lineComments";
import { MessagePublication } from "./LocalDiscussion";
import { EditableComment } from "./EditableComment";
import { useCommentReads } from "./useCommentReads";
import { CommentHeader } from "./CommentHeader";
import { FollowUpButton } from "./FollowUpButton";
import { useLocation } from "wouter";
import { CommentFrame } from "./CommentFrame";

/** Keep a review open while the agent edits code and replies to local threads. */
export function WorkspaceCollaboration(props: { id: string; workspaceId: string }) {
  const [, navigate] = useLocation();
  const endpoint = `/api/reviews/${props.id}`;
  const [review, setReview] = useState<ReviewSession>();
  const [error, setError] = useState("");
  const [discussion, setDiscussion] = useState(false);
  const [active, setActive] = useState<CommentSelection & { commitId: string; baseCommitId?: string }>();
  const allThreads: LineThread[] = (review?.threads ?? []).map((entry) => ({
    id: entry.id, location: entry.anchor,
    resolved: entry.resolved, canResolve: !review?.finished, canReopen: !review?.finished,
    readKeys: entry.messages.map((message) => `local:${message.id}`),
    comments: entry.messages.map((message) => ({ id: message.sequence, body: message.body, user: { login: message.author === "agent" ? "Agent" : "You" }, html_url: "" })),
  }));
  const reads = useCommentReads(endpoint, allThreads, active?.threadId);

  useEffect(() => {
    const events = new EventSource(`${endpoint}/events`);
    events.onmessage = (event) => {
      const next: ReviewSession = JSON.parse(event.data);
      setReview((current) => !current || next.sequence >= current.sequence ? next : current);
      setError("");
      if (next.finished) events.close();
    };
    events.onerror = () => setError("Review connection interrupted. Reconnecting…");
    const controller = new AbortController();
    request<ReviewSession>(endpoint, { signal: controller.signal }).then(async (current) => {
      // Reloading the workspace picks up edits; finished discussions keep their final snapshot.
      const next = current.finished ? current : await request<ReviewSession>(`${endpoint}/refresh`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", signal: controller.signal });
      setReview((current) => !current || next.sequence >= current.sequence ? next : current);
    }).catch((cause: Error) => { if (!controller.signal.aborted) setError(cause.message); });
    return () => { controller.abort(); events.close(); };
  }, [endpoint]);

  /** Sequence checks prevent a slow POST response from replacing a newer stream event. */
  async function mutate(action: string, body: unknown = {}) {
    const next = await post<ReviewSession>(`${endpoint}/${action}`, body);
    setReview((current) => !current || next.sequence >= current.sequence ? next : current);
  }

  if (!review) return <p role={error ? "alert" : "status"}>{error || "Loading review…"}</p>;
  const snapshot = review.snapshot;
  if (snapshot.workspace.id !== props.workspaceId) return <p role="alert">This review belongs to a different workspace.</p>;
  const commitId = snapshot.selected.commit_id;
  const baseCommitId = snapshot.changes === "all" ? snapshot.base?.commit_id : undefined;
  const thread = review.threads.find((entry) => entry.id === active?.threadId);
  const visible = new Set(review.threads.filter((entry) => entry.anchor.commitId === commitId && entry.anchor.baseCommitId === baseCommitId).map((entry) => entry.id));
  const threads = reads.threads.filter((entry) => visible.has(entry.id));
  const followUpEndpoint = snapshot.identity ? `/api/workspaces/${snapshot.workspace.id}/changes/${snapshot.progressScope}` : undefined;
  const composer = active && <LocalCommentDialog key={`${active.threadId ?? `${active.line.path}:${active.line.side}:${active.line.line}`}:${active.commitId}:${active.baseCommitId}`} followUpEndpoint={followUpEndpoint} reviewId={review.id} selection={active} thread={thread} outdated={active.commitId !== commitId || active.baseCommitId !== baseCommitId} finished={review.finished} onClose={() => setActive(undefined)} onPost={async (body) => {
    if (thread) await mutate("reply", { threadId: thread.id, body, author: "user" });
    else await mutate("threads", { ...active.line, commitId: active.commitId, baseCommitId: active.baseCommitId, body });
  }} onResolve={async () => { if (thread) await mutate("resolve", { threadId: thread.id, resolved: !thread.resolved }); }}
    onEdit={(messageId, body) => mutate("edit", { threadId: thread?.id, messageId, body })}
    onDelete={async (messageId) => { await mutate("delete", { threadId: thread?.id, messageId }); if (thread?.messages.length === 1) setActive(undefined); }} />;

  return <WorkspaceReviewView id={snapshot.workspace.id} revision={snapshot.selected.change_id} data={snapshot} error={error || reads.error} viewer={{ inlineThreads: threads, commentThreads: reads.threads.map((entry) => ({ ...entry, outdated: !visible.has(entry.id) })), commentContent: active?.embedded ? composer : undefined, activeCommentId: active?.embedded ? active.threadId : undefined, onResolveComment: (id, resolved) => mutate("resolve", { threadId: id, resolved }), onOpenComments: (selection) => {
    const anchor = review.threads.find((entry) => entry.id === selection.threadId)?.anchor;
    setActive({ ...selection, commitId: anchor?.commitId ?? commitId, baseCommitId: anchor ? anchor.baseCommitId : baseCommitId });
  }, followUpThreadsReady: true, onOpenFollowUpThread: (id) => {
    const entry = review.threads.find((thread) => `local:${thread.id}` === id);
    if (entry) setActive({ line: entry.anchor, threadId: entry.id, commitId: entry.anchor.commitId, baseCommitId: entry.anchor.baseCommitId });
    else if (snapshot.identity?.pr) navigate(`/pr/${snapshot.identity.pr}?followUp=${encodeURIComponent(id)}`);
  } }} controls={<>
      <span className="muted">{review.finished ? "Finished" : "Agent connected"}</span>
      <button onClick={() => setDiscussion(true)}>Discussion ({review.threads.length})</button>
    </>}>
    {discussion && <aside className="review-panel" aria-label="Local review discussion">
      <div className="panel-heading"><h2>Discussion</h2><button onClick={() => setDiscussion(false)}>Close</button></div>
      {!review.threads.length && <p>Select a diff line and press <kbd>c</kbd> to leave a comment.</p>}
      {review.threads.map((entry) => <section key={entry.id}>
        <button onClick={() => { setDiscussion(false); setActive({ line: entry.anchor, threadId: entry.id, commitId: entry.anchor.commitId, baseCommitId: entry.anchor.baseCommitId }); }}>{entry.anchor.path}:{entry.anchor.line} · {entry.resolved ? "Resolved" : "Open"}{entry.anchor.commitId !== commitId || entry.anchor.baseCommitId !== baseCommitId ? " · Outdated" : ""}</button>
        <p className="markdown-text">{entry.messages[0].body}</p>
        {followUpEndpoint && <FollowUpButton endpoint={followUpEndpoint} thread={`local:${entry.id}`} />}
      </section>)}
    </aside>}
    {!active?.embedded && composer}
  </WorkspaceReviewView>;
}

/** Preserve drafts across refreshes; posted messages live only in the daemon's review file. */
function LocalCommentDialog(props: {
  followUpEndpoint?: string;
  reviewId: string; selection: CommentSelection; thread?: ReviewThread; outdated: boolean; finished: boolean;
  onClose(): void; onPost(body: string): Promise<void>; onResolve(): Promise<void>;
  onEdit(messageId: string, body: string): Promise<void>; onDelete(messageId: string): Promise<void>;
}) {
  const composer = useRef<HTMLTextAreaElement>(null);
  const key = `biff-review-draft:${props.reviewId}:${props.thread?.id ?? JSON.stringify(props.selection.line)}`;
  const [body, setBody] = useState(() => { try { return localStorage.getItem(key) || ""; } catch { return ""; } });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  /** Keep text in place on write failures so the user can retry. */
  async function save(resolve = false) {
    setBusy(true);
    setError("");
    try {
      if (resolve) await props.onResolve();
      else { await props.onPost(body); setBody(""); try { localStorage.removeItem(key); } catch { /* Posting already succeeded. */ } }
      props.onClose();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save comment"); }
    finally { setBusy(false); }
  }

  return <CommentFrame selection={props.selection} label="Local comment thread" busy={busy} composer={composer} onClose={props.onClose}>
    <CommentHeader title={props.thread ? "Comment thread" : "New comment"} line={props.selection.line} embedded={props.selection.embedded} outdated={props.outdated} busy={busy} onClose={props.onClose} status={<span className="comment-visibility local" title="Not published to GitHub">Local</span>} />
    <div className="comment-body">
    {props.outdated && props.thread && <pre className="review-excerpt">{props.thread.anchor.excerpt}</pre>}
    <div className="overlay-thread">{props.thread?.messages.map((message) => <article className="discussion-comment" key={message.id}>{props.finished ? <><div className="comment-author"><strong>{message.author === "agent" ? "Agent" : "You"}</strong><MessagePublication message={message} /></div><div className="markdown-text">{message.body}</div></> : <EditableComment header={<><strong>{message.author === "agent" ? "Agent" : "You"}</strong><MessagePublication message={message} /></>} body={message.body} onEdit={(body) => props.onEdit(message.id, body)} onDelete={() => props.onDelete(message.id)} />}</article>)}</div>
    {error && <p className="error" role="alert">{error}</p>}
    {props.thread && props.followUpEndpoint && <FollowUpButton endpoint={props.followUpEndpoint} thread={`local:${props.thread.id}`} />}
    {!props.finished && <>
      <label className="comment-composer">{props.thread ? "Reply" : "Comment"}<textarea ref={composer} placeholder={props.thread ? "Write a reply…" : "Write a comment…"} aria-label={props.thread ? "Thread reply" : "Inline comment"} value={body} onChange={(event) => {
        setBody(event.target.value);
        try { localStorage.setItem(key, event.target.value); } catch { setError("Draft could not be saved locally. Keep this dialog open until posting."); }
      }} /></label>
      <div className="comment-actions"><button className="primary" disabled={busy || !body.trim() || (!props.thread && props.outdated)} onClick={() => void save()}>Save locally</button>{props.thread && !props.selection.embedded && <button disabled={busy} onClick={() => void save(true)}>{props.thread.resolved ? "Reopen thread" : "Resolve thread"}</button>}</div>
    </>}
    </div>
  </CommentFrame>;
}
