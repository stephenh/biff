import { useLayoutEffect, useRef, useState } from "react";
import type { ReviewLine } from "../shared/types";
import { reviewFileRoute } from "./fileRoute";
import { useStableCallback } from "./useStableCallback";

export interface ReviewNavigationTarget {
  path: string;
  line?: ReviewLine;
}

interface NavigationOptions {
  base?: string;
  search: string;
  files: readonly { name: string }[];
  routeNames: readonly string[];
  onNavigate: (target: ReviewNavigationTarget) => void;
}

// The browser owns the timeline. Only its entries' latest reading coordinates live here.
const positions = new Map<string, { scope: string; target: ReviewNavigationTarget }>();
const stateKey = "biffNavigationId";

/**
 * Checkpoint intentional jumps while keeping ordinary reading out of browser history.
 *
 * Entry IDs survive SPA unmounts, but coordinates deliberately do not survive reloads.
 * The URL remains a shareable jump anchor, not a live cursor display.
 */
export function useReviewNavigation(options: NavigationOptions) {
  const scope = `${options.base ?? ""}${options.search}`;
  const [initialTarget] = useState(() => readTarget(options, scope));
  const entryId = useRef(readEntryId());
  const writing = useRef(false);
  const lastLocation = useRef(locationKey());

  const locationChanged = useStableCallback(() => {
    if (writing.current) return;
    const next = locationKey();
    // A hash traversal emits both events. Restoring twice can race the first
    // restore's row remap while expanded context is being collapsed.
    if (lastLocation.current === next) return;
    lastLocation.current = next;
    if (!inScope(options)) return;
    entryId.current = readEntryId();
    const target = readTarget(options, scope);
    if (target) options.onNavigate(target);
  });

  useLayoutEffect(() => {
    if (!inScope(options)) return;
    ensureEntry();
    // Wouter publishes its push/replace calls as events; native traversal also
    // needs popstate even when only the hash or entry ID changed.
    const events = ["popstate", "pushState", "replaceState", "hashchange"];
    for (const event of events) window.addEventListener(event, locationChanged);
    return () => { for (const event of events) window.removeEventListener(event, locationChanged); };
  }, [scope, locationChanged]);

  /** Keep the last rendered source coordinate without touching the URL or Forward. */
  function remember(target: ReviewNavigationTarget) {
    if (!inScope(options) || entryId.current !== readEntryId() || !entryId.current) return;
    positions.set(entryId.current, { scope, target });
  }

  /** Replace the exact origin, then add just one destination to native history. */
  function jump(target: ReviewNavigationTarget, origin: ReviewNavigationTarget) {
    if (!inScope(options)) return;
    ensureEntry();
    remember(origin);
    write(origin, true);
    entryId.current = crypto.randomUUID();
    positions.set(entryId.current, { scope, target });
    write(target, false);
  }

  /** Incidental cross-file reading updates the file URL, never the history length. */
  function syncFile(path: string) {
    if (!inScope(options)) return;
    const route = reviewFileRoute(window.location.pathname);
    const fileIndex = options.files.findIndex((file) => file.name === path);
    if (fileIndex < 0 || route?.file === options.routeNames[fileIndex]) return;
    ensureEntry();
    write({ path }, true);
  }

  /** Adopt an unowned browser entry without replacing other features' history state. */
  function ensureEntry() {
    entryId.current = readEntryId() ?? crypto.randomUUID();
    if (readEntryId()) return;
    writing.current = true;
    try {
      window.history.replaceState({ ...window.history.state, [stateKey]: entryId.current }, "");
    } finally { lastLocation.current = locationKey(); writing.current = false; }
  }

  /** Own writes move the viewer directly; their URL events must not restore it twice. */
  function write(target: ReviewNavigationTarget, replace: boolean) {
    const fileIndex = options.files.findIndex((file) => file.name === target.path);
    if (fileIndex < 0) return;
    const anchor = target.line ? `#${target.line.side === "LEFT" ? "L" : "R"}${target.line.line}` : "";
    const url = `${options.base}/f/${encodeURIComponent(options.routeNames[fileIndex])}${options.search}${anchor}`;
    writing.current = true;
    try {
      const state = replace ? window.history.state : null;
      window.history[replace ? "replaceState" : "pushState"]({ ...state, [stateKey]: entryId.current }, "", url);
    } finally { lastLocation.current = locationKey(); writing.current = false; }
  }

  return { initialTarget, remember, jump, syncFile };
}

/** Limit an old, still-mounted viewer to its own review and comparison. */
function inScope(options: NavigationOptions): boolean {
  return Boolean(options.base) && reviewFileRoute(window.location.pathname)?.base === options.base
    && window.location.search === options.search;
}

/** Ignore foreign or malformed history state. */
function readEntryId(): string | undefined {
  const state: unknown = window.history.state;
  if (state && typeof state === "object" && stateKey in state && typeof state[stateKey] === "string") return state[stateKey];
}

/** Same-URL entries are distinct, but popstate and hashchange can describe the same entry. */
function locationKey(): string {
  return JSON.stringify([window.location.href, readEntryId()]);
}

/** Memory wins on traversal; a new tab or reload uses the explicit URL coordinate. */
function readTarget(options: NavigationOptions, scope: string): ReviewNavigationTarget | undefined {
  if (!inScope(options)) return;
  const id = readEntryId();
  const saved = id ? positions.get(id) : undefined;
  if (saved?.scope === scope) return saved.target;
  const route = reviewFileRoute(window.location.pathname);
  const fileIndex = options.routeNames.indexOf(route?.file ?? "");
  const path = options.files[fileIndex]?.name;
  if (!path) return;
  const match = /^#([LR])([1-9]\d*)$/.exec(window.location.hash);
  if (!match) return { path };
  const line = Number(match[2]);
  if (!Number.isSafeInteger(line)) return { path };
  return { path, line: { path, line, side: match[1] === "L" ? "LEFT" : "RIGHT" } };
}
