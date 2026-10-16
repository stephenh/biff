import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import type { MentionUser } from "../shared/types";
import { useResource } from "./api";
import { completeMention, mentionAtCaret } from "./mentions";

interface Props {
  endpoint: string;
  label: string;
  value: string;
  placeholder?: string;
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
  onValueChange(value: string): void;
}

/**
 * Complete repository-user mentions in any GitHub comment composer.
 *
 * The suggestion list uses the browser's top layer so a scrolling review drawer
 * or native comment dialog cannot clip it. It never adds rows to the code diff.
 */
export function MentionTextarea(props: Props) {
  const ownInput = useRef<HTMLTextAreaElement>(null);
  const input = props.textareaRef ?? ownInput;
  const popup = useRef<HTMLDivElement>(null);
  const completion = useRef<{ value: string; caret: number } | undefined>(undefined);
  const listId = useId();
  const [selection, setSelection] = useState({ start: 0, end: 0 });
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState("");
  const [search, setSearch] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const [bounds, setBounds] = useState({ top: 0, left: 0, width: 0, maxHeight: 280 });
  const token = focused ? mentionAtCaret(props.value, selection.start, selection.end) : undefined;
  const key = token ? `${token.start}:${token.end}:${token.query}` : "";
  const open = Boolean(token && key !== dismissed);
  const resource = useResource<MentionUser[]>(open && search !== null ? `${props.endpoint}/mentions?q=${encodeURIComponent(search)}` : null);
  const users = open && search === token?.query ? resource.data ?? [] : [];
  const activeIndex = Math.min(index, Math.max(0, users.length - 1));

  useLayoutEffect(() => {
    if (!completion.current || completion.current.value !== props.value) return;
    // Restore before the next keystroke; a delayed animation frame can move the
    // caret backwards after the reader has already started the next word.
    const caret = completion.current.caret;
    completion.current = undefined;
    input.current?.focus();
    input.current?.setSelectionRange(caret, caret);
  }, [props.value]);

  useEffect(() => {
    setSearch(null);
    setIndex(0);
    if (!open || !token) return;
    const timer = window.setTimeout(() => setSearch(token.query), 180);
    return () => window.clearTimeout(timer);
  }, [open, key]);

  useLayoutEffect(() => {
    if (!open) return;
    const element = popup.current!;

    /** Prefer below the composer, or above it when near the viewport's bottom. */
    function position() {
      const rect = input.current!.getBoundingClientRect();
      const height = Math.min(280, Math.max(64, users.length * 48 + 12));
      const below = window.innerHeight - rect.bottom - 12;
      const above = rect.top - 12;
      const upwards = below < height && above > below;
      const maxHeight = Math.max(48, Math.min(height, upwards ? above : below));
      setBounds({ top: upwards ? rect.top - maxHeight - 4 : rect.bottom + 4, left: rect.left, width: rect.width, maxHeight });
    }

    position();
    element.showPopover();
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => {
      if (element.matches(":popover-open")) element.hidePopover();
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
    };
  }, [open, users.length]);

  useEffect(() => {
    if (open && users.length) document.getElementById(`${listId}-${activeIndex}`)?.scrollIntoView({ block: "nearest" });
  }, [open, activeIndex, users.length, listId]);

  /** Track the actual caret so mentions also work inside an existing draft. */
  function trackSelection(element: HTMLTextAreaElement) {
    setSelection({ start: element.selectionStart, end: element.selectionEnd });
  }

  /** Restore typing focus and place the caret after the inserted username. */
  function choose(user: MentionUser) {
    if (!token) return;
    const completed = completeMention(props.value, token, user.login);
    completion.current = completed;
    props.onValueChange(completed.value);
    setDismissed(key);
    setSelection({ start: completed.caret, end: completed.caret });
  }

  /** Consume suggestion keys before they can dismiss a dialog or submit a form. */
  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (!open || event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault(); event.stopPropagation(); setDismissed(key);
    } else if (users.length && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      setIndex((activeIndex + (event.key === "ArrowDown" ? 1 : -1) + users.length) % users.length);
    } else if (users.length && (event.key === "Enter" || event.key === "Tab")) {
      event.preventDefault();
      choose(users[activeIndex]);
    }
  }

  return <>
    <textarea ref={input} aria-label={props.label} placeholder={props.placeholder} value={props.value} role="combobox" aria-autocomplete="list" aria-expanded={open} aria-controls={open ? listId : undefined} aria-activedescendant={open && users.length ? `${listId}-${activeIndex}` : undefined} onChange={(event) => { props.onValueChange(event.target.value); trackSelection(event.currentTarget); setDismissed(""); }} onFocus={(event) => { setFocused(true); trackSelection(event.currentTarget); }} onBlur={() => setFocused(false)} onSelect={(event) => trackSelection(event.currentTarget)} onKeyDown={onKeyDown} />
    <div ref={popup} className="mention-suggestions" popover="manual" style={bounds}>
      <div id={listId} role="listbox" aria-label="Repository users">{users.map((user, userIndex) => <button type="button" role="option" id={`${listId}-${userIndex}`} aria-selected={userIndex === activeIndex} key={user.login} onMouseDown={(event) => event.preventDefault()} onClick={() => choose(user)}>
        <strong>@{user.login}</strong>{user.name && <span>{user.name}</span>}
      </button>)}</div>
      {!users.length && <p role="status"><span>{resource.error ? "Could not load repository users." : search === token?.query && !resource.loading ? "No matching repository users." : "Loading repository users…"}</span>{resource.error && <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={resource.refresh}>Retry</button>}</p>}
    </div>
  </>;
}
