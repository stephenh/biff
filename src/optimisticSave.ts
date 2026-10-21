export interface BackgroundSave {
  id: string;
  scope: string;
  label: string;
  status: "saving" | "saved" | "error";
  error?: string;
  savedAt?: number;
  retry(): void;
}

interface PendingValue<Value> {
  value: Value;
  confirmed: Value;
  version: number;
  pending: boolean;
  failed?: { value: Value };
  label: string;
  persist(value: Value): Promise<void>;
}

/** Keep save receipts and queues alive across modal dismissal and SPA navigation. */
export class BackgroundSaveRegistry {
  private receipts = new Map<string, BackgroundSave>();
  private queues = new Map<string, unknown>();
  private presentations = new Map<string, number>();
  private listeners = new Set<() => void>();
  private snapshot: BackgroundSave[] = [];

  /** A scope names one API mutation contract and must always use the same value type. */
  queue<Value>(scope: string): OptimisticSaveQueue<Value> {
    let queue = this.queues.get(scope) as OptimisticSaveQueue<Value> | undefined;
    if (!queue) { queue = new OptimisticSaveQueue<Value>(scope, this); this.queues.set(scope, queue); }
    return queue;
  }

  /** Subscribe without coupling background work to a particular view's lifetime. */
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }

  /** React requires a stable snapshot until a receipt changes. */
  getSnapshot() { return this.snapshot; }

  /** Avoid duplicate feedback when a native dialog presents this scope inside its own focus boundary. */
  present(scope: string) {
    this.presentations.set(scope, (this.presentations.get(scope) ?? 0) + 1);
    this.notify();
    return () => {
      const remaining = this.presentations.get(scope)! - 1;
      if (remaining) this.presentations.set(scope, remaining); else this.presentations.delete(scope);
      this.notify();
    };
  }

  /** The shell supplies feedback only when this scope has no visible inline presentation. */
  presented(scope: string) { return this.presentations.has(scope); }

  /** Replace only this entity's receipt; other saves and failures remain visible. */
  update(receipt: BackgroundSave) {
    this.receipts.set(receipt.id, receipt);
    this.notify();
  }

  /** Successful feedback expires; errors remain until a new attempt succeeds. */
  clearSaved(before: number) {
    for (const receipt of this.receipts.values()) {
      if (receipt.status === "saved" && receipt.savedAt! <= before) this.receipts.delete(receipt.id);
    }
    if (this.receipts.size === this.snapshot.length) return;
    this.notify();
  }

  /** Publish a stable snapshot for both receipt changes and presentation changes. */
  private notify() { this.snapshot = [...this.receipts.values()]; this.listeners.forEach((listener) => listener()); }
}

export const backgroundSaves = new BackgroundSaveRegistry();

/**
 * Apply keyed values immediately and serialize each entity's background writes.
 *
 * I.e. resolving thread A, then reopening it before the first request completes, shows A open
 * immediately but sends true before false. A failure of the older true request cannot undo false.
 */
export class OptimisticSaveQueue<Value> {
  private values = new Map<string, PendingValue<Value>>();
  private listeners = new Set<() => void>();
  version = 0;

  constructor(private scope: string, private registry: BackgroundSaveRegistry = backgroundSaves) {}

  /** Subscribe to optimistic values independently of global save receipts. */
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }

  /** Retain acknowledged overrides until the owner's server snapshot catches up. */
  value(key: string, fallback: Value): Value { const entry = this.values.get(key); return entry ? entry.value : fallback; }

  /** Pending permissions can allow reversing a change before refreshed metadata arrives. */
  pending(key: string): boolean { return this.values.get(key)?.pending ?? false; }

  /** A fresh view can trust its server snapshot; an in-flight view waits for acknowledgement to catch up. */
  reconcile(saved: ReadonlyMap<string, Value>, fresh = false) {
    let changed = false;
    for (const [key, entry] of this.values) {
      if (!entry.pending && !entry.failed && saved.has(key) && (fresh || Object.is(saved.get(key), entry.confirmed))) {
        this.values.delete(key);
        changed = true;
      }
    }
    if (changed) this.notify();
  }

  /** Record the latest intent before starting I/O; unrelated keys never share a write lock. */
  save(key: string, value: Value, confirmed: Value, persist: (value: Value) => Promise<void>, label: string) {
    const previous = this.values.get(key);
    if (previous ? !previous.failed && Object.is(previous.value, value) : Object.is(confirmed, value)) return;
    const entry = previous ?? { value: confirmed, confirmed, version: 0, pending: false, persist, label };
    const running = entry.pending;
    Object.assign(entry, { value, persist, label, failed: undefined, pending: true, version: entry.version + 1 });
    this.values.set(key, entry);
    this.publish(key, entry, "saving");
    if (!running) void this.flush(key, entry);
  }

  /**
   * Coalesce queued edits while preserving request order and the last server acknowledgement.
   *
   * Even after an older request fails, send a newer reversal: a network error does not prove
   * that the server rejected the old write. Only the latest failed intent rolls the UI back.
   */
  private async flush(key: string, entry: PendingValue<Value>) {
    while (entry.pending) {
      const version = entry.version;
      const value = entry.value;
      try {
        await entry.persist(value);
        entry.confirmed = value;
        if (version !== entry.version && !Object.is(value, entry.value)) continue;
        entry.pending = false;
        this.publish(key, entry, "saved");
      } catch (cause) {
        if (version !== entry.version) continue;
        entry.pending = false;
        entry.failed = { value };
        entry.value = entry.confirmed;
        this.publish(key, entry, "error", cause instanceof Error ? cause.message : String(cause));
      }
    }
  }

  /** Keep retries attached to the failed value, not the rolled-back value shown in the UI. */
  private publish(key: string, entry: PendingValue<Value>, status: BackgroundSave["status"], error?: string) {
    this.registry.update({
      id: `${this.scope}:${key}`, scope: this.scope, label: entry.label, status, error,
      savedAt: status === "saved" ? Date.now() : undefined,
      retry: () => { if (entry.failed) this.save(key, entry.failed.value, entry.confirmed, entry.persist, entry.label); },
    });
    this.notify();
  }

  /** Notify React only after both the optimistic value and its receipt are consistent. */
  private notify() { this.version++; this.listeners.forEach((listener) => listener()); }
}
