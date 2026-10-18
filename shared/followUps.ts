import type { ChangeIdentity } from "./progress";
import type { ReviewLine } from "./types";

export interface HunkFollowUp extends ChangeIdentity {
  type: "hunk";
  head: string;
  source: "pr" | "local";
}
export interface ThreadFollowUp {
  type: "thread";
  id: string;
  label: string;
  location: ReviewLine;
  githubId?: number;
}
export type FollowUp = HunkFollowUp | ThreadFollowUp;

/** Stable list keys do not depend on the currently displayed file order. */
export function followUpKey(item: FollowUp): string {
  return item.type === "thread" ? item.id : `hunk:${item.path}:${item.hash}:${item.duplicate ? `${item.oldLine}:${item.newLine}` : "unique"}`;
}
