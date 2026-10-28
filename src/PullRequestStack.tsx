import { useId, useRef, useState, type KeyboardEvent } from "react";
import { Link } from "wouter";
import type { PullRequestStatus, StackPosition } from "../shared/types";
import { ModalHeader } from "./ModalHeader";
import { PullRequestStatusIndicators } from "./PullRequestStatusIndicators";
import { useResource } from "./api";
import { matchesShortcut, type Shortcut } from "./shortcuts";

const stackNavigationShortcuts: Shortcut[] = [
  { keys: "j", aliases: ["ArrowDown"], description: "Next PR" }, { keys: "k", aliases: ["ArrowUp"], description: "Previous PR" },
  { keys: "Home", description: "First PR" }, { keys: "End", description: "Last PR" },
];

/** Keep adjacent PRs one click away and show the whole stack without a nested select. */
export function PullRequestStack(props: { repository: string; number: string; stack: StackPosition; status?: PullRequestStatus }) {
  const id = useId();
  const popup = useRef<HTMLElement>(null);
  const selected = useRef(props.stack.position - 1);
  const [open, setOpen] = useState(false);
  const stack = props.stack;
  const previous = stack.pulls[stack.position - 2];
  const next = stack.pulls[stack.position];

  return <nav className="pr-stack" aria-label="PR stack">
    {previous ? <Link className="pr-stack-arrow" href={`/pr/${props.repository}/${previous.number}`} aria-label="Previous PR in stack" title={`#${previous.number} · ${previous.title}`}>←</Link>
      : <button className="pr-stack-arrow" aria-label="Previous PR in stack" disabled>←</button>}
    <button className="pr-stack-trigger" popoverTarget={id} aria-label={`Stack: PR ${stack.position} of ${stack.total}`}>
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m2 5 6-3 6 3-6 3-6-3Zm0 3 6 3 6-3M2 11l6 3 6-3" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" /></svg>
      Stack {stack.position} of {stack.total}<span aria-hidden="true">▾</span>
    </button>
    {next ? <Link className="pr-stack-arrow" href={`/pr/${props.repository}/${next.number}`} aria-label="Next PR in stack" title={`#${next.number} · ${next.title}`}>→</Link>
      : <button className="pr-stack-arrow" aria-label="Next PR in stack" disabled>→</button>}
    <section id={id} ref={popup} className="pr-stack-popover" popover="auto" role="dialog" aria-labelledby={`${id}-title`} onKeyDown={(event) => navigateStack(event, selected.current)} onToggle={(event) => {
      setOpen(event.newState === "open");
      if (event.newState === "open") popup.current?.querySelector<HTMLAnchorElement>('[aria-current="page"]')?.focus();
    }}>
      <ModalHeader title={`PR stack · ${stack.total} PRs`} titleId={`${id}-title`} closeLabel="Close PR stack" popoverTarget={id} shortcuts={[
        ...stackNavigationShortcuts,
        { keys: "Enter", description: "Open PR" }, { keys: "Escape", description: "Close" },
      ]} />
      <ol className="pr-stack-list">{stack.pulls.map((pr, index) => <li className="pr-stack-row" key={pr.number} onFocus={() => { selected.current = index; }}>
        <Link href={`/pr/${props.repository}/${pr.number}`} aria-current={String(pr.number) === props.number ? "page" : undefined} onClick={() => popup.current?.hidePopover()}>
          <span className="pr-stack-position">{index + 1}</span>
          <span className="pr-stack-details"><span className="pr-stack-title">{pr.title}</span><span className="pr-stack-meta">#{pr.number}{String(pr.number) === props.number ? " · Current PR" : ""}{pr.progress && <span title="Hunk progress for the last loaded PR comparison"> · {pr.progress.reviewed}/{pr.progress.total} hunks reviewed</span>}</span></span>
        </Link>
        {open && <StackStatus repository={props.repository} number={pr.number} current={String(pr.number) === props.number} status={props.status} />}
      </li>)}</ol>
      <p className="pr-stack-order">Base → top of stack</p>
    </section>
  </nav>;
}

/** Reuse the current title's live status; load other summaries only while the stack is open. */
function StackStatus(props: { repository: string; number: number; current: boolean; status?: PullRequestStatus }) {
  const status = useResource<PullRequestStatus>(props.current ? null : `/api/github/pr/${props.repository}/${props.number}/status`);
  return <span className="pr-stack-status"><PullRequestStatusIndicators status={props.current ? props.status : status.data} repository={props.repository} number={props.number} /></span>;
}

/** Move focus within the list without stealing native dialog dismissal or link activation. */
function navigateStack(event: KeyboardEvent<HTMLElement>, selected: number) {
  if (event.defaultPrevented || event.nativeEvent.isComposing || !matchesShortcut(event.nativeEvent, stackNavigationShortcuts)) return;
  // Nested CI choosers keep their own keyboard scope.
  if (event.target instanceof Element && event.target.closest('[role="dialog"]') !== event.currentTarget) return;
  const links = [...event.currentTarget.querySelectorAll<HTMLAnchorElement>(".pr-stack-row > a")];
  const focused = links.indexOf(document.activeElement as HTMLAnchorElement);
  const index = focused < 0 ? selected : focused;

  event.preventDefault();
  const next = event.key === "Home" ? 0 : event.key === "End" ? links.length - 1 : index + (["j", "ArrowDown"].includes(event.key) ? 1 : -1);
  links[Math.max(0, Math.min(links.length - 1, next))]?.focus();
}
