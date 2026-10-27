import { useId, useState } from "react";
import type { FailedCheck } from "../shared/types";
import { useResource } from "./api";
import { ModalHeader } from "./ModalHeader";

/**
 * Fetch provider links on demand so failed checks are actionable without slowing the PR list.
 *
 * Native popover dismissal leaves the review and its drafts intact while a read is pending.
 */
export function FailedChecks(props: { repository: string; number: string | number }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const checks = useResource<FailedCheck[]>(open ? `/api/github/pr/${props.repository}/${props.number}/failed-checks` : null);

  return <>
    <button className="pr-ci-failing" aria-label="CI failing" title="Show failed CI checks" popoverTarget={id}>×</button>
    <section id={id} className="failed-checks-popover" popover="auto" role="dialog" aria-labelledby={`${id}-title`} onToggle={(event) => setOpen(event.newState === "open")}>
      <ModalHeader title="Failed CI checks" titleId={`${id}-title`} closeLabel="Close failed CI checks" popoverTarget={id} shortcuts={[
        { keys: "Tab", description: "Choose a check" }, { keys: "Enter", description: "Open check in a new tab" }, { keys: "Escape", description: "Close" },
      ]} />
      {checks.loading && <p className="muted" role="status">Loading failed checks…</p>}
      {checks.error && <p role="alert">Could not load CI checks: {checks.error} <button onClick={checks.refresh}>Retry</button></p>}
      {checks.data?.length === 0 && <p className="muted">No failed checks on the current head. CI status may have changed.</p>}
      <ul className="failed-checks-list">{checks.data?.map((check, index) => <li key={`${check.url}:${index}`}>
        <a href={check.url} target="_blank" rel="noopener noreferrer">{check.name}<span aria-hidden="true">↗</span></a>
      </li>)}</ul>
      <a className="failed-checks-all" href={`https://github.com/${props.repository}/pull/${props.number}/checks`} target="_blank" rel="noopener noreferrer">All checks on GitHub ↗</a>
    </section>
  </>;
}
