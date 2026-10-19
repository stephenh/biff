# PR dashboard state and transitions

Biff does not give a PR one mutually exclusive status. The dashboard combines:

- GitHub queue membership and cached metadata.
- Persisted personal choices and read markers.
- Derived activity badges and effective unread state.
- Filters that decide where the PR appears.

**New to queue** explains why a PR needs attention. **Snoozed** and **Ignored** control where it appears. A PR can be pinned, ignored, and have unread replies at the same time.

## Identity and persistence

Personal state belongs to the normalized `owner/repository/number` identity. The same PR shares this state across **My open PRs**, **Needs my review**, and **Dependabot**, browser tabs, and daemon restarts.

All backend state lives in `$BIFF_DATA_DIR/inbox.sqlite`, defaulting to `~/.local/share/biff/inbox.sqlite` and respecting `XDG_DATA_HOME`.

- `personal` holds the flags and read markers below.
- `prs` holds cached summaries and activity snapshots.
- `queues` holds each queue's current membership and refresh metadata.
- `undo` holds short-lived receipts for personal actions.
- `preferences` holds each queue's repository filter and sort choice.

Dashboard actions change Biff's local state, not GitHub subscriptions, comments, reviews, or PR state.

## Stored personal state

### `isNew`: New to queue

- Defaults to `true` for a PR without personal state.
- Becomes `true` when a successful queue refresh includes a PR absent from that queue's previous saved membership. This includes re-entry after leaving a queue.
- Becomes `false` on an explicit **Mark read** action or a successful automatic `seen` acknowledgment from a visible review.
- Merely listing, focusing, pinning, snoozing, or ignoring the PR does not clear it.

The flag is shared, not separate per queue. Entering an already-initialized second queue can make a previously read PR new again. The first-ever snapshot of a queue does not explicitly reset existing personal state; PRs without state still default to new.

While true, this produces the **New to queue** badge and makes the PR effectively unread.

### `unread`: manual unread override

This stored field is `personal.unread`. It is distinct from the derived `InboxPR.unread` returned to the dashboard.

- Defaults to `false`.
- **Mark unread** sets it to `true` without deleting any read markers.
- **Mark read** or an automatic `seen` acknowledgment sets it to `false`.
- Refreshing GitHub data does not directly change it.

The `u` shortcut toggles according to effective unread state: if the PR is unread for any reason, it performs **Mark read**; otherwise it performs **Mark unread**.

Clearing this override does not necessarily make the PR read. Unseen commits or discussion events can still keep it unread.

### `seenHead`: acknowledged commit SHA

- Defaults to an empty string.
- On the first successful activity snapshot, Biff initializes it to the current head if it is still empty. This establishes a baseline rather than calling all existing commits new.
- A **Mark read** or `seen` action replaces it with the supplied head SHA, if one is supplied.
- Subsequent background refreshes do not advance it automatically.

Opening the full **All changes** PR view in a visible browser tab supplies the head SHA of the loaded review. Opening a single-commit view does not acknowledge the full PR head.

Acknowledgments refer to the snapshot actually loaded, not whichever head is newest when the request reaches the server. An older tab can therefore save an older SHA; if the current head differs, **New commits** remains or becomes true.

### `seenEvents`: acknowledged discussion IDs

- Defaults to an empty list.
- The first successful activity snapshot adds all existing event IDs as a historical baseline. The PR can still need attention through **New to queue**.
- **Mark read** and `seen` actions add their supplied IDs to the existing set. They do not replace the set or consume events that were not supplied.
- Later background refreshes do not mark newly discovered events read.

Event keys distinguish GitHub collections whose numeric IDs may overlap:

- `general:<id>` for top-level PR comments.
- `inline:<id>` for inline review comments and replies.
- `review:<id>` for submitted reviews. Pending draft reviews are excluded.

The dashboard's **Mark read** sends all event IDs in its displayed activity snapshot. Automatic acknowledgments come from the review UI:

- Opening **Discussion & review** acknowledges all loaded general comments, inline comments, and non-pending reviews in that conversation snapshot. This is panel-level acknowledgment, not per-comment scroll tracking.
- Opening an individual inline thread acknowledges its loaded GitHub comment IDs.
- Merely opening the diff does not acknowledge all discussion events.

### `snoozeUntil`: snooze deadline

- Defaults to `0`, meaning no active snooze.
- **Snooze for 1 day** sets it to the backend's current time plus 24 hours. `s` or `S` toggles the focused PR between snoozed and unsnoozed.
- Snoozing again replaces the deadline with a new 24-hour deadline.
- **Unsnooze** sets it to `0`.
- New commits, replies, and reviews never end a snooze early, including snoozes saved by older Biff versions.

A PR is snoozed only while `snoozeUntil > now`. Expiration does not require a timer to clear the stored timestamp: the filter stops treating the PR as snoozed once the deadline passes.

Snoozing and unsnoozing do not clear unread markers or badges. Expiration alone does not create a new unread reason.

### `ignored`: permanent hiding

- Defaults to `false`.
- **Ignore permanently** sets it to `true`.
- **Restore to inbox** sets it to `false`.
- `i` or `I` toggles the focused PR between ignored and restored.
- New activity, queue refreshes, snooze expiration, read acknowledgments, and restarts never clear it.

Ignoring preserves all other personal state. Restoring also preserves that state: a restored PR with an unexpired snooze appears under **Snoozed**, rather than **All**.

Activity continues to refresh for ignored PRs that remain in a fetched queue. It can update their badges or end an underlying snooze, but cannot make them visible outside **Ignored**.

### `pinned`: attention-sort priority

- Defaults to `false`.
- **Pin** sets it to `true`; **Unpin** sets it to `false`.
- Reading, new activity, snoozing, ignoring, and restoring do not change it.

Pinning affects **Needs attention** sorting. It does not imply unread state, bypass filters, or keep a PR in a GitHub queue after it leaves that queue.

## Derived activity and unread state

These values are recomputed from personal state and the latest saved activity snapshot; they are not additional independent stored flags.

### `newCommits`

True when an activity snapshot exists, `seenHead` is nonempty, and the current head SHA differs from `seenHead`.

- A changed head can turn it on, including a force-push or rewritten history.
- Acknowledging the current head turns it off.
- If GitHub's head returns to the acknowledged SHA, it turns off without another read action.
- This comparison does not exclude your own commits.

The badge indicates a different head, not a calculated count of new commits.

### `newReplies` and `newReviews`

These count current snapshot events whose IDs are absent from `seenEvents` and whose actor is not the authenticated GitHub user, separated by event kind.

- Newly fetched events from other people increase the relevant count.
- Acknowledging their IDs reduces it.
- An event removed from a later snapshot no longer contributes.
- Editing an existing comment or review without changing its event ID does not itself create a new event.
- Your own comments and reviews do not contribute.
- Replies count only in review threads you started or commented in. Thread roots, top-level PR comments, and threads without your participation do not contribute to `newReplies`.

### Effective `unread`

```text
unread = personal.isNew
      OR personal.unread
      OR newCommits
      OR newReplies > 0
      OR newReviews > 0
```

Snooze, ignore, and pin do not participate in this formula. A hidden PR can remain unread.

Every successful `read` or `seen` action clears `isNew` and the manual unread override, even if it supplies only a head or only some event IDs. The remaining derived activity determines whether the PR is still unread.

## Automatic read acknowledgment timing

The review UI sends `seen` only when the browser document is visible and it has a head SHA or discussion IDs to acknowledge. Opening a PR in a background tab does not acknowledge it until the tab becomes visible.

The hook acknowledges when the review loads, when its supplied head or event set changes, or when a visibility/focus event allows a previously deferred acknowledgment. A failed save reports an error and can retry on a later visibility/focus event. Nothing is acknowledged solely by focusing a dashboard row, opening GitHub, or viewing the dashboard list.

## Queue membership and filter precedence

GitHub determines queue membership separately from personal flags:

- **My open PRs** uses open PRs authored by the authenticated user.
- **Needs my review** uses open PRs with a review request for that user, excluding Dependabot.
- **Dependabot** uses open Dependabot PRs with a review request for that user. GitHub applies the author filter before the 100-result limit, so dependency updates do not crowd out human review requests.
- Each queue contains up to the 100 most recently updated matches.
- A successful refresh replaces that queue's membership. Closed, merged, no-longer-requested, or out-of-range PRs can disappear without their personal records being deleted.

Filters apply within the selected queue; **Ignored** is not a global archive of every PR ever ignored.

The filter rules are:

1. If `ignored` is true, the PR appears only under **Ignored**.
2. Otherwise, if `snoozeUntil > now`, it appears only under **Snoozed**.
3. Otherwise, it appears under **All**, and also under **Unread** if its effective unread value is true.

Text and repository filters further narrow the visible rows. The filter counts are computed from the selected queue before those extra restrictions.

## Sorting and GitHub display metadata

**Needs attention** sorts pinned PRs first, then unread PRs, then GitHub's `updatedAt` descending, with PR identity as a tie-breaker. **Recent activity** uses `updatedAt` descending and the same tie-breaker. Background updates retain existing row order while keyboard focus is in the list and the selected filters/sort have not changed.

Draft status, review decision, and CI status come from GitHub snapshots:

- Draft status controls the **Draft / Open** label.
- Review decisions display **Approved**, **Changes requested**, or **Awaiting review**.
- GitHub's combined check status displays **Passing**, **Failing**, **Pending**, or **No checks**.

These fields do not directly set unread. A new submitted review can independently create an unread review event, but does not end a snooze. A generic `updatedAt` change is a refresh/sort signal, not an unread reason.

## Refreshes, failures, and undo

Saved queue data is returned immediately. While the dashboard is visible, the browser polls the local snapshot every three seconds. The backend refreshes all three queues when their snapshots are at least two minutes old; returning focus to the window or clicking **Refresh** requests an earlier refresh for the selected queue.

Queue membership is saved before per-PR activity finishes loading. A failed queue refresh retains its last membership and reports an error. A failed activity refresh retains the previous activity and reports an activity error. Refreshing/error indicators describe synchronization, not a PR's personal status.

Personal actions other than automatic `seen` acknowledgments create a one-minute undo receipt. **Undo** restores the entire personal-state snapshot from before that action, including its read markers. It does not restore GitHub metadata or queue membership.

Undo succeeds only if the current personal state still exactly matches the state immediately after the action. A subsequent personal action, automatic acknowledgment, queue re-entry, or first activity baseline can invalidate it if it changes that state. Successful undo consumes the receipt.

## Implementation references

- [Shared types and filter rules](shared/inbox.ts)
- [Stored state, transitions, and badge derivation](server/inbox.ts)
- [GitHub queue and activity snapshots](server/github.ts)
- [Dashboard actions and sorting](src/PullRequests.tsx)
- [Review discussion acknowledgment inputs](src/Reviews.tsx)
- [Visible-tab read acknowledgment](src/useInboxRead.ts)
# Follow-ups

Follow-ups are personal, durable flags on a hunk or an entire discussion thread.
They are independent of unread activity and thread resolution.

- `!` marks the current hunk reviewed, flags it, and advances after the save succeeds.
- On an already flagged hunk, `!` clears only the flag and stays in place.
- `N` and `P` visit follow-ups across files in file/line order, wrapping at either end.
- The Follow-ups list opens hunks and threads, including outdated discussions, and can clear flags.
- Thread Follow up buttons flag the whole thread, not individual replies. Resolving it does not clear the flag.
- The PR dashboard shows a count and a Follow-ups filter. Ignore and snooze still take precedence.
- Attention sorting places follow-ups below pins and above unread activity.

Hunk identity uses exact changed text and path, plus coordinates when identical edits occur more than once.
Complete current snapshots remove flags for hunks that no longer exist. PR refresh checks the head and diff completeness before pruning; failed requests and single-commit views retain flags. Local snapshots with a custom base do not prune. Local changes not yet in the PR are retained during remote reconciliation.
Deleted threads lose their flags. Linked local and GitHub threads share one follow-up after publication.
