import { useMemo } from "react";
import type { PullRequestStatus } from "../shared/types";
import { useOptimisticSave } from "./useOptimisticSave";
import { post } from "./api";

export const reviewChangesScope = "review-changes";

/** Share explicit acknowledgment across headers, dialogs, and inbox rows without treating browsing as review. */
export function useReviewChanges(endpoint: string, status?: PullRequestStatus) {
  const key = reviewChangesKey(endpoint);
  const saved = useMemo(() => new Map([[key, reviewChangesValue(status)]]), [key, status?.viewerNewChanges, status?.newChangesVersion]);
  const saves = useOptimisticSave(reviewChangesScope, saved);
  const current = status ? { ...status, viewerNewChanges: Boolean(status.viewerNewChanges && saves.value(key, reviewChangesValue(status)) < (status.newChangesVersion ?? 0)) } : undefined;

  /** Keep the displayed head and version pinned while the request runs in the background. */
  function markReviewed(head: string, onSaved?: () => void) {
    if (!status?.viewerNewChanges || status.newChangesVersion === undefined) return;
    const version = status.newChangesVersion;
    saves.save(key, version, reviewChangesValue(status), async () => {
      await post(`${endpoint}/review-changes`, { head, version });
      // Refresh failures cannot undo the acknowledged write.
      onSaved?.();
    }, `Mark changes reviewed · ${endpoint.replace("/api/github/pr/", "")}`);
  }

  return { status: current, markReviewed };
}

/** Serialize acknowledgments per PR, including an acknowledgment of newer changes during an older save. */
export function reviewChangesKey(endpoint: string): string { return endpoint.toLowerCase(); }

/** An optimistic acknowledgment covers its version, never a newer comparison. */
export function reviewChangesValue(status?: PullRequestStatus): number {
  const version = status?.newChangesVersion ?? 0;
  return status?.viewerNewChanges ? version - 1 : version;
}
