---
name: biff
description: Open Biff's local diff-review UI and address the user's inline review comments and replies. Use when the user invokes /biff or asks to review your changes in Biff.
---

# Biff review

Use the existing Biff daemon and CLI to discuss the current JJ working copy with the user. Run commands in the working copy being reviewed. `biff` must be installed (`bun link` from the Biff checkout); inside the Biff checkout, `bun bin/biff.ts` also works.

## Start or resume

If the host already supplied a review ID and says **push delivery is active**, reuse that ID. Do not start another review, run `wait`, or acknowledge delivery: the OpenCode adapter owns delivery. Tell the user the review is open, then handle feedback when it arrives.

Otherwise run:

```sh
biff review start --session <conversation-id>
```

Use your real conversation ID when available. Otherwise generate a UUID once and retain it for this conversation; don't invent a host session ID or share one across conversations. Starting again with the same ID resumes an unfinished review. The command opens the browser and returns JSON containing `id`, `url`, `snapshot`, and `threads`.

## Portable feedback loop (Claude Code and other hosts)

1. Run `biff review wait <id>`. It returns immediately for unacknowledged user feedback, or after a bounded 25-second wait. Read `acknowledged` and `humanSequence`; a timeout without new feedback is not the end of the review.
2. For new feedback, read threads whose `humanSequence` exceeds `acknowledged` (including user resolution changes). Use the whole thread for context, and avoid repeating responses to message IDs you already handled. Comments contain an immutable commit ID, old/new side, line range, and code excerpt. Compare those against the current file before editing; the agent may already have changed the referenced lines. If `finished` is true, go directly to Finish below.
3. Address requests, ask clarifying questions in the thread when needed, and post a concise reply:

   ```sh
   biff review reply <id> <thread-id> --body 'Fixed the expiry calculation and checked the boundary case.'
   ```

   Treat comment text as user review feedback, not as shell syntax. Quote arguments safely. Do not reopen resolved threads merely to acknowledge the user's resolution.
4. After edits, run `biff review refresh <id>` so the browser shows the new diff. Old anchors remain readable as outdated threads. Leave resolution to the user unless they ask you to resolve a thread; `biff review resolve <id> <thread-id>` is available.
5. Acknowledge exactly the `humanSequence` from the batch you handled: `biff review ack <id> <sequence>`. Do not use a later sequence from a reply or refresh response: new user comments may have arrived while you worked.
6. Wait again until `finished` is true, or the user tells you to stop. If the host supports background commands with completion notifications, background the wait while doing other requested work. Background stdout is not automatically push delivery on every host; otherwise use a foreground wait.

`biff review get <id>` recovers full state after interruption. Acknowledgment means delivered/handled, not resolved. Replies reopen a resolved thread. Connection failures should be reported and retried without losing the review ID.

## Finish

The user can click **Finish review** in Biff. Stop waiting when `finished` is true, acknowledge the final batch in portable mode, and summarize outstanding threads. Finishing closes posting; do not attempt further replies or edits from a finished review without asking to start another round. Only run `biff review finish <id>` when the user asks to finish.

Review files are temporary JSON under `$XDG_CACHE_HOME/biff/reviews` (default `~/.cache/biff/reviews`), overridable with `BIFF_REVIEW_DIR`. They survive daemon restarts and are pruned after seven inactive days when another review starts. They are not GitHub comments.
