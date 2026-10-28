import { useEffect, useRef, useState, type ReactNode } from "react";
import type { DiscussionComment } from "../shared/types";
import type { CommentSelection, LineThread } from "./lineComments";
import type { CodeLocation } from "./navigation";
import { BackgroundSaveStatus } from "./BackgroundSaveStatus";
import { ModalBusyContext, ModalHeader } from "./ModalHeader";
import { commentShortcuts, messageShortcuts } from "./shortcutDefinitions";
import { EmbeddedThreadActions } from "./CommentFrame";

interface CommentFile { name: string; prevName?: string }
interface FileCommentGroup { path: string; threads: LineThread[] }

/**
 * Default to the selected file's discussion, with an option to browse the entire review.
 *
 * The list stays mounted while a thread is open so Back preserves its scroll position and selection.
 */
export function FileComments(props: {
  files: CommentFile[]; path: string; threads: LineThread[]; saveScope: string; threadContent?: ReactNode; activeThreadId?: string; returnFocus?: HTMLElement | null;
  reviewOnly?: boolean; unreadOnly?: boolean; loading?: boolean; error?: string; context?: ReactNode;
  onRetry?(): void; onNewComment?(): void; onRead?(thread: LineThread): void;
  onComplete?(thread: LineThread): void;
  onGoToCode?(line: CodeLocation): void;
  onReply(selection: CommentSelection): void; onResolve?(id: string, resolved: boolean): void; onClose(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [reviewWide, setReviewWide] = useState(Boolean(props.reviewOnly));
  const [unreadOnly, setUnreadOnly] = useState(Boolean(props.unreadOnly));
  const [selected, setSelected] = useState<string>();
  const [visited, setVisited] = useState<Set<string>>(() => new Set());
  const [threadBusy, setThreadBusy] = useState(false);
  const allGroups = groupFileComments(props.files, props.path, props.threads);
  const fileThreadCount = allGroups.filter((group) => group.path === props.path).flatMap((group) => group.threads).filter((thread) => !thread.resolved).length;
  const reviewThreadCount = props.threads.filter((thread) => !thread.resolved).length;
  const scopedGroups = allGroups.filter((group) => reviewWide ? group.threads.length > 0 : group.path === props.path);
  const unreadCount = scopedGroups.flatMap((group) => group.threads).filter((thread) => (thread.unreadCount ?? 0) > 0).length;
  // Keep visited threads in place: removing a read row on focus can move the next click's target.
  const groups = scopedGroups.map((group) => ({ ...group, threads: group.threads.filter((thread) => !unreadOnly || (thread.unreadCount ?? 0) > 0 || visited.has(thread.id)) })).filter((group) => !unreadOnly || group.threads.length > 0);
  const threads = groups.flatMap((group) => group.threads);
  const unresolvedCount = scopedGroups.flatMap((group) => group.threads).filter((thread) => !thread.kind && !thread.resolved).length;
  const inThread = Boolean(props.threadContent);
  const selectedId = inThread ? props.activeThreadId ?? selected : selected;
  const active = Math.max(0, threads.findIndex((thread) => thread.id === selectedId));
  const thread = inThread ? props.threads.find((thread) => thread.id === props.activeThreadId) : threads[active];
  const activeId = thread?.id;
  const codeLocation: CodeLocation | undefined = thread && !thread.kind && props.files.some((file) => file.name === thread.location.path || file.prevName === thread.location.path)
    ? { ...thread.location, approximate: thread.outdated } : undefined;
  const canGoToCode = Boolean(props.onGoToCode && codeLocation);

  useEffect(() => {
    if (inThread && props.activeThreadId) {
      const id = props.activeThreadId;
      setSelected(id);
      setVisited((current) => current.has(id) ? current : new Set([...current, id]));
    }
  }, [inThread, props.activeThreadId]);

  useEffect(() => {
    const element = dialog.current!;
    const previous = props.returnFocus ?? document.activeElement;
    const row = previous instanceof Element ? previous.closest(".pr-card") : null;
    element.showModal();
    return () => {
      element.close();
      const target = previous instanceof HTMLElement && previous.isConnected && previous.getClientRects().length ? previous : row?.querySelector<HTMLElement>(".card-title");
      target?.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    if (inThread) return;
    const button = dialog.current?.querySelector<HTMLButtonElement>(`[data-comment-index="${active}"]`);
    // An empty scope removes the focused thread. Keep focus inside the dialog
    // so the next h/l keypress still reaches its keyboard handler.
    const target = button ?? dialog.current?.querySelector<HTMLElement>('.file-comments-scope [aria-pressed="true"], .modal-close');
    target?.focus({ preventScroll: true });
    button?.scrollIntoView({ block: "nearest" });
  }, [active, activeId, inThread, reviewWide]);

  /** Keep navigation and reversals available while the owner saves this intent in the background. */
  function resolveThread(target: LineThread | undefined, resolved: boolean) {
    if (!target || !props.onResolve || target.resolved === resolved || !(resolved ? target.canResolve : target.canReopen)) return;
    if (resolved) {
      // Keep the row selected in unread-only lists while acknowledging the displayed comments.
      setVisited((current) => new Set([...current, target.id]));
    }
    props.onResolve(target.id, resolved);
  }

  /** Bind each action to its own thread, regardless of keyboard selection. */
  function resolutionAction(target: LineThread) {
    if (!props.onResolve || target.resolved === undefined) return null;
    return <button disabled={!(target.resolved ? target.canReopen : target.canResolve)} onClick={() => resolveThread(target, !target.resolved)}>{target.resolved ? "Unresolve thread" : "Resolve thread"}</button>;
  }

  return <dialog ref={dialog} className="file-comments" data-comment-overlay aria-label={reviewWide ? "Review comments" : "File comments"} onCancel={(event) => { event.preventDefault(); if (!inThread) props.onClose(); }} onClick={(event) => {
    if (event.target !== event.currentTarget || inThread) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) props.onClose();
  }} onKeyDown={(event) => {
    const editing = event.nativeEvent.composedPath().some((target) => target instanceof HTMLElement && target.closest("input, textarea, select, [contenteditable]"));
    if (event.defaultPrevented || editing || event.ctrlKey || event.metaKey || event.altKey || event.nativeEvent.isComposing) return;
    if (event.key === "g" && canGoToCode) {
      event.preventDefault();
      if (!event.repeat) props.onGoToCode?.(codeLocation!);
      return;
    }
    if (event.key === "r" || (inThread && event.key === "u")) {
      event.preventDefault();
      if (!event.repeat) resolveThread(thread, event.key === "r");
      return;
    }
    if (inThread) return;
    if (event.key === " " && props.onRead && thread) {
      // Leave native controls alone; Space completes only the focused thread row.
      if (!(event.target instanceof Element) || !event.target.closest(".file-comment-thread")) return;
      event.preventDefault();
      if (event.repeat) return;
      setVisited((current) => new Set([...current, thread.id]));
      if (thread.id.startsWith("comment-") && props.onComplete) props.onComplete(thread);
      else props.onRead(thread);
      setSelected(threads[Math.min(threads.length - 1, active + 1)]?.id);
      return;
    }
    if (!props.reviewOnly && ["h", "l", "ArrowLeft", "ArrowRight"].includes(event.key)) {
      event.preventDefault();
      setReviewWide(event.key === "l" || event.key === "ArrowRight");
    } else if (["j", "k", "ArrowDown", "ArrowUp"].includes(event.key)) {
      event.preventDefault();
      const next = Math.max(0, Math.min(threads.length - 1, active + (event.key === "j" || event.key === "ArrowDown" ? 1 : -1)));
      if (threads[next]) setSelected(threads[next].id);
    }
  }}>
    <ModalHeader title={reviewWide ? "Review comments" : "File comments"} closeLabel={reviewWide ? "Close review comments" : "Close file comments"} closeDisabled={threadBusy} onClose={props.onClose} shortcuts={[
      ...(!inThread ? commentShortcuts.filter((shortcut) => !props.reviewOnly || !["h", "l"].includes(shortcut.keys)) : messageShortcuts),
      ...(!inThread && props.onRead ? [{ keys: "Space", description: "Mark read, resolve own GitHub thread, and advance" }] : []),
      ...(canGoToCode ? [{ keys: "g", description: "Go to code" }] : []),
      ...(props.onResolve && thread?.canResolve && !thread.resolved ? [{ keys: "r", description: "Resolve thread" }] : []),
      ...(inThread && props.onResolve && thread?.canReopen && thread.resolved ? [{ keys: "u", description: "Unresolve thread" }] : []),
      ...(!threadBusy ? [{ keys: "Escape", description: inThread ? `Back to ${reviewWide ? "review" : "file"} comments` : "Close" }] : []),
    ]} />
    <div className="file-comments-tools">
      {props.context && <div className="file-comments-context">{props.context}</div>}
      {!inThread && !props.reviewOnly && <div className="file-comments-scope" role="group" aria-label="Comment scope">
        <button aria-pressed={!reviewWide} onClick={() => setReviewWide(false)} title={`${props.path} (h / ←)`}>This file ({fileThreadCount})</button>
        <button aria-pressed={reviewWide} onClick={() => setReviewWide(true)} title="Entire review (l / →)">Entire review ({reviewThreadCount})</button>
      </div>}
      {!inThread && <label><input type="checkbox" checked={unreadOnly} onChange={(event) => { setUnreadOnly(event.target.checked); setSelected(undefined); setVisited(new Set()); }} /> Unread ({unreadCount})</label>}
      {!inThread && props.onNewComment && <button onClick={props.onNewComment}>New PR comment</button>}
      <span className="file-comments-count">{scopedGroups.reduce((count, group) => count + group.threads.length, 0)} threads · {unresolvedCount} unresolved</span>
      {canGoToCode && <button onClick={() => props.onGoToCode?.(codeLocation!)}>Go to code</button>}
      <BackgroundSaveStatus scope={props.saveScope} />
    </div>
    <div className="file-comments-body" hidden={inThread}>
      {props.loading && <p role="status">Loading comments…</p>}
      {props.error && <p className="error" role="alert">{props.error} {props.onRetry && <button onClick={props.onRetry}>Retry</button>}</p>}
      {!props.loading && !props.error && !groups.length && <p className="muted">{unreadOnly ? "All caught up." : "No comments in this review."}</p>}
      {groups.map((group) => <section key={`${group.path}:${group.threads[0]?.outdated ? "orphaned" : "current"}`} aria-label={group.path} className="file-comment-group">
        {!group.threads.length && <p className="muted">No comments on this file.</p>}
        {group.threads.map((thread) => {
          const index = threads.indexOf(thread);
          return <article key={thread.id} className="file-comment-card" onFocus={() => setSelected(thread.id)}><button className="file-comment-thread" data-resolved={thread.resolved ? "" : undefined} data-comment-index={index} data-selected={index === active ? "" : undefined} onClick={() => props.onReply({ line: thread.location, threadId: thread.id, embedded: true, reviewWide, onSubmitted: props.onClose })}>
            <span className="file-comment-location">{thread.kind ? (thread.kind === "general" ? "PR discussion" : "Review summary") : <><span className="file-comment-path">{thread.location.path}:L{thread.location.line}{thread.location.side === "LEFT" ? " · old" : ""}</span><span className={thread.outdated ? "comment-outdated" : "muted"}>{thread.outdated ? "Outdated" : "Current"}</span></>}{Boolean(thread.unreadCount) && <span className="comment-outdated">Unread</span>}{thread.resolved && <span className="file-comment-resolved">✓ Resolved</span>}</span>
            {thread.resolved ? <span className="file-comment-collapsed"><strong>{thread.comments[0]?.user.login}</strong><span className="file-comment-collapsed-body">{thread.comments[0]?.body}</span><span className="muted">{thread.comments.length} {thread.comments.length === 1 ? "comment" : "comments"}</span></span> : <>
              {thread.comments[0] && <CommentPreview comment={thread.comments[0]} />}
              {thread.comments.length > 1 && <span className="file-comment-replies">{thread.comments.slice(1).map((comment) => <CommentPreview key={comment.id} comment={comment} reply />)}</span>}
            </>}
          </button>{!thread.resolved && <div className="file-comment-open"><span>{thread.comments.length > 1 ? `${thread.comments.length - 1} ${thread.comments.length === 2 ? "reply" : "replies"}` : "No replies yet"}</span><div className="file-comment-actions">{resolutionAction(thread)}<button onClick={() => props.onReply({ line: thread.location, threadId: thread.id, embedded: true, reviewWide, onSubmitted: props.onClose })}>Open thread →</button></div></div>}</article>;
        })}
      </section>)}
    </div>
    <ModalBusyContext value={setThreadBusy}><EmbeddedThreadActions value={thread?.resolved !== undefined && props.onResolve ? <div className="file-comment-detail-actions">{resolutionAction(thread)}</div> : null}>{props.threadContent}</EmbeddedThreadActions></ModalBusyContext>
  </dialog>;
}

/** Give replies their own author marker while keeping them visibly attached to the root. */
function CommentPreview(props: { comment: DiscussionComment; reply?: boolean }) {
  return <span className="file-comment-message">
    <span className="file-comment-message-heading"><span className="file-comment-avatar" aria-hidden="true">{props.comment.user.login[0]?.toUpperCase()}</span><strong>{props.comment.user.login}</strong>{props.reply && <span className="muted">replied</span>}</span>
    <Markdown body={props.comment.body} preview />
  </span>;
}

/**
 * Keep renamed paths together and retain discussions on files absent from the current patch.
 *
 * All current threads precede orphaned ones. Each section retains the selected-file-first order.
 */
export function groupFileComments(files: CommentFile[], path: string, threads: LineThread[]): FileCommentGroup[] {
  const groups = new Map<string, LineThread[]>([[path, []]]);
  for (const thread of threads) {
    const file = files.find((file) => file.name === thread.location.path || file.prevName === thread.location.path);
    const key = file?.name ?? thread.location.path;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push({ ...thread, outdated: thread.kind ? false : thread.outdated || !file });
  }

  const order = [...new Set([path, ...threads.filter((thread) => thread.kind).map((thread) => thread.location.path), ...files.map((file) => file.name), ...groups.keys()])];
  const ordered = [...groups].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0])).map((entry) => ({
    path: entry[0], threads: entry[1].sort((a, b) => a.location.line - b.location.line),
  }));
  const sections = ordered.flatMap((group) => {
    if (!group.threads.length) return [group];
    const current = group.threads.filter((thread) => !thread.outdated);
    const orphaned = group.threads.filter((thread) => thread.outdated);
    return [...(current.length ? [{ path: group.path, threads: current }] : []), ...(orphaned.length ? [{ path: group.path, threads: orphaned }] : [])];
  });
  return sections.sort((a, b) => Number(Boolean(a.threads[0]?.outdated)) - Number(Boolean(b.threads[0]?.outdated)));
}
import { Markdown } from "./Markdown";
