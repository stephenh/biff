import { useRef, useSyncExternalStore } from "react";
import { backgroundSaves } from "./optimisticSave";

/**
 * Keep receipts for existing foreground writes after their owner closes.
 *
 * This only reports the existing operation: optimistic queues and append submissions
 * still own their persistence. Setters remain usable by requests finishing after unmount.
 */
export function useSaveFeedback(scope: string, label: string, retry: () => void) {
  const current = useRef({ label, retry });
  current.current = { label, retry };
  const receipts = useSyncExternalStore((listener) => backgroundSaves.subscribe(listener), () => backgroundSaves.getSnapshot());
  const id = `foreground:${scope}`;
  const receipt = receipts.find((entry) => entry.id === id);

  /** Preserve failures until the existing action acknowledges a successful retry. */
  function setBusy(busy: boolean) {
    const previous = backgroundSaves.getSnapshot().find((entry) => entry.id === id);
    if (!busy && previous?.status === "error") return;
    backgroundSaves.update({ id, scope, label: current.current.label, status: busy ? "saving" : "saved", savedAt: busy ? undefined : Date.now(), retry: () => current.current.retry() });
  }

  /** Validation can fail before a request starts, so it also needs a durable receipt. */
  function setError(error: string) {
    if (!error) return;
    backgroundSaves.update({ id, scope, label: current.current.label, status: "error", error, retry: () => current.current.retry() });
  }

  return { busy: receipt?.status === "saving", error: receipt?.error ?? "", setBusy, setError };
}
