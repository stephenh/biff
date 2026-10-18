import type { PullRequestSummary } from "./types";

export type QueueView = "authored" | "requested" | "dependabot";

/** Unknown queue links fall back to the user's own PRs. */
export function queueView(value: string | null): QueueView {
  return value === "requested" || value === "dependabot" ? value : "authored";
}
export type InboxFilter = "all" | "unread" | "follow-ups" | "snoozed" | "ignored";
export interface Activity { key: string; actor: string; at: string; kind: "reply" | "review" }
export interface PullActivity {
  head: string;
  headAuthor: string;
  viewer: string;
  reviewDecision: string;
  checks: string;
  events: Activity[];
}
export interface PersonalState {
  ignored: boolean;
  pinned: boolean;
  snoozeUntil: number;
  wakeOnActivity: boolean;
  seenHead: string;
  seenEvents: string[];
  isNew: boolean;
  unread: boolean;
}
export interface InboxPR extends PullRequestSummary {
  id: string;
  activity?: PullActivity;
  personal: PersonalState;
  newCommits: boolean;
  newReplies: number;
  newReviews: number;
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
  preferences?: { sort: "attention" | "recent"; repository: string };
}
export type InboxAction =
  | { action: "ignore" | "restore" | "pin" | "unpin" | "unread" | "unsnooze" }
  | { action: "snooze"; wakeOnActivity?: boolean }
  | { action: "read"; head?: string; events?: string[] }
  | { action: "seen"; head?: string; events?: string[] }
  | { action: "undo"; token: string };

/** Ignore takes precedence over snooze and unread, including when a snooze expires. */
export function inboxMatches(pr: InboxPR, filter: InboxFilter, now = Date.now()): boolean {
  if (filter === "ignored") return pr.personal.ignored;
  if (pr.personal.ignored) return false;
  const snoozed = pr.personal.snoozeUntil > now;
  if (filter === "snoozed") return snoozed;
  return !snoozed && (filter !== "unread" || pr.unread) && (filter !== "follow-ups" || pr.followUpCount > 0);
}
