import type { PullRequestStatus } from "../shared/types";
import { FailedChecks } from "./FailedChecks";

/** Distinguish personal approval from other approvals consistently in the list and PR header. */
export function PullRequestStatusIndicators(props: { status?: PullRequestStatus; repository: string; number: string | number }) {
  const status = props.status;
  if (!status) return null;
  const approved = status.viewerHasApproved || Boolean(status.approvers?.length) || status.reviewDecision === "APPROVED";
  const approvalLabel = status.viewerHasApproved ? "You approved this PR" : "Approved by someone else";

  return <>
    {approved && <span className={`pr-approved-check${status.viewerHasApproved ? " pr-approved-self" : ""}`} role="img" aria-label={approvalLabel} title={`${approvalLabel} · ${reviewLabel(status)}`}>✓</span>}
    {status.checks === "Failing" && <FailedChecks repository={props.repository} number={props.number} />}
  </>;
}

/** Name current approvers, including personal approval when other required reviews are still pending. */
export function reviewLabel(activity: PullRequestStatus): string {
  const status = activity.reviewDecision === "APPROVED" ? "Approved" : activity.reviewDecision === "CHANGES_REQUESTED" ? "Changes requested" : "Awaiting review";
  if (!activity.approvers?.length) return status;
  const names = activity.approvers.map((login) => `@${login}`);
  const approvals = `Approved by ${names.join(", ")}`;
  return activity.reviewDecision === "APPROVED" ? approvals : `${status} · ${approvals}`;
}
