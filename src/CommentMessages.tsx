import { Children, useRef, useState, type ReactNode } from "react";
import type { LineThread } from "./lineComments";
import type { useCommentReads } from "./useCommentReads";
import { BackgroundSaveStatus } from "./BackgroundSaveStatus";

/**
 * Select individual messages without acknowledging a thread merely by opening it.
 *
 * Focus moves independently of persistence; the shared receipt queue survives closing the reader.
 */
export function CommentMessages(props: { thread?: LineThread; reads: ReturnType<typeof useCommentReads>; children: ReactNode }) {
  const thread = props.reads.threads.find((entry) => entry.id === props.thread?.id) ?? props.thread;
  const messages = thread?.comments ?? [];
  const [selected, setSelected] = useState(() => messages.find((message) => thread?.unreadKeys?.includes(message.readKey ?? `github:${message.id}`))?.id ?? messages[0]?.id);
  const container = useRef<HTMLDivElement>(null);
  const current = messages.some((message) => message.id === selected) ? selected : messages[0]?.id;

  /** Space saves the exact selected ID, then moves focus independently of the request. */
  function select(index: number, read = false) {
    if (!thread || !messages.length) return;
    if (read) {
      const message = messages.find((entry) => entry.id === current)!;
      props.reads.markRead(thread, [message.readKey ?? `github:${message.id}`]);
    }
    const next = Math.max(0, Math.min(messages.length - 1, index));
    setSelected(messages[next].id);
    const element = container.current?.querySelectorAll<HTMLElement>("[data-comment-message]")[next];
    element?.focus({ preventScroll: true });
    element?.scrollIntoView({ block: "nearest" });
  }

  return <><div ref={container} className="overlay-thread" onKeyDown={(event) => {
    if (event.defaultPrevented || event.nativeEvent.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.target instanceof Element && event.target.closest("input, textarea, select, [contenteditable]")) return;
    if (event.key === " " && event.target instanceof Element && event.target.closest("button, a")) return;
    if (!["j", "k", " "].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.repeat && event.key === " ") return;
    select(messages.findIndex((message) => message.id === current) + (event.key === "k" ? -1 : 1), event.key === " ");
  }}>{Children.toArray(props.children).map((child, index) => {
    const message = messages[index];
    if (!message) return child;
    const key = message.readKey ?? `github:${message.id}`;
    const unread = Boolean(thread?.unreadKeys?.includes(key));
    return <div key={message.id} data-comment-message data-selected={message.id === current ? "true" : undefined} tabIndex={message.id === current ? 0 : -1} className={`comment-message${unread ? " comment-message-unread" : ""}`} onFocus={() => setSelected(message.id)} onClick={(event) => {
      setSelected(message.id);
      if (event.target instanceof Element && !event.target.closest("button, a, input, textarea, select, [contenteditable]")) event.currentTarget.focus({ preventScroll: true });
    }}>
      <div className="comment-message-actions">{!message.own && <button className="message-read" aria-label={unread ? "Mark comment read" : "Comment read"} aria-disabled={!unread} title="Space: mark read and advance" onKeyDown={(event) => {
        if (event.key !== " " || event.ctrlKey || event.metaKey || event.altKey) return;
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) select(index + 1, true);
      }} onClick={() => { if (unread && thread) props.reads.markRead(thread, [key]); }}>{unread ? "○ Unread" : "✓ Read"}</button>}
      {message.html_url && <a href={message.html_url} target="_blank" rel="noreferrer" aria-label={`Open ${message.user.login}'s comment on GitHub`}>↗</a>}</div>
      {child}
    </div>;
  })}</div><BackgroundSaveStatus scope={props.reads.scope} /></>;
}
