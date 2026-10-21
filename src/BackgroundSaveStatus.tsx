import { useEffect, useLayoutEffect, useSyncExternalStore } from "react";
import { backgroundSaves } from "./optimisticSave";

/**
 * Use the same quiet progress and persistent retry feedback in the shell and in native dialogs.
 *
 * Native dialogs own their scope's presentation while open; the shell resumes it after dismissal.
 */
export function BackgroundSaveStatus(props: { scope?: string }) {
  const receipts = useSyncExternalStore((listener) => backgroundSaves.subscribe(listener), () => backgroundSaves.getSnapshot());
  const visible = receipts.filter((receipt) => props.scope ? receipt.scope === props.scope : !backgroundSaves.presented(receipt.scope));
  const pending = visible.filter((receipt) => receipt.status === "saving");
  const failed = visible.filter((receipt) => receipt.status === "error");
  const savedAt = receipts.filter((receipt) => receipt.status === "saved").map((receipt) => receipt.savedAt!);
  const nextExpiry = savedAt.length ? Math.min(...savedAt) + 2500 : undefined;
  const unsaved = receipts.some((receipt) => receipt.status !== "saved");

  useLayoutEffect(() => { if (props.scope) return backgroundSaves.present(props.scope); }, [props.scope]);

  useEffect(() => {
    if (props.scope || !unsaved) return;
    /** SPA navigation is safe; a reload or tab close would discard queued work and retry receipts. */
    function warnBeforeLeaving(event: BeforeUnloadEvent) { event.preventDefault(); event.returnValue = ""; }
    window.addEventListener("beforeunload", warnBeforeLeaving);
    return () => window.removeEventListener("beforeunload", warnBeforeLeaving);
  }, [props.scope, unsaved]);

  useEffect(() => {
    if (nextExpiry === undefined) return;
    const timer = window.setTimeout(() => backgroundSaves.clearSaved(Date.now() - 2500), Math.max(0, nextExpiry - Date.now()));
    return () => window.clearTimeout(timer);
  }, [nextExpiry]);

  if (!visible.length) return null;
  return <div className="background-save-status" aria-label="Background saves">
    <span className="background-save-summary" role="status" title={pending.map((receipt) => receipt.label).join("\n")}>{pending.length ? `Saving ${pending.length} ${pending.length === 1 ? "change" : "changes"}…` : failed.length ? `${failed.length} ${failed.length === 1 ? "change" : "changes"} not saved` : "Saved"}</span>
    {failed.map((receipt) => <span className="background-save-error" role="alert" key={receipt.id}><span>{receipt.label}: {receipt.error}</span><button onMouseDown={(event) => event.preventDefault()} onClick={receipt.retry}>Retry</button></span>)}
  </div>;
}
