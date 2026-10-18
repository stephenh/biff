import { useEffect, useMemo, useRef, useState } from "react";
import type { Discussion } from "../shared/discussion";
import type { ReviewMessage, ReviewThread } from "../shared/localReview";
import type { CommentSelection, LineThread } from "./lineComments";
import { post, useResource } from "./api";
import { EditableComment } from "./EditableComment";

interface Snapshot { commitId?: string; baseCommitId?: string }

/**
 * Share durable local threads between bookmark and PR views.
 *
 * Thread anchors stay on their recorded snapshot; the drawer keeps outdated threads accessible.
 */
export function useLocalDiscussion(endpoint: string | undefined, snapshot: Snapshot, onChanged?: () => void) {
  const resource = useResource<Discussion>(endpoint ? `${endpoint}/discussion` : null);
  const [updated, setUpdated] = useState<Discussion>();
  const [active, setActive] = useState<CommentSelection>();
  const [panelOpen, setPanelOpen] = useState(false);
  const data = updated ?? resource.data;
  const thread = data?.threads.find((entry) => `local:${entry.id}` === active?.threadId);

  useEffect(() => { setUpdated(undefined); setActive(undefined); }, [endpoint, snapshot.commitId, snapshot.baseCommitId]);
  useEffect(() => { if (resource.data) accept(resource.data); }, [resource.data]);
  useEffect(() => {
    if (!endpoint) return;
    const events = new EventSource(`${endpoint}/discussion?events=1`);
    events.onmessage = (event) => accept(JSON.parse(event.data));
    window.addEventListener("focus", resource.refresh);
    return () => { events.close(); window.removeEventListener("focus", resource.refresh); };
  }, [endpoint]);

  /** Slow fetches must not replace a newer stream event or acknowledged mutation. */
  function accept(discussion: Discussion) {
    setUpdated((current) => !current || current.identity.id !== discussion.identity.id || discussion.version > current.version ? discussion : current);
  }

  /** A comment remains local until a separate publish request succeeds. */
  async function mutate(body: unknown): Promise<void> {
    if (!endpoint) throw new Error("Open All changes to comment on this review.");
    const result = await post<Discussion>(`${endpoint}/discussion`, body);
    accept(result);
    onChanged?.();
    if (result.publicationError) throw new Error(result.publicationError);
  }

  /** Record the exact base and head used by the visible diff. */
  async function create(selection: CommentSelection, body: string, endLine = selection.line.line): Promise<void> {
    await mutate({ action: "create", ...selection.line, ...snapshot, endLine, body });
  }

  /** Existing local threads always use the local composer, even in a PR view. */
  function open(selection: CommentSelection) { setPanelOpen(false); setActive(selection); }

  const threads = useMemo<LineThread[]>(() => (data?.threads ?? []).filter((entry) => !isOutdated(entry, snapshot)).map((entry) => ({
    id: `local:${entry.id}`, location: entry.anchor,
    comments: entry.messages.map((message) => ({ id: message.sequence, body: message.body, user: { login: localAuthor(message, entry) }, html_url: message.published?.url ?? "" })),
  })), [data?.threads, snapshot.commitId, snapshot.baseCommitId]);

  const controls = endpoint && <button onClick={() => setPanelOpen((open) => !open)}>Local comments ({data?.threads.length ?? 0})</button>;
  const discussion = endpoint && <section>
      <h3>Local comments ({data?.threads.length ?? 0})</h3>
      {resource.error && <p className="error" role="alert">Could not load local comments: {resource.error} <button onClick={resource.refresh}>Retry</button></p>}
      {!data?.threads.length && <p>Use the + beside a diff line to leave a local comment.</p>}
      {data?.threads.map((entry) => <section className="discussion-comment" key={entry.id}>
        <button onClick={() => open({ line: entry.anchor, threadId: `local:${entry.id}` })}>{entry.anchor.path}:{entry.anchor.line} · {entry.resolved ? "Resolved" : "Open"}{isOutdated(entry, snapshot) ? " · Outdated snapshot" : ""}</button>
        <ThreadPublication thread={entry} />
        <p className="markdown-text">{entry.messages[0].body}</p>
      </section>)}
    </section>;
  const content = endpoint && <>
    {panelOpen && <aside className="review-panel" aria-label="Local review discussion">
      <div className="panel-heading"><h2>Local comments</h2><button onClick={() => setPanelOpen(false)}>Close</button></div>
      {discussion}
    </aside>}
    {active && <LocalThreadDialog key={`${endpoint}:${active.threadId ?? JSON.stringify(active.line)}`} reviewId={data?.identity.id ?? endpoint} selection={active} thread={thread} outdated={Boolean(thread && isOutdated(thread, snapshot))} pr={data?.identity.pr} onClose={() => setActive(undefined)}
      onSave={(body, endLine) => thread ? mutate({ action: "reply", threadId: thread.id, body }) : create(active, body, endLine)}
      onResolve={() => mutate({ action: "resolve", threadId: thread?.id, resolved: !thread?.resolved })}
      onEdit={(messageId, body) => mutate({ action: "edit", threadId: thread?.id, messageId, body })}
      onDelete={async (messageId) => { await mutate({ action: "delete", threadId: thread?.id, messageId }); if (thread?.messages.length === 1) setActive(undefined); }}
      onPublish={() => mutate({ action: "publish", threadId: thread?.id })} />}
  </>;
  return { threads, open, create, controls, content, discussion };
}

/**
 * Keep saving locally and publishing to GitHub visibly separate.
 *
 * Every message carries its own publication status so a new local reply cannot look published.
 */
function LocalThreadDialog(props: {
  reviewId: string; selection: CommentSelection; thread?: ReviewThread; outdated: boolean; pr?: string;
  onClose(): void; onSave(body: string, endLine: number): Promise<void>; onResolve(): Promise<void>; onPublish(): Promise<void>;
  onEdit(messageId: string, body: string): Promise<void>; onDelete(messageId: string): Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const key = `biff-local-comment:${props.reviewId}:${props.thread?.id ?? JSON.stringify(props.selection.line)}`;
  const [body, setBody] = useState(() => { try { return localStorage.getItem(key) ?? ""; } catch { return ""; } });
  const [endLine, setEndLine] = useState(props.selection.line.line);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = props.thread?.messages.filter((message) => !message.published).length ?? 0;
  useEffect(() => {
    dialog.current!.showModal();
    composer.current?.focus();
    const element = dialog.current!;
    return () => element.close();
  }, []);

  /** Failed saves/publications keep the local thread and draft available for retry. */
  async function act(action: "save" | "resolve" | "publish") {
    setBusy(true); setError("");
    try {
      if (action === "publish") await props.onPublish();
      else if (action === "resolve") { await props.onResolve(); props.onClose(); }
      else {
        await props.onSave(body, endLine);
        setBody("");
        try { localStorage.removeItem(key); } catch { /* The durable save already succeeded. */ }
        props.onClose();
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }

  return <dialog ref={dialog} className="comment-overlay" style={{ top: 100 }} aria-label="Local comment thread" onCancel={(event) => { event.preventDefault(); if (!busy) props.onClose(); }}>
    <div className="panel-heading"><h2>{props.thread ? "Local comment thread" : "New comment"} {!props.thread && <span className="comment-visibility local" title="Not published to GitHub">Local</span>}</h2><button disabled={busy} onClick={props.onClose} aria-label="Close comment thread">×</button></div>
    {props.thread && <ThreadPublication thread={props.thread} />}
    <p className="muted">{props.selection.line.path}:{props.selection.line.line} · {props.selection.line.side === "LEFT" ? "old" : "new"} side{props.outdated ? " · Outdated snapshot" : ""}</p>
    {props.outdated && props.thread && <pre className="review-excerpt">{props.thread.anchor.excerpt}</pre>}
    {props.thread?.messages.map((message) => <article className="discussion-comment" key={message.id}><strong>{message.author === "agent" ? "Agent" : "You"}</strong><MessagePublication message={message} /><EditableComment body={message.body} onEdit={(body) => props.onEdit(message.id, body)} onDelete={() => props.onDelete(message.id)} /></article>)}
    {error && <p className="error" role="alert">{error}</p>}
    {!props.thread && <label>Through line <input aria-label="End line" type="number" min={props.selection.line.line} value={endLine} onChange={(event) => setEndLine(Number(event.target.value))} /></label>}
    <label>{props.thread ? "Local reply" : "Local comment"}<textarea ref={composer} aria-label={props.thread ? "Thread reply" : "Inline comment"} value={body} onChange={(event) => {
      setBody(event.target.value);
      try { localStorage.setItem(key, event.target.value); } catch { setError("Draft could not be saved in this browser. Keep the dialog open until saving."); }
    }} /></label>
    <div className="card-actions">
      <button disabled={busy || !body.trim()} onClick={() => void act("save")}>Save locally</button>
      {props.thread && <button disabled={busy} onClick={() => void act("resolve")}>{props.thread.resolved ? "Reopen thread" : "Resolve thread"}</button>}
    </div>
    {props.thread && pending > 0 && <div className="publication-action">
      {props.pr ? <><p>Publish {pending} saved local {pending === 1 ? "message" : "messages"} to <strong>{props.pr}</strong>.</p><button disabled={busy} onClick={() => void act("publish")}>Publish to PR</button></> : <p>Open the matching PR in Biff to enable publishing. This thread remains local.</p>}
    </div>}
  </dialog>;
}

/** Summarize mixed threads without presenting unpublished replies as already sent. */
function ThreadPublication(props: { thread: ReviewThread }) {
  const pending = props.thread.messages.filter((message) => !message.published && !message.publicationPending).length;
  const uncertain = props.thread.messages.some((message) => message.publicationPending);
  const published = props.thread.messages.find((message) => message.published)?.published;
  return <div>
    {published && <span className="comment-visibility published"><a href={published.url} target="_blank" rel="noreferrer">GitHub</a></span>}
    {pending > 0 && <> <span className="comment-visibility local">Local</span></>}
    {uncertain && <p className="comment-visibility local">Publication unconfirmed · Retry Publish to PR to check GitHub.</p>}
  </div>;
}

/** Publication is a receipt for this exact message, not a property inherited from its thread. */
export function MessagePublication(props: { message: ReviewMessage }) {
  return props.message.published ? <> <span className="comment-visibility published"><a href={props.message.published.url} target="_blank" rel="noreferrer">GitHub</a></span></> : <> <span className="comment-visibility local">{props.message.publicationPending ? "Publication unconfirmed" : "Local"}</span></>;
}

/** Never reattach old coordinates to a different base/head pair. */
function isOutdated(thread: ReviewThread, snapshot: Snapshot): boolean { return thread.anchor.commitId !== snapshot.commitId || thread.anchor.baseCommitId !== snapshot.baseCommitId; }

/** A published root must not hide the presence of local replies in the inline preview. */
function localAuthor(message: ReviewMessage, thread: ReviewThread): string {
  const status = message.published
    ? `GitHub${thread.messages.some((entry) => !entry.published) ? " · Local" : ""}`
    : message.publicationPending ? "Publication unconfirmed" : "Local";
  return `${message.author === "agent" ? "Agent" : "You"} · ${status}`;
}
