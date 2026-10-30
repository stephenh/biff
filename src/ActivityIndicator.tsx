import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import { activities, activityContainer } from "./activity";
import { backgroundSaves } from "./optimisticSave";
import { ModalHeader } from "./ModalHeader";

/** One reserved header slot summarizes activity; details stay inside its native focus boundary. */
export function ActivityIndicator(props: { global?: boolean }) {
  const id = useId();
  const root = useRef<HTMLSpanElement>(null);
  const [owner, setOwner] = useState<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  useSyncExternalStore((listener) => activities.subscribe(listener), () => activities.getSnapshot());
  const saves = useSyncExternalStore((listener) => backgroundSaves.subscribe(listener), () => backgroundSaves.getSnapshot());
  useLayoutEffect(() => { if (!props.global && root.current) setOwner(activityContainer(root.current)); }, [props.global]);

  const reads = new Map<string, ReturnType<typeof activities.all>[number]>();
  for (const entry of activities.all()) if (!reads.get(entry.scope)?.error || entry.error) reads.set(entry.scope, entry);
  const entries = [
    ...[...reads.values()].map((entry) => ({ ...entry, status: entry.error ? "error" : entry.kind })),
    ...saves.map((entry) => ({ ...entry, kind: "saving" as const })),
  ].filter((entry) => activities.owner(entry.scope) === (props.global ? null : owner));
  const failures = entries.filter((entry) => entry.status === "error");
  const pending = entries.filter((entry) => entry.status !== "error" && entry.status !== "saved");
  const saved = entries.some((entry) => entry.status === "saved");
  const writing = pending.some((entry) => entry.kind !== "loading");
  const busy = pending.length > 0;
  const [spinning, setSpinning] = useState(false);
  const state = failures.length ? "error" : busy && spinning ? writing ? "saving" : "loading" : saved && !busy ? "saved" : "idle";
  const label = failures.length ? `${failures.length} ${failures.length === 1 ? "operation needs" : "operations need"} attention` : busy ? `${writing ? "Saving or syncing" : "Loading"} (${pending.length})` : saved ? "Saved" : "No pending activity";

  useEffect(() => {
    if (!busy) { setSpinning(false); return; }
    const timer = window.setTimeout(() => setSpinning(true), 200);
    return () => window.clearTimeout(timer);
  }, [busy]);

  // Only the shell owns receipt expiry and the unsaved-work reload warning. Closing
  // a modal must never remove either, even while it owns the visible indicator.
  const nextExpiry = saves.filter((entry) => entry.status === "saved").reduce<number | undefined>((expiry, entry) => Math.min(expiry ?? Infinity, entry.savedAt! + 2500), undefined);
  const unsaved = saves.some((entry) => entry.status !== "saved");
  useEffect(() => {
    if (!props.global || nextExpiry === undefined) return;
    const timer = window.setTimeout(() => backgroundSaves.clearSaved(Date.now() - 2500), Math.max(0, nextExpiry - Date.now()));
    return () => window.clearTimeout(timer);
  }, [props.global, nextExpiry]);
  useEffect(() => {
    if (!props.global || !unsaved) return;
    function warn(event: BeforeUnloadEvent) {
      if (!backgroundSaves.getSnapshot().some((entry) => entry.status !== "saved")) return;
      event.preventDefault(); event.returnValue = "";
    }
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [props.global, unsaved]);

  return <span className="activity-slot" ref={root} data-activity-state={state} style={{ "--activity-anchor": `--activity-${id.replace(/[^\w-]/g, "")}` } as CSSProperties}>
    <button type="button" className="activity-toggle" aria-label={`Activity: ${label}`} title={label} aria-expanded={open} aria-controls={id} popoverTarget={id}>
      <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
        {state === "error" ? <><path d="M10 3 18 17H2L10 3Z" /><path d="M10 8v4m0 2v.5" /></> : state === "saved" ? <path d="m4 10 4 4 8-8" /> : state === "loading" ? <path className="activity-spinner" d="M17 10a7 7 0 1 1-7-7" /> : <><path d="M6 15H5a4 4 0 0 1-.5-8A5.5 5.5 0 0 1 15 6a4.5 4.5 0 0 1 .5 9H14" />{state === "saving" ? <path className="activity-spinner" d="M13 14a3 3 0 1 1-3-3" /> : <path d="M10 11v6m-2-2 2 2 2-2" />}</>}
      </svg>
      {failures.length > 0 && <span className="activity-badge">{failures.length}</span>}
    </button>
    <span className="sr-only" role="status" aria-live="polite">{state === "error" || state === "saved" ? label : ""}</span>
    <section id={id} popover="auto" className="activity-panel" role="dialog" aria-label="Activity" onKeyDown={(event) => { if (event.key !== "?") event.stopPropagation(); }} onToggle={(event) => {
      setOpen(event.newState === "open");
      if (event.newState === "open") event.currentTarget.querySelector<HTMLButtonElement>(".modal-close")?.focus();
    }}>
      <ModalHeader title="Activity" closeLabel="Close activity" popoverTarget={id} activity={false} />
      {!entries.length && <p className="muted">No pending activity.</p>}
      <div className="activity-list">{[...failures, ...entries.filter((entry) => entry.status !== "error")].map((entry) => <div className="activity-entry" key={entry.id}>
        <div><strong>{entry.label}</strong><span className={entry.status === "error" ? "activity-failure" : "muted"}>{entry.error || (entry.status === "saved" ? "Saved" : entry.kind === "saving" ? "Saving…" : entry.kind === "syncing" ? "Syncing…" : "Loading…")}</span></div>
        {entry.status === "error" && entry.retry && <button onClick={entry.retry}>Retry</button>}
      </div>)}</div>
    </section>
  </span>;
}
