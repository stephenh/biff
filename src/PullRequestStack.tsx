import { useId, useRef, type KeyboardEvent } from "react";
import { Link } from "wouter";
import type { StackPosition } from "../shared/types";
import { ModalHeader } from "./ModalHeader";

/** Keep adjacent PRs one click away and show the whole stack without a nested select. */
export function PullRequestStack(props: { repository: string; number: string; stack: StackPosition }) {
  const id = useId();
  const popup = useRef<HTMLElement>(null);
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
    <section id={id} ref={popup} className="pr-stack-popover" popover="auto" role="dialog" aria-labelledby={`${id}-title`} onKeyDown={navigateStack} onToggle={(event) => {
      if (event.newState === "open") popup.current?.querySelector<HTMLAnchorElement>('[aria-current="page"]')?.focus();
    }}>
      <ModalHeader title={`PR stack · ${stack.total} PRs`} titleId={`${id}-title`} closeLabel="Close PR stack" popoverTarget={id} shortcuts={[
        { keys: "ArrowDown", description: "Next PR" }, { keys: "ArrowUp", description: "Previous PR" },
        { keys: "Enter", description: "Open PR" }, { keys: "Escape", description: "Close" },
      ]} />
      <ol className="pr-stack-list">{stack.pulls.map((pr, index) => <li key={pr.number}>
        <Link href={`/pr/${props.repository}/${pr.number}`} aria-current={String(pr.number) === props.number ? "page" : undefined} onClick={() => popup.current?.hidePopover()}>
          <span className="pr-stack-position">{index + 1}</span>
          <span className="pr-stack-details"><span className="pr-stack-title">{pr.title}</span><span className="pr-stack-meta">#{pr.number}{String(pr.number) === props.number ? " · Current PR" : ""}</span></span>
        </Link>
      </li>)}</ol>
      <p className="pr-stack-order">Base → top of stack</p>
    </section>
  </nav>;
}

/** Move focus within the list without stealing native dialog dismissal or link activation. */
function navigateStack(event: KeyboardEvent<HTMLElement>) {
  if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  const links = [...event.currentTarget.querySelectorAll<HTMLAnchorElement>(".pr-stack-list a")];
  const index = links.indexOf(document.activeElement as HTMLAnchorElement);
  if (index < 0) return;

  event.preventDefault();
  const next = event.key === "Home" ? 0 : event.key === "End" ? links.length - 1 : index + (event.key === "ArrowDown" ? 1 : -1);
  links[Math.max(0, Math.min(links.length - 1, next))]?.focus();
}
