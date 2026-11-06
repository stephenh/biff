import { Children, useEffect, useRef, useState, type ReactNode } from "react";
import type { LineThread } from "./lineComments";
import type { useCommentReads } from "./useCommentReads";
import { BackgroundSaveStatus } from "./BackgroundSaveStatus";
import { ActivityScope } from "./ActivityStatus";
import { isTyping } from "./shortcuts";
import { CommentPublicationStatus } from "./CommentPublicationStatus";
import { publicationPending } from "./commentPublications";
import type { DiscussionComment } from "../shared/types";

/**
 * Select individual messages without acknowledging a thread merely by opening it.
 *
 * Focus moves independently of persistence; the shared receipt queue survives closing the reader.
 */
export function CommentMessages(props: { thread?: LineThread; reads: ReturnType<typeof useCommentReads>; children: ReactNode }) {
  const thread = props.reads.threads.find((entry) => entry.id === props.thread?.id) ?? props.thread;
  const messages = thread?.comments ?? [];
  const [selected, setSelected] = useState(() => {
    const initial = messages.find((message) => thread?.unreadKeys?.includes(message.readKey ?? `github:${message.id}`)) ?? messages[0];
    return initial && messageId(initial);
  });
  const container = useRef<HTMLDivElement>(null);
  const current = messages.some((message) => messageId(message) === selected) ? selected : messages[0] && messageId(messages[0]);

  /** Space saves the exact selected ID, then moves focus independently of the request. */
  function select(index: number, read = false) {
    if (!thread || !messages.length) return;
    if (read) {
      const message = messages.find((entry) => messageId(entry) === current)!;
      props.reads.markRead(thread, [message.readKey ?? `github:${message.id}`]);
    }
    const next = Math.max(0, Math.min(messages.length - 1, index));
    setSelected(messageId(messages[next]));
    const element = container.current?.querySelectorAll<HTMLElement>("[data-comment-message]")[next];
    element?.focus({ preventScroll: true });
    element?.scrollIntoView({ block: "nearest" });
  }

  useEffect(() => {
    // The header and reply actions are siblings of the messages, but share their reading scope.
    const scope = container.current?.closest<HTMLElement>('dialog, [role="dialog"], [data-modal-scope]') ?? container.current;
    if (!scope || !messages.length) return;

    /** Resume reading from any non-typing control in this thread's dialog. */
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey || isTyping(event)) return;
      const eventScope = event.target instanceof Element ? event.target.closest('dialog, [role="dialog"], [data-modal-scope]') : null;
      if (eventScope && eventScope !== scope) return;
      if (event.key === " " && event.target instanceof Element && event.target.closest("button, a, input")) return;
      if (!["j", "k", " "].includes(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat && event.key === " ") return;
      select(messages.findIndex((message) => messageId(message) === current) + (event.key === "k" ? -1 : 1), event.key === " ");
    }

    scope.addEventListener("keydown", onKeyDown);
    return () => scope.removeEventListener("keydown", onKeyDown);
  });

  return <><div ref={container} className="overlay-thread">{Children.toArray(props.children).map((child, index) => {
    const message = messages[index];
    if (!message) return child;
    const key = message.readKey ?? `github:${message.id}`;
    const unread = Boolean(thread?.unreadKeys?.includes(key));
    const id = messageId(message);
    return <div key={id} data-comment-message data-selected={id === current ? "true" : undefined} tabIndex={id === current ? 0 : -1} className={`comment-message${unread ? " comment-message-unread" : ""}`} onFocus={() => setSelected(id)} onClick={(event) => {
      setSelected(id);
      if (event.target instanceof Element && !event.target.closest("button, a, input, textarea, select, [contenteditable]")) event.currentTarget.focus({ preventScroll: true });
    }}>
      <div className="comment-message-actions"><CommentPublicationStatus comment={message} />{!message.own && !publicationPending(message) && <button className="message-read" aria-label={unread ? "Mark comment read" : "Comment read"} aria-disabled={!unread} title="Space: mark read and advance" onKeyDown={(event) => {
        if (event.key !== " " || event.ctrlKey || event.metaKey || event.altKey) return;
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) select(index + 1, true);
      }} onClick={() => { if (unread && thread) props.reads.markRead(thread, [key]); }}>{unread ? "○ Unread" : "✓ Read"}</button>}
      {message.html_url && <a href={message.html_url} target="_blank" rel="noreferrer" aria-label={`Open ${message.user.login}'s comment on GitHub`}>↗</a>}</div>
      {child}
    </div>;
  })}</div><ActivityScope scope={props.reads.activity} /><BackgroundSaveStatus scope={props.reads.scope} /></>;
}

/** Publication must not replace the focused message's DOM node when GitHub assigns its ID. */
function messageId(message: DiscussionComment) { return message.publication?.localId ?? message.id; }
