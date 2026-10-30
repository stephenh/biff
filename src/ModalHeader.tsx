import { createContext, type ReactNode } from "react";
import { closeShortcuts, ShortcutHelp, type Shortcut } from "./shortcuts";
import { ActivityIndicator } from "./ActivityIndicator";

// An embedded composer owns the save, but its outer dialog owns the X button.
export const ModalBusyContext = createContext<((busy: boolean) => void) | undefined>(undefined);

/** Shared dialog chrome; the owner retains its native focus, dismissal, and draft lifecycle. */
export function ModalHeader(props: {
  title: ReactNode; titleId?: string; closeLabel?: string; closeDisabled?: boolean;
  shortcuts?: Shortcut[]; actions?: ReactNode; onClose?(): void; popoverTarget?: string;
  activity?: boolean;
}) {
  return <div className="modal-header">
    <h2 id={props.titleId}>{props.title}</h2>
    <div className="modal-header-actions">
      {props.actions}
      {props.activity !== false && <ActivityIndicator />}
      <ShortcutHelp shortcuts={props.shortcuts ?? (props.closeDisabled ? [] : closeShortcuts)} />
      <button type="button" className="modal-close" aria-label={props.closeLabel ?? "Close"} disabled={props.closeDisabled} onClick={props.onClose} popoverTarget={props.popoverTarget} popoverTargetAction={props.popoverTarget ? "hide" : undefined}>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
      </button>
    </div>
  </div>;
}
