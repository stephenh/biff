import type { PullRequestStatus } from "./types";

/** Derive personal status from saved requests and approvers, never a previous account's cached flags. */
export function viewerReviewStatus(status: PullRequestStatus, viewer: string) {
  const viewerHasApproved = status.approvers?.some((login) => login.toLowerCase() === viewer.toLowerCase()) ?? false;
  const viewerRequestedChanges = status.reviewDecision === "CHANGES_REQUESTED" && (status.changeRequesters?.some((login) => login.toLowerCase() === viewer.toLowerCase()) ?? false);
  return { viewerHasApproved, viewerRequestedChanges, viewerReReviewRequested: Boolean(viewerHasApproved && status.reviewRequested) };
}

/** Explain new work without implying that GitHub revoked an approval or requested another review. */
export function newChangesLabel(status: PullRequestStatus): string {
  if (status.previousReviewState === "CHANGES_REQUESTED") return "New changes · you requested changes";
  if (status.previousReviewState === "APPROVED" || status.viewerHasApproved) return "New changes · you previously approved";
  return "New changes since your review";
}
