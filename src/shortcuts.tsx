import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";

export interface Shortcut {
  keys: string;
  description: string;
  aliases?: string[];
}
const registrations = new Map<symbol, Shortcut[]>();
const listeners = new Set<() => void>();
let snapshot: Shortcut[] = [];

/** Register page hints and their listener together so unmounting removes both. */
export function registerShortcuts(shortcuts: Shortcut[], handler: (event: KeyboardEvent) => void, capture = false) {
  const id = Symbol();
  registrations.set(id, shortcuts);
  publish();
  window.addEventListener("keydown", handler, capture);
  return () => {
    window.removeEventListener("keydown", handler, capture);
    registrations.delete(id);
    publish();
  };
}

/** Match keys and aliases only where their focus policy leaves native editing intact. */
export function matchesShortcut(event: KeyboardEvent, shortcuts: Shortcut[]): boolean {
  const key = `${event.ctrlKey || event.metaKey ? "Mod+" : ""}${event.altKey ? "Alt+" : ""}${event.key}`;
  if (isTyping(event)) return false;
  // Checkbox activation and native range/radio navigation must not become review actions.
  if (event.composedPath().some((target) => target instanceof HTMLInputElement
    && (event.key === " " || (event.key.startsWith("Arrow") && ["range", "radio"].includes(target.type))))) return false;
  return shortcuts.some((shortcut) => [shortcut.keys, ...shortcut.aliases ?? []].includes(key));
}

/** Protect typing and select type-ahead, including editors inside shadow roots. */
export function isTyping(event: KeyboardEvent): boolean {
  return event.composedPath().some((target) => target instanceof HTMLElement && (
    target.isContentEditable || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement
    || (target instanceof HTMLInputElement && !["button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"].includes(target.type))
    || Boolean(target.closest('[role="textbox"], [role="searchbox"], [role="combobox"]'))
  ));
}

/** Show mounted page registrations rather than a second hard-coded help list. */
export function PageShortcuts() {
  const shortcuts = useSyncExternalStore(subscribe, getSnapshot);
  return <div className="page-shortcuts"><ShortcutHelp shortcuts={shortcuts} page /></div>;
}

/** Share the collapsed help control while keeping keyboard ownership with its page or dialog. */
export function ShortcutHelp(props: { shortcuts: Shortcut[]; page?: boolean }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const scope = container.current?.closest<HTMLElement>('dialog, [role="dialog"], [data-modal-scope]');
    /** Question marks in text fields belong to the draft, not the navigation. */
    function toggle(event: KeyboardEvent) {
      if (event.key !== "?" || event.defaultPrevented || event.repeat || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
      if (isTyping(event)) return;
      const overlays = Array.from(document.querySelectorAll<HTMLElement>('dialog[open], [role="dialog"]:not([popover]), [popover]:popover-open'));
      const focusedScope = event.target instanceof Element ? event.target.closest('dialog, [role="dialog"], [data-modal-scope]') : null;
      // A header's activity popover can live inside a native modal. Its help owns
      // question marks while focused, rather than toggling the underlying dialog.
      const modal = document.querySelector('dialog:modal');
      const popover = overlays.filter((element) => element.matches('[popover]:popover-open') && (!modal || modal.contains(element))).at(-1);
      const active = popover ?? modal ?? focusedScope ?? overlays.at(-1);
      if (props.page ? Boolean(active) : !scope || scope !== active || !scope.getClientRects().length) return;
      event.preventDefault();
      setOpen((value) => !value);
    }
    /** Popovers stay mounted between openings, unlike most dialogs. */
    function reset() { setOpen(false); }
    window.addEventListener("keydown", toggle);
    scope?.addEventListener("beforetoggle", reset);
    return () => {
      window.removeEventListener("keydown", toggle);
      scope?.removeEventListener("beforetoggle", reset);
    };
  }, [props.page]);

  return <div className="shortcut-help" ref={container}>
    <div id={id} hidden={!open}><ShortcutStrip shortcuts={props.shortcuts} /></div>
    <button type="button" className="shortcuts-toggle" aria-label="Keyboard shortcuts" aria-expanded={open} aria-controls={id} title="Toggle keyboard shortcuts (?)" onClick={() => setOpen((value) => !value)}>?</button>
  </div>;
}

/** Focusable key labels reveal descriptions on hover, focus, or touch. */
export function ShortcutStrip(props: { shortcuts: Shortcut[] }) {
  const id = useId();
  const [position, setPosition] = useState({ left: 12, top: 0 });
  /** Fixed positioning keeps hints out of scroll clipping inside dialogs. */
  function positionHint(element: HTMLElement) {
    const bounds = element.getBoundingClientRect();
    setPosition({ left: Math.max(12, Math.min(bounds.left, window.innerWidth - 352)), top: bounds.bottom });
  }
  const groups = new Map<string, Shortcut[]>();
  for (const shortcut of props.shortcuts) {
    const key = shortcut.keys.startsWith("g ") ? "g" : shortcut.keys;
    groups.set(key, [...groups.get(key) ?? [], shortcut]);
  }
  return <div className="shortcut-strip" aria-label="Available keyboard shortcuts">
    {[...groups].map(([key, shortcuts], index) => <span className="shortcut-hint" key={key} onMouseEnter={(event) => positionHint(event.currentTarget)} onFocus={(event) => positionHint(event.currentTarget)}>
      <button type="button" className="shortcut-key" aria-label={`${displayKey(key)} shortcut`} aria-describedby={`${id}-${index}`}><kbd>{displayKey(key)}</kbd></button>
      <span className="shortcut-tooltip" style={position} role="tooltip" id={`${id}-${index}`}>{shortcuts.map((shortcut) => <span key={shortcut.keys}><kbd>{displayKey(shortcut.keys)}</kbd><span>{shortcut.description}{shortcut.aliases?.length ? ` (also ${shortcut.aliases.map(displayKey).join(", ")})` : ""}</span></span>)}</span>
    </span>)}
  </div>;
}

export const closeShortcuts: Shortcut[] = [{ keys: "Escape", description: "Close" }];

/** Notify hint consumers; page components do not subscribe to their own registrations. */
function publish() {
  snapshot = [...registrations.values()].flat();
  listeners.forEach((listener) => listener());
}
/** Subscribe to mounted page registrations. */
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
/** Keep snapshots stable between registrations. */
function getSnapshot() { return snapshot; }
/** Keep key caps short without losing case or modifier information. */
function displayKey(key: string): string {
  // Use the browser's platform, not the server's: a Mac can connect to a Linux-hosted Biff.
  const modifier = /Mac|iPhone|iPad|iPod/i.test(navigator.platform) ? "⌘" : "⌃";
  return key === " " ? "Space" : key.replace("Escape", "Esc").replace("ArrowDown", "↓").replace("ArrowUp", "↑").replace("ArrowLeft", "←").replace("ArrowRight", "→").replace("Mod+", modifier);
}
