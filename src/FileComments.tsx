import { useEffect, useRef, useState, type ReactNode } from "react";
import type { DiscussionComment } from "../shared/types";
import type { CommentSelection, LineThread } from "./lineComments";
import { BackgroundSaveStatus } from "./BackgroundSaveStatus";

interface CommentFile { name: string; prevName?: string }
interface FileCommentGroup { path: string; threads: LineThread[] }

/**
 * Default to the selected file's discussion, with an option to browse the entire review.
 *
 * The list stays mounted while a thread is open so Back preserves its scroll position and selection.
 */
export function FileComments(props: {
  files: CommentFile[]; path: string; threads: LineThread[]; saveScope: string; threadContent?: ReactNode; activeThreadId?: string; returnFocus?: HTMLElement | null;
  onReply(selection: CommentSelection): void; onResolve?(id: string, resolved: boolean): void; onClose(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [reviewWide, setReviewWide] = useState(false);
  const allGroups = groupFileComments(props.files, props.path, props.threads);
  const fileThreadCount = allGroups.filter((group) => group.path === props.path).flatMap((group) => group.threads).filter((thread) => !thread.resolved).length;
  const reviewThreadCount = props.threads.filter((thread) => !thread.resolved).length;
  const groups = allGroups.filter((group) => reviewWide ? group.threads.length > 0 : group.path === props.path);
  const threads = groups.flatMap((group) => group.threads);
  const unresolvedCount = reviewWide ? reviewThreadCount : fileThreadCount;
  const [selected, setSelected] = useState<string>();
  const inThread = Boolean(props.threadContent);
  const selectedId = inThread ? props.activeThreadId ?? selected : selected;
  const active = Math.max(0, threads.findIndex((thread) => thread.id === selectedId));
  const thread = threads[active];
  const activeId = thread?.id;
  const canChangeResolution = Boolean(props.onResolve && (thread?.resolved ? thread.canReopen : thread?.canResolve));

  useEffect(() => {
    if (inThread && props.activeThreadId) setSelected(props.activeThreadId);
  }, [inThread, props.activeThreadId]);

  useEffect(() => {
    const element = dialog.current!;
    const previous = props.returnFocus ?? document.activeElement;
    element.showModal();
    return () => { element.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);

  useEffect(() => {
    if (inThread) return;
    const button = dialog.current?.querySelector<HTMLButtonElement>(`[data-comment-index="${active}"]`);
    // An empty scope removes the focused thread. Keep focus inside the dialog
    // so the next h/l keypress still reaches its keyboard handler.
    const target = button ?? dialog.current?.querySelector<HTMLButtonElement>('.file-comments-scope [aria-pressed="true"]');
    target?.focus({ preventScroll: true });
    button?.scrollIntoView({ block: "nearest" });
  }, [active, activeId, inThread, reviewWide]);

  /** Keep navigation and reversals available while the owner saves this intent in the background. */
  function resolveThread(resolved: boolean) {
    if (!thread || !props.onResolve || thread.resolved === resolved || !(resolved ? thread.canResolve : thread.canReopen)) return;
    props.onResolve(thread.id, resolved);
  }

  return <dialog ref={dialog} className="file-comments" data-comment-overlay aria-label={reviewWide ? "Review comments" : "File comments"} onCancel={(event) => { event.preventDefault(); if (!inThread) props.onClose(); }} onClick={(event) => {
    if (event.target !== event.currentTarget || inThread) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) props.onClose();
  }} onKeyDown={(event) => {
    const editing = event.nativeEvent.composedPath().some((target) => target instanceof HTMLElement && target.closest("input, textarea, select, [contenteditable]"));
    if (event.defaultPrevented || editing || event.ctrlKey || event.metaKey || event.altKey || event.nativeEvent.isComposing) return;
    if (event.key === "r" || event.key === "u") {
      event.preventDefault();
      if (!event.repeat) resolveThread(event.key === "r");
      return;
    }
    if (inThread) return;
    if (["h", "l", "ArrowLeft", "ArrowRight"].includes(event.key)) {
      event.preventDefault();
      setReviewWide(event.key === "l" || event.key === "ArrowRight");
    } else if (["j", "k", "ArrowDown", "ArrowUp"].includes(event.key)) {
      event.preventDefault();
      const next = Math.max(0, Math.min(threads.length - 1, active + (event.key === "j" || event.key === "ArrowDown" ? 1 : -1)));
      if (threads[next]) setSelected(threads[next].id);
    }
  }}>
    {!inThread && <div className="panel-heading"><h2>{reviewWide ? "Review comments" : "File comments"}</h2><button onClick={props.onClose} aria-label="Close file comments">×</button></div>}
    <div className="file-comments-tools">
      {!inThread && <div className="file-comments-scope" role="group" aria-label="Comment scope">
        <button aria-pressed={!reviewWide} onClick={() => setReviewWide(false)} title={`${props.path} (h / ←)`}>This file ({fileThreadCount})</button>
        <button aria-pressed={reviewWide} onClick={() => setReviewWide(true)} title="Entire review (l / →)">Entire review ({reviewThreadCount})</button>
      </div>}
      <span className="file-comments-count">{unresolvedCount} unresolved {unresolvedCount === 1 ? "thread" : "threads"}</span>
      {thread?.resolved !== undefined && <button disabled={!canChangeResolution} onClick={() => resolveThread(!thread.resolved)}>{thread.resolved ? "Unresolve thread" : "Resolve thread"}</button>}
      <BackgroundSaveStatus scope={props.saveScope} />
      <span className="file-comments-shortcuts" title="Keyboard shortcuts do not run while typing in a text field.">{!inThread && <><kbd>h</kbd> / <kbd>l</kbd> scope · <kbd>j</kbd> / <kbd>k</kbd> navigate · <kbd>Enter</kbd> open · </>}<kbd>r</kbd> resolve · <kbd>u</kbd> unresolve · <kbd>Esc</kbd> {inThread ? "back" : "close"}</span>
    </div>
    <div className="file-comments-body" hidden={inThread}>
      {!groups.length && <p className="muted">No comments in this review.</p>}
      {groups.map((group) => <section key={`${group.path}:${group.threads[0]?.outdated ? "orphaned" : "current"}`} aria-label={group.path} className="file-comment-group">
        {reviewWide && <h3 className="file-comment-path">{group.path}</h3>}
        {!group.threads.length && <p className="muted">No comments on this file.</p>}
        {group.threads.map((thread) => {
          const index = threads.indexOf(thread);
          return <button key={thread.id} className="file-comment-thread" data-resolved={thread.resolved ? "" : undefined} data-comment-index={index} data-selected={index === active ? "" : undefined} onFocus={() => setSelected(thread.id)} onClick={() => props.onReply({ line: thread.location, threadId: thread.id, embedded: true, onSubmitted: props.onClose })}>
            <span className="file-comment-location">L{thread.location.line}{thread.location.side === "LEFT" ? " · old" : ""}<span className={thread.outdated ? "comment-outdated" : "muted"}>{thread.outdated ? "Orphaned · outdated snapshot" : "Current"}</span>{Boolean(thread.unreadCount) && <span className="comment-outdated">{thread.unreadCount} unread</span>}{thread.resolved && <span className="file-comment-resolved">✓ Resolved</span>}</span>
            {thread.resolved ? <span className="file-comment-collapsed"><strong>{thread.comments[0]?.user.login}</strong><span className="file-comment-collapsed-body">{thread.comments[0]?.body}</span><span className="muted">{thread.comments.length} {thread.comments.length === 1 ? "comment" : "comments"} · Enter to read</span></span> : <>
              {thread.comments[0] && <CommentPreview comment={thread.comments[0]} />}
              {thread.comments.length > 1 && <span className="file-comment-replies">{thread.comments.slice(1).map((comment) => <CommentPreview key={comment.id} comment={comment} reply />)}</span>}
              <span className="file-comment-open"><span>{thread.comments.length > 1 ? `${thread.comments.length - 1} ${thread.comments.length === 2 ? "reply" : "replies"}` : "No replies yet"}</span><span>Open thread →</span></span>
            </>}
          </button>;
        })}
      </section>)}
    </div>
    {props.threadContent}
  </dialog>;
}

/** Give replies their own author marker while keeping them visibly attached to the root. */
function CommentPreview(props: { comment: DiscussionComment; reply?: boolean }) {
  return <span className="file-comment-message">
    <span className="file-comment-message-heading"><span className="file-comment-avatar" aria-hidden="true">{props.comment.user.login[0]?.toUpperCase()}</span><strong>{props.comment.user.login}</strong>{props.reply && <span className="muted">replied</span>}</span>
    <span className="markdown-text">{props.comment.body}</span>
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
    groups.get(key)!.push({ ...thread, outdated: thread.outdated || !file });
  }

  const order = [...new Set([path, ...files.map((file) => file.name), ...groups.keys()])];
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
