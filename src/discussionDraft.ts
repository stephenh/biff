import { useSyncExternalStore } from "react";

interface Entry { body: string }
interface DiscussionDraft { bodies: Record<string, Entry>; error?: string }
const drafts = new Map<string, DiscussionDraft>();
const listeners = new Set<() => void>();

/** Retain per-thread reply drafts across modal dismissal, navigation, and background publication. */
export function useDiscussionDraft(endpoint: string, key: string) {
  const draft = useSyncExternalStore(subscribe, () => readDraft(endpoint));
  const entry = draft.bodies[key];

  /** Keep an in-memory copy even when the browser cannot persist storage. */
  function setComment(body: string) {
    const current = readDraft(endpoint);
    saveDraft(endpoint, { ...current, bodies: { ...current.bodies, [key]: { body } } });
  }

  /** A delayed acknowledgement can remove only the exact draft that was submitted. */
  function acknowledge() {
    const current = readDraft(endpoint);
    if (current.bodies[key] !== entry) return;
    const bodies = { ...current.bodies };
    delete bodies[key];
    saveDraft(endpoint, { ...current, bodies });
  }

  return { comment: entry?.body ?? "", error: draft.error, setComment, acknowledge };
}

/** Subscribe independently of any one modal's lifetime. */
function subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }

/** Restore a stored draft once; subsequent consumers share its immutable snapshot. */
function readDraft(endpoint: string): DiscussionDraft {
  const existing = drafts.get(endpoint);
  if (existing) return existing;
  let draft: DiscussionDraft = { bodies: {} };
  try {
    const saved = JSON.parse(localStorage.getItem(`biff:discussion:${endpoint}`) ?? "null") as DiscussionDraft | null;
    if (saved?.bodies && Object.values(saved.bodies).every((entry) => entry && typeof entry.body === "string")) draft = saved;
  } catch { /* Invalid stored drafts must not prevent reading discussion. */ }
  drafts.set(endpoint, draft);
  return draft;
}

/** Publish local state before notifying mounted readers. */
function saveDraft(endpoint: string, draft: DiscussionDraft) {
  try { localStorage.setItem(`biff:discussion:${endpoint}`, JSON.stringify(draft)); draft = { ...draft, error: undefined }; }
  catch { draft = { ...draft, error: "Draft retained in this tab, but browser storage failed. Avoid reloading before publishing." }; }
  drafts.set(endpoint, draft);
  listeners.forEach((listener) => listener());
}
