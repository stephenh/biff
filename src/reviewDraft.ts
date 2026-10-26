import { useEffect, useMemo, useSyncExternalStore, type SetStateAction } from "react";
import type { DraftComment, ReviewDraft } from "../shared/types";
import { post, request } from "./api";
import { useOptimisticSave } from "./useOptimisticSave";

export type { ReviewDraft } from "../shared/types";
export type ReviewDraftState = ReturnType<typeof useReviewDraft>;
interface Snapshot { draft: ReviewDraft; confirmed: ReviewDraft; olderDrafts: ReviewDraft[]; storageError: string; loaded: boolean; dirty: boolean }
interface DraftStore { snapshot: Snapshot; listeners: Set<() => void>; loading?: Promise<void>; serverVersion: number; comparison?: string }
const stores = new Map<string, DraftStore>();

/**
 * Share one durable PR draft across the inbox, diff viewer, modal dismissal, and head changes.
 *
 * Browser text survives failed writes. The shared queue owns background retries, while server versions reject stale tabs.
 */
export function useReviewDraft(endpoint: string, commitId: string, baseCommitId?: string) {
  const store = getStore(endpoint, commitId);
  const snapshot = useSyncExternalStore((listener) => { store.listeners.add(listener); return () => { store.listeners.delete(listener); }; }, () => store.snapshot);
  const saved = useMemo(() => new Map([["draft", snapshot.confirmed]]), [snapshot.confirmed]);
  const scope = `review-draft:${endpoint}`;
  const queue = useOptimisticSave<ReviewDraft>(scope, saved);
  const draft = useMemo(() => ({ ...snapshot.draft, commitId, comments: snapshot.draft.comments.map((comment) => ({ ...comment,
    needsReanchoring: Boolean(comment.needsReanchoring || comment.commitId && comment.commitId !== commitId || comment.baseCommitId && baseCommitId && comment.baseCommitId !== baseCommitId),
  })) }), [snapshot.draft, commitId, baseCommitId]);

  useEffect(() => {
    void loadDraft(endpoint, store, commitId, baseCommitId).then(() => {
      if (store.snapshot.loaded && store.snapshot.dirty) save(store.snapshot.draft);
    });
  }, [endpoint, commitId, baseCommitId]);

  useEffect(() => {
    /** A sync or another tab can move attachments without changing this view's mounted draft hook. */
    function refreshSavedDraft() {
      if (!store.snapshot.dirty && !queue.pending("draft")) void loadDraft(endpoint, store, commitId, baseCommitId, true);
    }
    const events = new EventSource(`${endpoint}/discussion?events=1`);
    events.onmessage = refreshSavedDraft;
    window.addEventListener("focus", refreshSavedDraft);
    return () => { events.close(); window.removeEventListener("focus", refreshSavedDraft); };
  }, [endpoint, commitId, baseCommitId, queue]);

  /** Keep the text immediately and persist in the background; failed saves never erase a draft. */
  function setDraft(update: SetStateAction<ReviewDraft>) {
    const current = { ...store.snapshot.draft, commitId };
    const next = typeof update === "function" ? update(current) : update;
    next.comments = next.comments.map((comment) => ({ ...comment, id: comment.id ?? crypto.randomUUID(), commitId: comment.commitId ?? commitId, baseCommitId: comment.baseCommitId ?? (comment.commitId && comment.commitId !== commitId ? undefined : baseCommitId) }));
    store.snapshot = { ...store.snapshot, draft: next, dirty: true };
    persistBrowser(endpoint, store);
    notify(store);
    if (store.snapshot.loaded) save(next);
  }

  /** Serialize edits to this PR draft and use the last acknowledged version for conflict checks. */
  function save(value: ReviewDraft) {
    queue.save("draft", value, store.snapshot.confirmed, async (value) => {
      const result = await post<ReviewDraft>(`${endpoint}/review-draft`, { ...value, version: store.serverVersion });
      const unchanged = sameDraftIntent(store.snapshot.draft, value);
      store.serverVersion = Math.max(store.serverVersion, result.version ?? 0);
      store.snapshot = { ...store.snapshot, confirmed: result,
        draft: unchanged ? result : mergeAttachments(store.snapshot.draft, result), dirty: !unchanged };
      persistBrowser(endpoint, store);
      notify(store);
    }, `Review draft ${endpoint.replace("/api/github/pr/", "")}`);
  }

  /** Publication must wait for durable draft admission, not for unrelated background saves. */
  async function flush(): Promise<void> {
    await loadDraft(endpoint, store, commitId, baseCommitId);
    if (!store.snapshot.loaded) throw new Error("Your review draft has not reached Biff yet. Retry loading it before publishing; your browser copy is kept.");
    if (store.snapshot.dirty) save(store.snapshot.draft);
    await queue.settled("draft");
  }

  /** Preserve conflicting browser text as recovery before accepting another tab's saved draft. */
  async function reload(): Promise<void> {
    if (queue.pending("draft")) return;
    const recovery = store.snapshot.draft;
    if (recovery.body.trim() || recovery.comments.length) {
      store.snapshot = { ...store.snapshot, olderDrafts: [...store.snapshot.olderDrafts, recovery] };
      try { localStorage.setItem(`biff:review-recovery:${endpoint}:${crypto.randomUUID()}`, JSON.stringify(recovery)); } catch { /* The in-memory recovery remains visible. */ }
    }
    store.snapshot = { ...store.snapshot, dirty: false, loaded: false };
    await loadDraft(endpoint, store, commitId, baseCommitId, true);
    if (store.snapshot.loaded) save(store.snapshot.draft);
  }

  /** Remove only the immutable submission; typing done during its request remains in the draft. */
  function acknowledge(sent: ReviewDraft, confirmed?: ReviewDraft) {
    const current = store.snapshot.draft;
    const before = store.snapshot.confirmed;
    const comments = current.comments.filter((comment) => !sent.comments.some((entry) => (sameComment(entry, comment) || comment.supersedes === entry.id && comment.body === entry.body && samePublicationAnchor(comment, entry)) && (!comment.reanchor || entry.path === comment.path && entry.side === comment.side && entry.line === comment.line))).map((comment) => {
      if (!sent.comments.some((entry) => entry.id === comment.id)) return comment;
      const fork = confirmed?.comments.find((entry) => entry.supersedes === comment.id && entry.body === comment.body);
      return fork ? { ...fork, body: comment.body } : { ...comment, id: crypto.randomUUID() };
    });
    const next = { ...current, body: current.body === sent.body ? confirmed?.body ?? "" : current.body, comments };
    // Only our publication may advance the write base automatically. Other-tab
    // changes still need the ordinary conflict/recovery flow, not a blanket overwrite.
    if (confirmed && (sameDraftIntent(next, confirmed) || publicationResultMatches(before, sent, confirmed))) store.serverVersion = Math.max(store.serverVersion, confirmed.version ?? 0);
    next.version = store.serverVersion;
    store.snapshot = { ...store.snapshot, draft: next, confirmed: confirmed ?? next, dirty: confirmed ? !sameDraftIntent(next, confirmed) : false };
    persistBrowser(endpoint, store);
    notify(store);
    if (store.snapshot.dirty) save(next);
  }

  return { draft, setDraft, olderDrafts: snapshot.olderDrafts, storageError: snapshot.storageError, loaded: snapshot.loaded, scope, flush, reload, acknowledge };
}

/** Initialize without writing an empty record over another mounted view's saved text. */
function getStore(endpoint: string, commitId: string): DraftStore {
  let store = stores.get(endpoint);
  if (store) return store;
  const legacy = readStoredDraft(`biff:review:${endpoint}:${commitId}`) ?? readStoredDraft(`biff:review:${endpoint}`);
  const draft = readStoredDraft(`biff:review-current:${endpoint}`) ?? (legacy?.commitId === commitId ? legacy : undefined) ?? { commitId, body: "", comments: [] };
  const dirty = Boolean((draft as ReviewDraft & { browserPending?: boolean }).browserPending);
  store = { snapshot: { draft, confirmed: { commitId, version: 0, body: "", comments: [] }, olderDrafts: readOlderDrafts(endpoint, commitId), storageError: "", loaded: false, dirty }, listeners: new Set(), serverVersion: draft.version ?? 0 };
  stores.set(endpoint, store);
  return store;
}

/**
 * Migrate browser-only comments additively, with stable IDs so retries cannot resurrect submitted notes.
 *
 * Server-backed pending copies retain their original edit version; loading another tab's version is not permission to overwrite it.
 */
async function loadDraft(endpoint: string, store: DraftStore, head: string, base?: string, force = false): Promise<void> {
  if (store.loading) return store.loading;
  if (store.snapshot.loaded && store.comparison === `${head}:${base}` && !force) return;
  const task = (async () => {
    try {
      let remote = await request<ReviewDraft>(`${endpoint}/review-draft`);
      const legacy = [store.snapshot.draft, ...store.snapshot.olderDrafts];
      for (const source of legacy) {
        if (source.version !== undefined) continue;
        const comments = await Promise.all(source.comments.map(async (comment, index) => ({ ...comment, id: comment.id ?? await legacyCommentId(endpoint, source.commitId, comment, index), commitId: comment.commitId ?? source.commitId,
          baseCommitId: comment.baseCommitId ?? (source.commitId === head ? base : undefined) })));
        const body = source.commitId === head ? source.body : "";
        if (comments.length || body.trim()) remote = await post<ReviewDraft>(`${endpoint}/review-draft`, { ...source, comments, body, version: remote.version ?? 0, importing: true });
      }
      const dirty = store.snapshot.dirty && !sameDraftIntent(store.snapshot.draft, remote);
      if (!dirty || store.snapshot.draft.version === undefined) store.serverVersion = remote.version ?? 0;
      store.snapshot = { ...store.snapshot, draft: dirty ? mergeAttachments(store.snapshot.draft, remote) : remote, confirmed: remote, loaded: true, dirty, storageError: "" };
      store.comparison = `${head}:${base}`;
      persistBrowser(endpoint, store);
    } catch (cause) {
      store.snapshot = { ...store.snapshot, storageError: `Could not load or save the review draft: ${cause instanceof Error ? cause.message : String(cause)}. Your browser copy is kept.` };
    }
    notify(store);
  })();
  store.loading = task;
  void task.finally(() => { if (store.loading === task) store.loading = undefined; });
  return task;
}

/** Keep newer text while accepting server-computed locations for existing comments. */
function mergeAttachments(current: ReviewDraft, saved: ReviewDraft): ReviewDraft {
  return { ...current, version: Math.max(current.version ?? 0, saved.version ?? 0), currentHead: saved.currentHead, currentBase: saved.currentBase, comments: current.comments.map((comment) => {
    const match = saved.comments.find((entry) => entry.id === comment.id);
    return match && !comment.reanchor ? { ...match, body: comment.body } : comment;
  }) };
}

/** Synchronous browser persistence closes the gap between clicking Save and starting the server request. */
function persistBrowser(endpoint: string, store: DraftStore) {
  try { localStorage.setItem(`biff:review-current:${endpoint}`, JSON.stringify({ ...store.snapshot.draft, browserPending: store.snapshot.dirty })); store.snapshot = { ...store.snapshot, storageError: "" }; }
  catch { store.snapshot = { ...store.snapshot, storageError: "Could not save your browser copy. Keep this tab open until the server save succeeds." }; }
}

/** Retain old summaries and original coordinates as recovery, even when their hunk no longer matches. */
function readOlderDrafts(endpoint: string, commitId: string): ReviewDraft[] {
  const prefix = `biff:review:${endpoint}`;
  const drafts = new Map<string, ReviewDraft>();
  const legacy = readStoredDraft(prefix);
  if (legacy) drafts.set(legacy.commitId, legacy);
  try {
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (!key?.startsWith(`${prefix}:`) && !key?.startsWith(`biff:review-recovery:${endpoint}:`)) continue;
      const saved = readStoredDraft(key);
      if (saved) drafts.set(key.startsWith(`biff:review-recovery:`) ? key : saved.commitId, saved);
    }
  } catch { /* Recovery must not prevent opening the current review. */ }
  return [...drafts.entries()].filter((entry) => (entry[1].commitId !== commitId || entry[0].startsWith("biff:review-recovery:")) && (entry[1].body.trim() || entry[1].comments.length)).map((entry) => entry[1]);
}

/** Corrupt browser data never replaces a durable server draft. */
function readStoredDraft(key: string): ReviewDraft | undefined {
  try {
    const value = JSON.parse(localStorage.getItem(key) || "null") as ReviewDraft | null;
    if (value && typeof value.body === "string" && typeof value.commitId === "string" && Array.isArray(value.comments)) return value;
  } catch { /* Keep server recovery available when browser storage is unreadable. */ }
}

/** A deterministic import ID makes repeat migration safe across reloads, tabs, and server restarts. */
async function legacyCommentId(endpoint: string, commitId: string, comment: DraftComment, index: number): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([endpoint.toLowerCase(), commitId, index, comment.path, comment.side, comment.line, comment.body])));
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Acknowledgement matches text as well as identity so a newer edit is never cleared. */
function sameComment(left: DraftComment, right: DraftComment): boolean {
  return left.body === right.body && (left.id && right.id ? left.id === right.id : left.path === right.path && left.line === right.line && left.side === right.side);
}

/** A fork explicitly moved to another hunk must not be consumed because its words match an older submission. */
function samePublicationAnchor(left: DraftComment, right: DraftComment): boolean {
  if (left.anchor && right.anchor) return left.side === right.side && left.anchor.change.path === right.anchor.change.path && left.anchor.change.hash === right.anchor.change.hash && left.anchor.offset === right.anchor.offset;
  return left.path === right.path && left.side === right.side && left.line === right.line;
}

/** Server attachment updates may change coordinates, but never acknowledge a newer text edit or removal. */
function sameDraftIntent(left: ReviewDraft, right: ReviewDraft): boolean {
  return left.body === right.body && left.comments.length === right.comments.length && left.comments.every((comment, index) => {
    const other = right.comments[index];
    return sameComment(comment, other) && (!(comment.reanchor || other.reanchor) || comment.path === other.path && comment.side === other.side && comment.line === other.line);
  });
}

/** Distinguish our own acknowledgement from unrelated edits returned in the same server snapshot. */
function publicationResultMatches(before: ReviewDraft, sent: ReviewDraft, after: ReviewDraft): boolean {
  const body = before.body === sent.body ? "" : before.body;
  if (body !== after.body) return false;
  const remaining = before.comments.filter((comment) => !sent.comments.some((entry) => sameComment(entry, comment)));
  if (remaining.length !== after.comments.length) return false;
  return after.comments.every((comment) => {
    const prior = remaining.find((entry) => entry.id === comment.id || entry.id === comment.supersedes);
    return prior?.body === comment.body;
  });
}

/** Every mounted view observes the same mutation before any network request completes. */
function notify(store: DraftStore) { store.listeners.forEach((listener) => listener()); }
