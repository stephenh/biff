import { useEffect, useMemo, useRef, useState } from "react";
import { CommentMessages } from "./CommentMessages";
import type { Discussion } from "../shared/discussion";
import type { ReviewMessage, ReviewThread } from "../shared/localReview";
import type { CommentSelection, LineThread } from "./lineComments";
import { post, useResource } from "./api";
import { EditableComment } from "./EditableComment";
import { useCommentReads } from "./useCommentReads";
import { CommentHeader } from "./CommentHeader";
import { ModalHeader } from "./ModalHeader";
import { FollowUpButton } from "./FollowUpButton";
import { CommentFrame } from "./CommentFrame";

interface Snapshot { commitId?: string; baseCommitId?: string }

/**
 * Share durable local threads between bookmark and PR views.
 *
 * Thread anchors stay on their recorded snapshot; the drawer keeps outdated threads accessible.
 */
export function useLocalDiscussion(endpoint: string | undefined, snapshot: Snapshot, onChanged?: () => void, onOpenFromList?: (selection: CommentSelection) => void) {
  const resource = useResource<Discussion>(endpoint ? `${endpoint}/discussion` : null);
  const [updated, setUpdated] = useState<Discussion>();
  const [active, setActive] = useState<CommentSelection>();
  const [panelOpen, setPanelOpen] = useState(false);
  const allData = updated ?? resource.data;
  const data = useMemo(() => allData ? { ...allData, threads: allData.threads.filter((thread) => !thread.kind && !thread.discarded) } : undefined, [allData]);
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
  async function create(selection: CommentSelection, body: string): Promise<void> {
    await mutate({ action: "create", ...selection.line, ...snapshot, body });
  }

  /** Existing local threads always use the local composer, even in a PR view. */
  function open(selection: CommentSelection) { setPanelOpen(false); setActive(selection); }

  /** Resolve the recorded local thread without moving its anchor or discarding a reply draft. */
  async function resolveThread(id: string, resolved: boolean, keys?: string[]) {
    const entry = data?.threads.find((thread) => `local:${thread.id}` === id);
    if (!entry) throw new Error("This local thread is no longer available.");
    await mutate({ action: "resolve", threadId: entry.id, resolved, keys });
  }

  /** Outdated anchors remain readable without focusing an unrelated line in the current snapshot. */
  function openFromList(entry: ReviewThread) {
    const selection = { line: entry.attachment?.matched ? entry.attachment : entry.anchor, threadId: `local:${entry.id}` };
    if (onOpenFromList && !isOutdated(entry, snapshot)) onOpenFromList(selection);
    else open(selection);
  }

  const threads = useMemo<LineThread[]>(() => (data?.threads ?? []).map((entry) => ({
    id: `local:${entry.id}`, location: entry.attachment?.matched ? entry.attachment : entry.anchor, outdated: isOutdated(entry, snapshot),
    resolved: entry.resolved, canResolve: true, canReopen: true,
    readKeys: entry.messages.filter((message) => message.author !== "user").map((message) => `local:${message.id}`),
    comments: entry.messages.map((message) => ({ id: message.sequence, readKey: `local:${message.id}`, own: message.author === "user", body: message.body, user: { login: localAuthor(message, entry) }, html_url: message.published?.url ?? "" })),
  })), [data?.threads, snapshot.commitId, snapshot.baseCommitId]);
  const reads = useCommentReads(endpoint, threads, data?.commentReads);
  const visibleThreads = useMemo(() => {
    const visible = new Set(data?.threads.filter((entry) => !isOutdated(entry, snapshot)).map((entry) => `local:${entry.id}`));
    return reads.threads.filter((entry) => visible.has(entry.id));
  }, [reads.threads, data?.threads, snapshot.commitId, snapshot.baseCommitId]);

  const controls = endpoint && <button onClick={() => setPanelOpen((open) => !open)}>Local comments ({data?.threads.length ?? 0})</button>;
  const discussion = endpoint && <section>
      <h3>Local comments ({data?.threads.length ?? 0})</h3>
      {resource.error && <p className="error" role="alert">Could not load local comments: {resource.error} <button onClick={resource.refresh}>Retry</button></p>}
      {!data?.threads.length && <p>Select a diff line and press <kbd>c</kbd> to leave a local comment.</p>}
      {data?.threads.map((entry) => <section className="discussion-comment" key={entry.id}>
        <button onClick={() => openFromList(entry)}>{entry.anchor.path}:{entry.anchor.line} · {entry.resolved ? "Resolved" : "Open"}{isOutdated(entry, snapshot) ? " · Outdated snapshot" : ""}</button>
        <ThreadPublication thread={entry} />
        <FollowUpButton endpoint={endpoint!} thread={`local:${entry.id}`} />
        <button className="comment-preview" onClick={() => openFromList(entry)}><Markdown body={entry.messages[0].body} preview /></button>
      </section>)}
    </section>;
  const composer = endpoint && active && <LocalThreadDialog reads={reads} key={`${endpoint}:${active.threadId ?? JSON.stringify(active.line)}`} endpoint={endpoint} reviewId={data?.identity.id ?? endpoint} selection={active} thread={thread} outdated={Boolean(thread && isOutdated(thread, snapshot))} pr={data?.identity.pr} onClose={() => setActive(undefined)}
    onSave={(body) => thread ? mutate({ action: "reply", threadId: thread.id, body }) : create(active, body)}
    onResolve={() => mutate({ action: "resolve", threadId: thread?.id, resolved: !thread?.resolved, keys: thread?.messages.map((message) => `local:${message.id}`) })}
    onEdit={(messageId, body) => mutate({ action: "edit", threadId: thread?.id, messageId, body })}
    onDelete={async (messageId) => { await mutate({ action: "delete", threadId: thread?.id, messageId }); if (thread?.messages.length === 1) setActive(undefined); }}
    onPublish={() => mutate({ action: "publish", threadId: thread?.id })} />;
  const content = endpoint && <>
    {reads.error && <p role="alert" className="error">Could not save or load comment read state: {reads.error}</p>}
    {panelOpen && <aside className="review-panel" data-modal-scope aria-label="Local review discussion" onKeyDown={(event) => { if (event.key === "Escape" && !event.defaultPrevented) setPanelOpen(false); }}>
      <ModalHeader title="Local comments" closeLabel="Close local comments" onClose={() => setPanelOpen(false)} />
      {discussion}
    </aside>}
    {!active?.embedded && composer}
  </>;
  function openFollowUp(id: string) {
    const entry = data?.threads.find((thread) => `local:${thread.id}` === id);
    if (entry) openFromList(entry);
  }
  return { threads: visibleThreads, allThreads: reads.threads, markRead: reads.markRead, ready: data !== undefined, open, openFollowUp, resolveThread, create, controls, content, activeThreadId: active?.embedded ? active.threadId : undefined, commentContent: active?.embedded ? composer : undefined, discussion };
}

/**
 * Keep saving locally and publishing to GitHub visibly separate.
 *
 * Every message carries its own publication status so a new local reply cannot look published.
 */
function LocalThreadDialog(props: {
  reads: ReturnType<typeof useCommentReads>;
  endpoint: string;
  reviewId: string; selection: CommentSelection; thread?: ReviewThread; outdated: boolean; pr?: string;
  onClose(): void; onSave(body: string): Promise<void>; onResolve(): Promise<void>; onPublish(): Promise<void>;
  onEdit(messageId: string, body: string): Promise<void>; onDelete(messageId: string): Promise<void>;
}) {
  const composer = useRef<HTMLTextAreaElement>(null);
  const key = `biff-local-comment:${props.reviewId}:${props.thread?.id ?? JSON.stringify(props.selection.line)}`;
  const [body, setBody] = useState(() => { try { return localStorage.getItem(key) ?? ""; } catch { return ""; } });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = props.thread?.messages.filter((message) => !message.published).length ?? 0;

  /** Failed saves/publications keep the local thread and draft available for retry. */
  async function act(action: "save" | "resolve" | "publish") {
    setBusy(true); setError("");
    try {
      if (action === "publish") await props.onPublish();
      else if (action === "resolve") { await props.onResolve(); props.onClose(); }
      else {
        await props.onSave(body);
        setBody("");
        try { localStorage.removeItem(key); } catch { /* The durable save already succeeded. */ }
        props.onClose();
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }

  return <CommentFrame selection={props.selection} label="Local comment thread" busy={busy} composer={composer} onClose={props.onClose}>
    <CommentHeader title={props.thread ? "Local comment thread" : "New comment"} line={props.selection.line} embedded={props.selection.embedded} reviewWide={props.selection.reviewWide} outdated={props.outdated} busy={busy} onClose={props.onClose} status={props.thread ? <ThreadPublication thread={props.thread} /> : <span className="comment-visibility local" title="Not published to GitHub">Local</span>} />
    <div className="comment-body">
    {props.outdated && props.thread && <pre className="review-excerpt">{props.thread.anchor.excerpt}</pre>}
    <CommentMessages thread={props.reads.threads.find((entry) => entry.id === `local:${props.thread?.id}`)} reads={props.reads}>{props.thread?.messages.map((message) => <article className="discussion-comment" key={message.id}><EditableComment own={message.author === "user"} header={<><strong>{message.author === "agent" ? "Agent" : "You"}</strong><MessagePublication message={message} /></>} body={message.body} onEdit={(body) => props.onEdit(message.id, body)} onDelete={() => props.onDelete(message.id)} /></article>)}</CommentMessages>
    {error && <p className="error" role="alert">{error}</p>}
    <label className="comment-composer">{props.thread ? "Local reply" : "Local comment"}<textarea ref={composer} placeholder={props.thread ? "Write a reply…" : "Write a comment…"} aria-label={props.thread ? "Thread reply" : "Inline comment"} value={body} onChange={(event) => {
      setBody(event.target.value);
      try { localStorage.setItem(key, event.target.value); } catch { setError("Draft could not be saved in this browser. Keep the dialog open until saving."); }
    }} /></label>
    <div className="comment-actions">
      <button className="primary" disabled={busy || !body.trim()} onClick={() => void act("save")}>Save locally</button>
      {props.thread && !props.selection.embedded && <button disabled={busy} onClick={() => void act("resolve")}>{props.thread.resolved ? "Reopen thread" : "Resolve thread"}</button>}
      {props.thread && <FollowUpButton endpoint={props.endpoint} thread={`local:${props.thread.id}`} />}
    </div>
    {props.thread && pending > 0 && <div className="publication-action">
      {props.pr ? <><p>Publish {pending} saved local {pending === 1 ? "message" : "messages"} to <strong>{props.pr}</strong>.</p><button disabled={busy} onClick={() => void act("publish")}>Publish to PR</button></> : <p>Open the matching PR in Biff to enable publishing. This thread remains local.</p>}
    </div>}
    </div>
  </CommentFrame>;
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
function isOutdated(thread: ReviewThread, snapshot: Snapshot): boolean {
  const attachment = thread.attachment;
  return attachment ? !attachment.matched || attachment.commitId !== snapshot.commitId || attachment.baseCommitId !== snapshot.baseCommitId : thread.anchor.commitId !== snapshot.commitId || thread.anchor.baseCommitId !== snapshot.baseCommitId;
}

/** A published root must not hide the presence of local replies in the inline preview. */
function localAuthor(message: ReviewMessage, thread: ReviewThread): string {
  const status = message.published
    ? `GitHub${thread.messages.some((entry) => !entry.published) ? " · Local" : ""}`
    : message.publicationPending ? "Publication unconfirmed" : "Local";
  return `${message.author === "agent" ? "Agent" : "You"} · ${status}`;
}
import { Markdown } from "./Markdown";
