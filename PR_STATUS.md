# PR dashboard state and transitions

## TL;DR

Order: **Todo → Follow-ups → Unread → Snoozed → Archived → All**.
Todo is the default. Status is primary; author is secondary.

### Todo

- On Needs Review: open PRs currently requesting my review, plus tracked PRs
  with my flagged follow-ups or unread replies to threads I participated in.
- On My PRs: all my open PRs, plus completed PRs with follow-ups or unread feedback.
- Snooze and manual Archive override inclusion without clearing any messages or
  follow-up flags.
- A PR counts once, even when several reasons apply.
- Reading a PR does not complete its outstanding review request.
- Merged/closed PRs remain Todo only for follow-ups or unread discussion.

### Follow-ups

- PRs with outstanding flags I explicitly set on hunks or threads.
- Includes merged/closed PRs with flags. Excludes snoozed and archived PRs.
- Reading or resolving a thread does not clear its follow-up.

### Unread

- PRs with relevant unread messages, derived from shared message receipts.
- On my PRs, all other people's discussion and review feedback with text counts.
- On others' PRs, replies in conversations I participated in count. General PR
  comments form one conversation; participating there includes its other comments.
- Bare approvals, my own messages, new commits, and new review requests are not
  unread messages. A new request already belongs in Todo as outstanding work.
- Includes merged/closed PRs with unread discussion. Excludes snoozed and archived
  PRs without clearing their receipts.

### Snoozed

- Non-archived PRs with an unexpired snooze.
- Snooze lasts one day. New replies, commits, or review requests do not wake it.
- Expiration returns the PR to whichever active filters it qualifies for.
- Completed PRs can still automatically archive while snoozed.

### Archived

- One destination for explicit manual archives and automatically completed work.
- Archive (`a`) replaces Ignore. It can hide any PR, including an open review
  request or a PR with unread messages/follow-ups. It does not change GitHub.
- Manual archives stay hidden until explicitly restored, even with new activity.
- Automatic archival requires all of:
  - Merged or closed.
  - No relevant unread messages and no follow-ups.
  - My current approval, or at least seven days since merge/closure.
- Another person's approval does not satisfy the approval condition.
- My approval permits immediate archival after completion, but never archives an
  open PR. Unread messages and follow-ups block it indefinitely.
- Restore to inbox grants seven days before automatic archival can run again.
  Restore does not invent outstanding work: a restored completed PR without
  replies/follow-ups is available in All, not Todo.
- Opening an archived PR does not restore it. Only explicit Restore does that.

### All

- Literally all saved PRs belonging to this dashboard: open, merged, closed,
  read, unread, flagged, snoozed, and archived.
- Text/repository restrictions and the selected author still narrow the rows.
- This is saved history, not every PR on GitHub and not both dashboards combined.
- Reading history never changes personal state or message receipts.

## Review work versus read state

For Needs Review, after excluding archived and snoozed PRs:

```text
Todo = (open AND myReviewCurrentlyRequested)
    OR followUpCount > 0
    OR unreadThreads > 0
```

My PRs uses `open` instead of `open AND myReviewCurrentlyRequested`.
Todo is not simply the union of Follow-ups and Unread: an outstanding review
request remains Todo even when every message is read.

- Review requested → I open it → still Todo.
- Review requested → I read the last reply → still Todo.
- Review requested → I snooze/archive → hidden despite the request.
- I submit a review and GitHub clears the request → no replies or follow-ups →
  leaves Todo, remains in All.
- Request clears but a follow-up remains → stays Todo.
- Someone later replies in my thread → returns to Todo, unless manually archived
  or still snoozed.
- Last reply read and last follow-up cleared → leaves Todo if no request remains.
- Another review is requested → returns to Todo unless snoozed/archived.

“Submit review” includes Comment, Approve, and Request changes. Individual inline
replies and general comments are not review submissions. Use GitHub's actual
current request state, not the existence of a comment or review, to determine
whether review work remains. Only Approve satisfies the fast-archive condition.

There is no PR-level Mark read / Mark unread action or automatic `seen`
acknowledgment. Opening the diff, overview, comments, or a background browser tab
does not mark anything read. Thread-level Mark read acknowledges only the exact
displayed message IDs. Other threads and concurrent replies remain unread.

## Status and author hierarchy

- Status counts span all authors, including Dependabot. Selecting an author never
  changes those counts. Text and repository filters do affect them.
- Author tabs and their PR stats reflect the selected status.
- Retain the selected author when it still has matches; otherwise select the first
  matching author. Do not retain empty author tabs.
- Sort authors by oldest matching PR creation time, with Dependabot always last.
  Older snapshots fall back to update time when creation time is unavailable.
- There is no All-authors tab. `h` / `l` move between the displayed authors.
- The All status is last. Unknown or absent status parameters default to Todo.

## Persistence, discovery, and refresh

Personal state and message receipts are shared across tabs, browsers, and server
restarts, keyed by normalized `owner/repository/number`. State lives in
`$BIFF_DATA_DIR/inbox.sqlite`, defaulting to `~/.local/share/biff/inbox.sqlite`.

- `pr_user_state` stores manual archive, pin, snooze deadline, and restore grace.
- `inbox_tracked_prs` stores dashboard ownership, GitHub state/closure time, and
  automatic archive time.
- `prs` stores summaries, current review requests, approvals, and discussions.
- `queues` stores discovery snapshots; `preferences` stores repository choice.
- Comment receipts and follow-ups use the shared progress storage.

GitHub discovery finds open authored PRs or current review requests. Human and
Dependabot searches each have their own 100-result limit; Needs Review combines
them. Known PRs remain tracked after leaving discovery so replies and follow-ups
can bring them back. Queue absence alone is not proof a PR closed or lost its
review request: retained PRs are fetched by identity.

The visible dashboard polls local snapshots every three seconds. GitHub refreshes
run when snapshots are two minutes old; focus can request an earlier refresh.
Automatically archived PRs continue participating in refreshes so new replies can
reactivate them. Manually archived PRs absent from discovery skip routine detail
refreshes; explicit history refresh can still update their snapshots. Finding an
archived PR in discovery never clears manual Archive.

Unread receipts and local follow-up changes are reflected on the next local poll,
including automatic archival or reactivation without another GitHub request.
Failed discovery/status fetches retain saved records. Failed activity fetches
prevent automatic archival; failure is not evidence of no replies or follow-ups.

Automatic archival is:

```text
mergedOrClosed
AND unreadThreads == 0
AND followUpCount == 0
AND (approvedByMe OR daysSinceClosure >= 7)
AND restoreGraceExpired
```

Manual Archive overrides active visibility independently of this rule. New
follow-ups or replies can reverse automatic archival, never manual Archive.
No history reconstruction is required. Existing Ignore flags are read as manual
archives; obsolete PR-level read markers no longer control any view.

## Actions, background saves, and sorting

- `a` / `A`: Archive the focused PR, or Restore if already archived.
- `s` / `S`: Snooze / unsnooze the focused PR.
- Actions apply immediately and save in the background, serialized per PR.
  Other rows, navigation, and rapid reversals remain available.
- Failed writes restore the last acknowledged value and remain visible with Retry.
- Acknowledged actions provide a one-minute Undo receipt. Undo rejects stale
  receipts if another personal action changed the saved state.
- PRs sort by most recently updated. PR identity breaks ties.
- Background refreshes preserve row order while the reader is navigating the
  unchanged list or has its discussion modal open.

## Follow-up lifecycle

Follow-ups are durable personal flags, independent of resolution and unread state.
Hunk flags use exact changed text and path, plus coordinates for duplicate edits.
Complete current snapshots remove flags for hunks that no longer exist. Failed
requests, incomplete/single-commit diffs, and custom local bases do not prune them.
Deleted threads lose flags. Linked local/GitHub threads share a flag after
publication. New work remains flagged until explicitly cleared or its underlying
hunk/thread genuinely disappears.

## Implementation references

- [Types and filters](shared/inbox.ts)
- [State, refresh, and archival](server/inbox.ts)
- [GitHub discovery and current review requests](server/github.ts)
- [Relevant discussion messages](shared/commentActivity.ts)
- [Dashboard actions and author hierarchy](src/PullRequests.tsx)
- [Shared thread receipts](src/useCommentReads.ts)
- [Follow-up persistence](server/progress.ts)
