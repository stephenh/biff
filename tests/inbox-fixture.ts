import type { InboxPR, InboxQueue } from "../shared/inbox";

/** Give browser tests the same persisted inbox shape as the local API. */
export function inboxPR(number: number, title: string): InboxPR {
  return {
    id: `example/repo/${number}`, title, number, url: `https://github.com/example/repo/pull/${number}`,
    repository: { nameWithOwner: "example/repo" }, author: { login: "reviewer" }, updatedAt: "2026-10-18T00:00:00Z", isDraft: false,
    personal: { archived: false, restoredUntil: 0, snoozeUntil: 0 },
    activity: { head: "a".repeat(40), headAuthor: "reviewer", viewer: "me", events: [], reviewDecision: "REVIEW_REQUIRED", checks: "Passing" },
    needsReview: true, unread: false, followUpCount: 0,
  };
}

export function inboxQueue(items: InboxPR[]): InboxQueue { return { items, updatedAt: Date.now(), refreshing: false, truncated: false }; }
