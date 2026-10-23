/** Count conversations to visit, rather than the number of messages in them. */
export function UnreadThreadBadge(props: { count: number }) {
  return props.count > 0 ? <span className="unread-thread-badge" title={`${props.count} threads with unread comments`}><svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3.5 3h9A1.5 1.5 0 0 1 14 4.5v6a1.5 1.5 0 0 1-1.5 1.5H6l-4 2V4.5A1.5 1.5 0 0 1 3.5 3Z" /></svg>{props.count}</span> : null;
}
