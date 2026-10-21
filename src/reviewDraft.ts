import { useEffect, useMemo, useState } from "react";
import type { DraftComment } from "../shared/types";

export interface ReviewDraft { commitId: string; body: string; comments: DraftComment[] }
export type ReviewDraftState = ReturnType<typeof useReviewDraft>;

/** Share a persisted draft for this PR head without letting older drafts block new comments. */
export function useReviewDraft(endpoint: string, commitId: string) {
  const key = draftKey(endpoint, commitId);
  const [draft, setDraft] = useState<ReviewDraft>(() => readDraft(endpoint, commitId));
  const olderDrafts = useMemo(() => readOlderDrafts(endpoint, commitId), [endpoint, commitId]);
  const [storageError, setStorageError] = useState("");

  useEffect(() => {
    if (draft.commitId !== commitId) return;
    try { localStorage.setItem(key, JSON.stringify(draft)); setStorageError(""); }
    catch { setStorageError("Could not save your draft locally. Keep this tab open until submitting."); }
  }, [key, draft, commitId]);

  return { draft, setDraft, olderDrafts, storageError };
}

/** Remove an acknowledged publication even when its original review page has unmounted. */
export function removePublishedReviewComment(endpoint: string, commitId: string, comment: DraftComment) {
  const key = draftKey(endpoint, commitId);
  const draft = readDraft(endpoint, commitId);
  const comments = draft.comments.filter((entry) => entry.path !== comment.path || entry.line !== comment.line || entry.side !== comment.side || entry.body !== comment.body);
  if (comments.length === draft.comments.length) return;
  localStorage.setItem(key, JSON.stringify({ ...draft, comments }));
}

/** Reuse legacy notes only on their original head; never silently re-anchor old line comments. */
function readDraft(endpoint: string, commitId: string): ReviewDraft {
  const saved = readStoredDraft(draftKey(endpoint, commitId)) ?? readStoredDraft(`biff:review:${endpoint}`);
  return saved?.commitId === commitId ? saved : { commitId, body: "", comments: [] };
}

/** Retain previous heads and legacy drafts as read-only recovery, including their original coordinates. */
function readOlderDrafts(endpoint: string, commitId: string): ReviewDraft[] {
  const prefix = `biff:review:${endpoint}`;
  const drafts = new Map<string, ReviewDraft>();
  const legacy = readStoredDraft(prefix);
  if (legacy) drafts.set(legacy.commitId, legacy);

  try {
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (!key?.startsWith(`${prefix}:`)) continue;
      const saved = readStoredDraft(key);
      if (saved && key === draftKey(endpoint, saved.commitId)) drafts.set(saved.commitId, saved);
    }
  } catch { /* A storage failure must not block comments on the current head. */ }

  // An empty per-head record means that review was submitted or cleared. It
  // overrides a legacy copy so already-published notes do not reappear as drafts.
  return [...drafts.values()].filter((draft) => draft.commitId !== commitId && (draft.body.trim() || draft.comments.length));
}

/** A damaged or missing browser draft should not prevent opening the PR. */
function readStoredDraft(key: string): ReviewDraft | undefined {
  try {
    const value = JSON.parse(localStorage.getItem(key) || "null") as ReviewDraft | null;
    if (value && typeof value.body === "string" && typeof value.commitId === "string" && Array.isArray(value.comments)) {
      return value;
    }
  } catch { /* Start a new draft when storage is unavailable. */ }
}

/** Scope mutable review text to its exact GitHub head, leaving earlier heads untouched. */
function draftKey(endpoint: string, commitId: string): string { return `biff:review:${endpoint}:${commitId}`; }
