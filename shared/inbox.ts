import type { PullRequestStatus, PullRequestSummary } from "./types";

export type QueueView = "authored" | "requested";
export interface TrackedPullRequest { pr: PullRequestSummary; state: "OPEN" | "CLOSED" | "MERGED"; closedAt?: string | null; view: QueueView }

/** Unknown queue links fall back to the user's own PRs. */
export function queueView(value: string | null): QueueView {
  return value === "requested" || value === "dependabot" ? "requested" : "authored";
}
export type InboxFilter = "todo" | "follow-ups" | "unread" | "snoozed" | "archived" | "all";
export interface Activity { key: string; actor: string; at: string; kind: "reply" | "review"; thread?: string; hasBody?: boolean }
export interface PullActivity extends PullRequestStatus {
  head: string;
  headAuthor: string;
  reviewRequested?: boolean;
  events: Activity[];
}
export interface PersonalState {
  archived: boolean;
  restoredUntil: number;
  snoozeUntil: number;
}
export interface InboxPR extends PullRequestSummary {
  id: string;
  state?: TrackedPullRequest["state"];
  closedAt?: number;
  archivedAt?: number;
  activity?: PullActivity;
  personal: PersonalState;
  /** Outstanding review request, or an open authored PR on My PRs. */
  needsReview?: boolean;
  unreadThreads?: number;
  unread: boolean;
  activityError?: string;
  followUpCount: number;
}
export interface InboxQueue {
  items: InboxPR[];
  updatedAt: number | null;
  refreshing: boolean;
  error?: string;
  truncated: boolean;
  preferences?: { repository: string };
}
export type InboxAction =
  | { action: "archive" | "restore" | "unsnooze" | "snooze" }
  | { action: "set"; personal: PersonalState }
  | { action: "undo"; token: string };

/** All includes history; active work excludes archives and unexpired snoozes. */
export function inboxMatches(pr: InboxPR, filter: InboxFilter, now = Date.now()): boolean {
  if (filter === "all") return true;
  const archived = pr.personal.archived || Boolean(pr.archivedAt);
  if (filter === "archived") return archived;
  if (archived) return false;
  const snoozed = pr.personal.snoozeUntil > now;
  if (filter === "snoozed") return snoozed;
  if (snoozed) return false;
  if (filter === "unread") return pr.unread;
  if (filter === "follow-ups") return pr.followUpCount > 0;
  return Boolean(pr.needsReview || pr.unread || pr.followUpCount > 0);
}
