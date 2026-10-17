import { useEffect, useRef, useState } from "react";
import type { ReviewSession, ReviewThread } from "../shared/localReview";
import { post, request } from "./api";
import { WorkspaceReviewView } from "./Reviews";
import type { CommentSelection, LineThread } from "./lineComments";
import { MessagePublication } from "./LocalDiscussion";

/** Keep a review open while the agent edits code and replies to local threads. */
export function WorkspaceCollaboration(props: { id: string; workspaceId: string }) {
  const endpoint = `/api/reviews/${props.id}`;
  const [review, setReview] = useState<ReviewSession>();
  const [error, setError] = useState("");
  const [discussion, setDiscussion] = useState(false);
  const [active, setActive] = useState<CommentSelection & { commitId: string; baseCommitId?: string }>();

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
  const threads: LineThread[] = review.threads.filter((entry) => entry.anchor.commitId === commitId && entry.anchor.baseCommitId === baseCommitId).map((entry) => ({
    id: entry.id, location: entry.anchor,
    comments: entry.messages.map((message) => ({ id: message.sequence, body: message.body, user: { login: message.author === "agent" ? "Agent" : "You" }, html_url: "" })),
  }));

  return <WorkspaceReviewView id={snapshot.workspace.id} revision={snapshot.selected.change_id} data={snapshot} error={error} viewer={{ inlineThreads: threads, onOpenComments: (selection) => setActive({ ...selection, commitId, baseCommitId }) }} controls={<>
      <span className="muted">{review.finished ? "Finished" : "Agent connected"}</span>
      <button onClick={() => setDiscussion(true)}>Discussion ({review.threads.length})</button>
    </>}>
    {discussion && <aside className="review-panel" aria-label="Local review discussion">
      <div className="panel-heading"><h2>Discussion</h2><button onClick={() => setDiscussion(false)}>Close</button></div>
      {!review.threads.length && <p>Use the + beside a diff line to leave a comment.</p>}
      {review.threads.map((entry) => <section key={entry.id}>
        <button onClick={() => { setDiscussion(false); setActive({ line: entry.anchor, threadId: entry.id, commitId: entry.anchor.commitId, baseCommitId: entry.anchor.baseCommitId }); }}>{entry.anchor.path}:{entry.anchor.line} · {entry.resolved ? "Resolved" : "Open"}{entry.anchor.commitId !== commitId || entry.anchor.baseCommitId !== baseCommitId ? " · Outdated" : ""}</button>
        <p className="markdown-text">{entry.messages[0].body}</p>
      </section>)}
    </aside>}
    {active && <LocalCommentDialog key={`${active.threadId ?? `${active.line.path}:${active.line.side}:${active.line.line}`}:${active.commitId}:${active.baseCommitId}`} reviewId={review.id} selection={active} thread={thread} outdated={active.commitId !== commitId || active.baseCommitId !== baseCommitId} finished={review.finished} onClose={() => setActive(undefined)} onPost={async (body, endLine) => {
      if (thread) await mutate("reply", { threadId: thread.id, body, author: "user" });
      else await mutate("threads", { ...active.line, endLine, commitId: active.commitId, baseCommitId: active.baseCommitId, body });
    }} onResolve={async () => { if (thread) await mutate("resolve", { threadId: thread.id, resolved: !thread.resolved }); }} />}
  </WorkspaceReviewView>;
}

/** Preserve drafts across refreshes; posted messages live only in the daemon's review file. */
function LocalCommentDialog(props: {
  reviewId: string; selection: CommentSelection; thread?: ReviewThread; outdated: boolean; finished: boolean;
  onClose(): void; onPost(body: string, endLine: number): Promise<void>; onResolve(): Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const key = `biff-review-draft:${props.reviewId}:${props.thread?.id ?? JSON.stringify(props.selection.line)}`;
  const [body, setBody] = useState(() => { try { return localStorage.getItem(key) || ""; } catch { return ""; } });
  const [endLine, setEndLine] = useState(props.selection.line.line);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    // Focus after opening so the native dialog does not select the close button instead.
    composer.current?.focus();
    return () => element.close();
  }, []);

  /** Keep text in place on write failures so the user can retry. */
  async function save(resolve = false) {
    setBusy(true);
    setError("");
    try {
      if (resolve) await props.onResolve();
      else { await props.onPost(body, endLine); setBody(""); try { localStorage.removeItem(key); } catch { /* Posting already succeeded. */ } }
      props.onClose();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save comment"); }
    finally { setBusy(false); }
  }

  return <dialog ref={dialog} className="comment-overlay" style={{ top: 100 }} aria-label="Local comment thread" onCancel={(event) => { event.preventDefault(); if (!busy) props.onClose(); }}>
    <div className="panel-heading"><h2>{props.thread ? "Comment thread" : "New comment"}</h2><button disabled={busy} onClick={props.onClose} aria-label="Close comment thread">×</button></div>
    <p className="comment-visibility local">Replies here stay local. They are not published to GitHub.</p>
    <p className="muted">{props.selection.line.path}:{props.selection.line.line} · {props.selection.line.side === "LEFT" ? "old" : "new"} side{props.outdated ? " · Outdated snapshot" : ""}</p>
    {props.outdated && props.thread && <pre className="review-excerpt">{props.thread.anchor.excerpt}</pre>}
    {props.thread?.messages.map((message) => <article className="discussion-comment" key={message.id}><strong>{message.author === "agent" ? "Agent" : "You"}</strong><MessagePublication message={message} /><div className="markdown-text">{message.body}</div></article>)}
    {error && <p className="error" role="alert">{error}</p>}
    {!props.finished && <>
      {!props.thread && <label>Through line <input aria-label="End line" type="number" min={props.selection.line.line} value={endLine} onChange={(event) => setEndLine(Number(event.target.value))} /></label>}
      <label>{props.thread ? "Reply" : "Comment"}<textarea ref={composer} aria-label={props.thread ? "Thread reply" : "Inline comment"} value={body} onChange={(event) => {
        setBody(event.target.value);
        try { localStorage.setItem(key, event.target.value); } catch { setError("Draft could not be saved locally. Keep this dialog open until posting."); }
      }} /></label>
      <div className="card-actions"><button disabled={busy || !body.trim() || (!props.thread && props.outdated)} onClick={() => void save()}>Post comment</button>{props.thread && <button disabled={busy} onClick={() => void save(true)}>{props.thread.resolved ? "Reopen thread" : "Resolve thread"}</button>}</div>
      <p className="muted">Posted comments are sent to your agent. Drafts stay in this browser.</p>
    </>}
  </dialog>;
}
