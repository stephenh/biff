import { useEffect, useState } from "react";
import type { DraftComment } from "../shared/types";

export interface ReviewDraft { commitId: string; body: string; comments: DraftComment[] }
export type ReviewDraftState = ReturnType<typeof useReviewDraft>;

/** Share one persisted review draft between the inline overlay and review summary. */
export function useReviewDraft(endpoint: string, commitId: string) {
  const key = `biff:review:${endpoint}`;
  const [draft, setDraft] = useState<ReviewDraft>(() => readDraft(key, commitId));
  const [storageError, setStorageError] = useState("");

  useEffect(() => {
    try { localStorage.setItem(key, JSON.stringify(draft)); setStorageError(""); }
    catch { setStorageError("Could not save your draft locally. Keep this tab open until submitting."); }
  }, [key, draft]);

  return { draft, setDraft, storageError };
}

/** Remove an acknowledged publication even when its original review page has unmounted. */
export function removePublishedReviewComment(endpoint: string, commitId: string, comment: DraftComment) {
  const key = `biff:review:${endpoint}`;
  const draft = readDraft(key, commitId);
  if (draft.commitId !== commitId) return;
  const comments = draft.comments.filter((entry) => entry.path !== comment.path || entry.line !== comment.line || entry.side !== comment.side || entry.body !== comment.body);
  if (comments.length === draft.comments.length) return;
  localStorage.setItem(key, JSON.stringify({ ...draft, comments }));
}

/** A damaged or missing browser draft should not prevent opening the PR. */
function readDraft(key: string, commitId: string): ReviewDraft {
  try {
    const value = JSON.parse(localStorage.getItem(key) || "null") as ReviewDraft | null;
    if (value && typeof value.body === "string" && typeof value.commitId === "string" && Array.isArray(value.comments)) {
      // An empty draft has no anchors to preserve when the PR advances.
      return !value.body.trim() && value.comments.length === 0 ? { ...value, commitId } : value;
    }
  } catch { /* Start a new draft when storage is unavailable. */ }
  return { commitId, body: "", comments: [] };
}
