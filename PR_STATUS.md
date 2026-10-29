# PR dashboard state and transitions

## TL;DR

Order: **Todo → Follow-ups → Unread → Snoozed → Archived → All**.
Todo is the default. Status is primary; author is secondary.

### Todo

- On Needs Review: open PRs currently requesting my review or with new reviewable
  changes since my previous review, plus tracked PRs with my flagged follow-ups or
  unread replies to threads I participated in.
- On My PRs: all my open PRs, plus completed PRs with follow-ups or unread feedback.
- Snooze and manual Archive override inclusion without clearing any messages,
  follow-up flags, or new-change attention. Newly detected reviewable changes
  unsnooze a previously reviewed open PR; manual Archive still wins.
- A PR counts once, even when several reasons apply.
- Reading a PR does not complete its outstanding review request or acknowledge new changes.
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
- Snooze lasts one day. Newly detected reviewable changes after my previous review
  wake it, including another code change while the New changes flag is already set.
  Replies, review requests, unchanged rebases, and auto-reviewed changes do not wake it.
- Expiration returns the PR to whichever active filters it qualifies for.
- Completed PRs can still automatically archive while snoozed.

### Archived

- One destination for explicit manual archives and automatically completed work.
- Archive (`a`) replaces Ignore. It can hide any PR, including one with unread
  messages, follow-ups, or new changes. It removes my outstanding GitHub review
  request without changing previous reviews or other reviewers' requests.
- Replies and pushes do not wake manual archives. Explicit Restore or a newly
  outstanding GitHub review request can restore an open PR.
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
    OR (open AND newReviewableChanges)
    OR followUpCount > 0
    OR unreadThreads > 0
```

My PRs uses `open` instead of `open AND myReviewCurrentlyRequested`.
Todo is not simply the union of Follow-ups and Unread: an outstanding review
request remains Todo even when every message is read.

- Review requested → I open it → still Todo.
- Review requested → I read the last reply → still Todo.
- Review requested → I snooze/archive → hidden despite the request.
- I submit a review and GitHub clears the request → no newer changes, replies, or follow-ups →
  leaves Todo, remains in All.
- Request clears but a follow-up remains → stays Todo.
- Someone later replies in my thread → returns to Todo, unless manually archived
  or still snoozed.
- Last reply read and last follow-up cleared → leaves Todo if no request or new changes remain.
- Another review is requested → returns to Todo unless snoozed/archived.
- Reviewable code changes after my previous review → returns to Todo and unsnoozes,
  unless manually archived. This does not create a GitHub review request.

“Submit review” includes Comment, Approve, and Request changes. Individual inline
replies and general comments are not review submissions. Use GitHub's actual
current request state, not the existence of a comment or review, to determine
whether review work remains. Only Approve satisfies the fast-archive condition.

There is no PR-level Mark read / Mark unread action or automatic `seen`
acknowledgment. Opening the diff, overview, comments, or a background browser tab
does not mark anything read. Thread-level Mark read acknowledges only the exact
displayed message IDs. Other threads and concurrent replies remain unread.

## New reviewable changes

New changes is a durable boolean, separate from GitHub's review request, my approval,
unread messages, follow-ups, and per-hunk checkboxes. It applies after any completed
review, not only an approval:

| Situation | Copy |
| --- | --- |
| I approved, then reviewable code changed | **New changes · you previously approved** |
| I requested changes, then reviewable code changed | **New changes · you requested changes** |
| I submitted a comment-only review, then reviewable code changed | **New changes since your review** |
| I have never submitted a review | Ordinary review-request status; no New changes badge |

- Compare newly present reviewable logical hunks against the previous complete,
  classified PR comparison. A new database row is not required: a historical or
  local-only hunk can become newly present in the PR comparison.
- Use existing content identities, semantic splitting, duplicate disambiguation,
  and exclusions for auto-reviewed files and import-only changes. A different SHA
  alone is not new work. Non-text review units count when they are reviewable.
- The first complete inventory establishes a quiet baseline. Older unchecked hunks
  are not new changes, even if the previous review was submitted without checking them.
- Only complete, current head/base comparisons create attention. Failed, stale,
  incomplete, local, or single-commit comparisons cannot create it.
- Keep the approval indicator. New changes uses a small text pill, not another
  standalone icon. An explicit GitHub re-review request takes precedence in the copy.
- Clear the flag only after a successful Comment/Approve/Request changes review
  submission covering the current version, or explicit **Mark changes reviewed**
  in PR overview. Reviews submitted on GitHub are observed on discussion refresh.
  Remote comment-only reviews need summary text: an empty COMMENTED review can
  also be GitHub's implicit receipt for a standalone inline comment, so Biff does
  not guess. Explicit Biff review submissions can have only inline comments.
- Opening any view, checking hunks, reading threads, posting standalone comments or
  replies, snoozing, and archiving do not acknowledge changes. Removing the changed
  code does not implicitly acknowledge the boolean either.
- Acknowledgment is pinned to the displayed head and change version. A later push
  or base update reconciled during submission must remain pending. Replayed review
  receipts cannot clear work discovered after the original acknowledgment.
- Explicit acknowledgment changes Biff only; it does not submit a review, remove
  a GitHub request, or change message receipts. It saves optimistically in the
  background with persistent failure feedback and Retry.
- Closed/merged PRs do not acquire new-change work, and a retained flag does not
  put a completed PR in Todo or block automatic archival.

## Status and author hierarchy

- Status counts span all authors, including Dependabot. Selecting an author never
  changes those counts. Text and repository filters do affect them.
- Author tabs and their PR stats reflect the selected status.
- Retain the selected author when it still has matches; otherwise select the first
  matching author. Do not retain empty author tabs.
- Sort authors by oldest matching PR creation time, with Dependabot always last.
  Older snapshots fall back to update time when creation time is unavailable.
- The All-authors tab excludes Dependabot; its own author tab remains available.
  `h` / `l` move between All and the displayed authors.
- The All status is last. Unknown or absent status parameters default to Todo.

## Persistence, discovery, and refresh

Personal state and message receipts are shared across tabs, browsers, and server
restarts, keyed by normalized `owner/repository/number`. State lives in
`$BIFF_DATA_DIR/inbox.sqlite`, defaulting to `~/.local/share/biff/inbox.sqlite`.

- `pr_user_state` stores manual archive, snooze deadline, restore grace, and the
  New changes boolean/version, authenticated reader, and last observed submitted
  review ID. The review ID references the synthetic `pr_reviews.id`.
- `inbox_tracked_prs` stores dashboard ownership, GitHub state/closure time, and
  automatic archive time.
- `prs` stores summaries, current review requests, approvals, and discussions.
- `inbox_queues` stores discovery snapshots; `inbox_preferences` stores repository choice.
- Comment receipts and follow-ups use the shared progress storage.

GitHub discovery finds open authored PRs or current review requests, with a
100-result search limit. Known PRs remain tracked after leaving discovery so
replies, follow-ups, and new reviewable changes can bring them back.
Queue absence alone is not proof a PR closed or lost its
review request: retained PRs are fetched by identity.

The visible dashboard polls local snapshots every three seconds. GitHub refreshes
run when snapshots are two minutes old; focus can request an earlier refresh.
Automatically archived PRs continue participating in refreshes so new replies can
reactivate them. Manually archived PRs absent from discovery skip routine detail
refreshes; explicit history refresh can still update their snapshots. Finding an
archived PR in discovery does not itself clear manual Archive; a newly outstanding
review request does.

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
- [New-change attention and acknowledgment](server/reviewChanges.ts)
- [Classified PR comparison](server/prComparison.ts)
