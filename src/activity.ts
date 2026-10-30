import { useEffect, useId, useRef } from "react";

export interface Activity {
  id: string;
  scope: string;
  label: string;
  kind: "loading" | "saving" | "syncing";
  error?: string;
  retry?: () => void;
}
export interface ActivityState {
  scope?: string;
  label: string;
  loading?: boolean;
  kind?: Activity["kind"];
  error?: string;
  retry?: () => void;
}

/** Read activity is ephemeral; durable writes continue to belong to backgroundSaves. */
export class ActivityRegistry {
  private entries = new Map<string, Activity>();
  private bindings = new Map<symbol, { scope: string; element: HTMLElement }>();
  private listeners = new Set<() => void>();
  private version = 0;

  /** Share stable subscription snapshots with React. */
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  getSnapshot() { return this.version; }
  all() { return [...this.entries.values()]; }

  /** A loading operation can fail without being mistaken for an acknowledged save. */
  update(entry: Activity) { this.entries.set(entry.id, entry); this.notify(); }
  remove(id: string) { if (this.entries.delete(id)) this.notify(); }

  /** Route sibling content to its existing native dialog header without changing DOM or focus ownership. */
  bind(scope: string, element: HTMLElement) {
    const token = Symbol(scope);
    this.bindings.set(token, { scope, element });
    const owner = activityContainer(element);
    const changed = () => this.notify();
    owner?.addEventListener("toggle", changed);
    owner?.addEventListener("close", changed);
    this.notify();
    return () => {
      this.bindings.delete(token);
      owner?.removeEventListener("toggle", changed);
      owner?.removeEventListener("close", changed);
      this.notify();
    };
  }

  /** The innermost open modal owns its operations; closing it returns them to the shell. */
  owner(scope: string): HTMLElement | null {
    let owner: HTMLElement | null = null;
    for (const binding of this.bindings.values()) {
      if (binding.scope !== scope) continue;
      const candidate = activityContainer(binding.element);
      if (!candidate || candidate.matches("dialog:not([open]), [popover]:not(:popover-open)")) continue;
      if (!owner || !candidate.contains(owner)) owner = candidate;
    }
    return owner;
  }

  private notify() { this.version++; this.listeners.forEach((listener) => listener()); }
}

export const activities = new ActivityRegistry();

/** Register meaningful work, not individual polling requests or open event streams. */
export function useActivity(state: ActivityState): string {
  const id = useId();
  const scope = state.scope ?? id;
  const retry = useRef(state.retry);
  retry.current = state.retry;
  const retryable = Boolean(state.retry);

  useEffect(() => {
    if (state.loading || state.error) activities.update({ id, scope, label: state.label, kind: state.kind ?? "loading", error: state.error || undefined,
      ...(retryable ? { retry: () => retry.current?.() } : {}) });
    else activities.remove(id);
  }, [id, scope, state.label, state.kind, state.loading, state.error, retryable]);
  useEffect(() => () => activities.remove(id), [id]);
  return scope;
}

/** Panels and popovers use the same ownership boundary as keyboard help. */
export function activityContainer(element: HTMLElement): HTMLElement | null {
  return element.closest<HTMLElement>("dialog, [popover], [data-modal-scope], [role='dialog']");
}
