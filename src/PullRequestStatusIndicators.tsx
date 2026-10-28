import type { PullRequestStatus } from "../shared/types";
import { FailedChecks } from "./FailedChecks";

const reReviewLabel = "Re-review requested · you previously approved";

/** A pending re-review takes precedence over the previous approval in every PR surface. */
export function PullRequestStatusIndicators(props: { status?: PullRequestStatus; repository: string; number: string | number }) {
  const status = props.status;
  if (!status) return null;
  const approved = status.viewerHasApproved || Boolean(status.approvers?.length) || status.reviewDecision === "APPROVED";
  const approvalLabel = status.viewerHasApproved ? "You approved this PR" : approvedBy(status);

  return <>
    {status.viewerReReviewRequested ? <span className="pr-rereview-requested" role="img" aria-label="Re-review requested" title={reReviewLabel}>↻</span>
      : approved && <span className={`pr-approved-check${status.viewerHasApproved ? " pr-approved-self" : ""}`} role="img" aria-label={approvalLabel} title={approvalTooltip(status)}>✓</span>}
    {status.checks === "Failing" && <FailedChecks repository={props.repository} number={props.number} />}
  </>;
}

/** Keep the pending request visible beside the review submission controls. */
export function ReReviewNotice(props: { status?: PullRequestStatus }) {
  if (!props.status?.viewerReReviewRequested) return null;
  return <p className="pr-rereview-notice"><span aria-hidden="true">↻</span> {reReviewLabel}</p>;
}

/** Lead with a pending re-review while retaining the current approvers as context. */
export function reviewLabel(activity: PullRequestStatus): string {
  const status = activity.viewerReReviewRequested ? "Re-review requested" : activity.viewerRequestedChanges ? "You requested changes" : activity.reviewDecision === "APPROVED" ? "Approved" : activity.reviewDecision === "CHANGES_REQUESTED" ? "Changes requested" : "Awaiting review";
  if (!activity.approvers?.length) return status;
  const approvals = approvedBy(activity);
  return activity.reviewDecision === "APPROVED" && !activity.viewerReReviewRequested ? approvals : `${status} · ${approvals}`;
}

/** Name known approvers without inventing an identity for older cached approvals. */
function approvedBy(status: PullRequestStatus): string {
  return status.approvers?.length ? `Approved by ${status.approvers.map((login) => `@${login}`).join(", ")}` : status.viewerHasApproved ? "You approved this PR" : "Approved";
}

/** Keep the approval's actor first and distinguish personal requested changes from the overall decision. */
function approvalTooltip(status: PullRequestStatus): string {
  const approval = approvedBy(status);
  if (status.viewerRequestedChanges) return `${approval} · You requested changes`;
  if (status.reviewDecision === "CHANGES_REQUESTED") return `${approval} · Changes requested`;
  return status.reviewDecision === "APPROVED" ? approval : `${approval} · Awaiting review`;
}
