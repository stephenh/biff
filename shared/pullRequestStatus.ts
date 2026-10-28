import type { PullRequestStatus } from "./types";

/** Derive personal status from saved requests and approvers, never a previous account's cached flags. */
export function viewerReviewStatus(status: PullRequestStatus, viewer: string) {
  const viewerHasApproved = status.approvers?.some((login) => login.toLowerCase() === viewer.toLowerCase()) ?? false;
  return { viewerHasApproved, viewerReReviewRequested: Boolean(viewerHasApproved && status.reviewRequested) };
}
