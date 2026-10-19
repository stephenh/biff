# Biff — big diff

A browser diff viewer for big text and a new-code-first reading position. Built with React, Pierre Diffs, Vite, and Bun.

Reviews hide whitespace-only edits by default. Spacing within a line is ignored; added/removed lines and EOF newline changes remain visible. Real edits retain their original line numbers for comments.

JJ reviews use native `jj diff --ignore-all-space`. GitHub and imported patches use a fallback that compares lines within each replacement block; it cannot realign changes across separate blocks. Backend-prepared diffs are not filtered again in the browser.

## Install and launch

Requires Bun, Jujutsu (`jj`), and GitHub CLI (`gh`, authenticated with `gh auth login`).

```sh
bun install
bun run build
bun link
# Ensure ~/.bun/bin is on PATH.
cd ~/homebound/graphql-service
biff                 # register this working copy and open @
biff @-              # previous commit
biff --dashboard     # all registered working copies
biff --prs           # GitHub review queues
biff @ --no-open      # print a review URL without opening the browser
```

The CLI starts or reuses a local Bun daemon at **http://127.0.0.1:4567**. It serves the built React SPA and runs `jj`/`gh` directly. Credentials remain with `gh`.

- `BIFF_PORT` overrides port 4567.
- `BIFF_PUBLIC_ORIGIN=https://biff.draconian.app` opts the daemon into one additional HTTPS origin behind a reverse proxy. It does not change the loopback listener or CLI URLs. See [Caddy and systemd deployment](deploy/README.md) for the Tailscale-only setup, security requirements, and daemon handover commands.
- `BIFF_DATA_DIR` overrides the data directory (default: `$XDG_DATA_HOME/biff`, or `~/.local/share/biff`). All backend state uses one SQLite database, `inbox.sqlite`: working copies, review lifetimes, progress, discussions, comment reads, publication receipts, agent sessions and delivery cursors, repository users, and the PR inbox. The CLI-started daemon writes logs to `daemon.log`.
- SQLite uses WAL mode and transactions. Nested review/session payloads remain JSON within individual database rows; registrations and review aliases have their own tables. Old JSON files are neither read nor imported. `BIFF_REVIEW_DIR` is no longer used. Re-register working copies with `biff` or the dashboard after switching from the JSON-backed version.
- `bun start` runs the daemon in the foreground. After updating Biff, rebuild and restart the daemon to pick up server changes.

## Working Copies

The dashboard persists named JJ workspace paths. Register a copy by running `biff` anywhere inside it, or enter its path in the dashboard. **Discover in folder** registers immediate child JJ working copies (for example, inside `~/homebound`); **Forget** only removes the dashboard entry.

Reviews default to **Bookmark → All changes**. Biff selects a local bookmark on the working commit, or the unique feature bookmark on its parent when `@` has none. This also applies to `/biff`, so an empty `@` after `jj new` opens the preceding bookmark's full review. Inferred reviews include later unbookmarked working-copy edits above that bookmark while retaining its review identity and base. Explicitly selecting a named bookmark stops at its tip. Otherwise **WIP** reviews through `@`. **Changes** switches between the combined diff and individual commits in the range. Selection never checks out a commit. Reload the browser tab to pick up new edits.

Biff chooses the base automatically. Linked reviews use the PR's fork point with its actual target branch. Otherwise Biff uses the nearest unambiguous bookmarked ancestor at or above the trunk fork point, falling back to that fork point when no parent qualifies. Old bookmarks below the fork cannot pull upstream changes into the review. The toolbar shows **Base: parent-bookmark**; hover for its resolved commit ID. Linked-bookmark links identify the review without prescribing a base. Patches, full-source loading, and comment anchors use immutable base/tip commit IDs.

Bookmark, Changes, and explicit Base selections are preserved in the URL. Explicit single-revision URLs such as `/workspaces/<id>?rev=@-` and `biff @-` remain available. The toolbar switches between registered working copies.

Opening a working-copy or PR review starts at the first file with unreviewed hunks, focused on its first unreviewed change.

### Local comments and publication

Ordinary **All changes** bookmark reviews support inline comments without an agent session. Use **+** beside a diff line (or **c** on the selected line), write a comment, and choose **Save locally**. **Through line** extends the anchor to a range. In bookmark reviews, **Local comments** opens the thread list; in PR reviews, that list is inside **Discussion & review**. Both include resolved threads and threads anchored to outdated snapshots.

Comments belong to the same durable review lifetime as file/hunk progress. Opening the matching PR in Biff automatically shares those threads; it never publishes them. In a PR's composer, **Save locally** creates the same kind of durable note. Single-commit views retain their separate review behavior.

Messages have a **Local** or **GitHub** tag. **Publish to PR** publishes saved local messages; the **GitHub** tag links to the published comment. New replies stay local until explicitly published.

Use **Edit** or **Delete** beneath a saved comment. Changes to local comments stay in Biff; changes to published comments are applied to GitHub as well, subject to your GitHub permissions.

GitHub inline threads offer **Resolve thread** or **Reopen thread** in the comment dialog and **Discussion & review** panel. These actions update the thread on GitHub.

## Review Identity & Reconciliation

**TL;DR:** A review logically represents one lifetime of a bookmark's work or a GitHub PR, not one commit. Physically, it is a durable row with an opaque ID in SQLite's `review_records` table. Biff joins local and PR records when an exact recorded bookmark tip matches a recorded PR head and the match is unique in both directions. It rechecks when loading local snapshots or PR reviews—not continuously in the background. Open both sides in Biff, in either order, to make them discoverable.

### Logical identity: one lifetime of work

- **Local lookup:** `(workspace ID, bookmark name)`, with an empty bookmark representing WIP. This locates the current lifetime; reusing the name does not prove it is the same work.
- **Continuity:** Biff accumulates JJ change IDs and Git commit IDs from the review's revision range. A later snapshot continues the lifetime if it overlaps that recorded history. JJ change IDs preserve continuity across rewritten commits. If both old and new change-ID sets are nonempty and neither change IDs nor commit IDs overlap, Biff starts a new lifetime.
- **PR lookup:** normalized `owner/repository/number`. Once associated, the PR and local bookmark address the same lifetime. Subsequent commits do not need to rediscover that association.
- **Lifetime boundaries:** **Start new review** (in the toolbar's **⋯** menu), an observed closed/merged PR, or unrelated local work creates a fresh local lifetime. The previous PR retains its progress and comments. A previously associated PR cannot be rediscovered as an unassociated PR and attached to the new lifetime.

Review identity does not mean every approval remains valid: file/block content fingerprints determine which saved marks apply to the displayed diff. Comment anchors retain their original base/head and line coordinates; a new snapshot can make them outdated without changing the review's identity.

### Physical identity: durable records and aliases

`$BIFF_DATA_DIR/inbox.sqlite` stores review identity in three tables:

- `review_records`: opaque 64-character review ID → lifetime record, including progress, threads, publication receipts, recorded commits/change IDs, and local/PR associations.
- `local_reviews`: serialized `[workspace ID, bookmark]` → the current local lifetime's ID.
- `review_aliases`: scopes such as `jj/<workspace ID>/<review ID>` and `owner/repository/number` → the canonical review ID.

When two records are reconciled, the local ID survives. Biff merges progress and threads, redirects the PR record's aliases to the local record, and removes the redundant PR record in one atomic registry update. Agent-session IDs are separate: they identify temporary delivery sessions, not the durable review lifetime.

### When reconciliation runs

- **Load a workspace review**, including browser reload or changing its bookmark: record the local revision range and bookmark tip, check lifetime continuity, and match against already-recorded PR heads. If linked, fetch that PR's status and derive its comparison base; an observed closure ends the lifetime and prepares a fresh local one.

- **Start or refresh an agent review with an All changes snapshot:** run the same local preparation as an ordinary workspace review. Reading/waiting for session feedback alone does not load a new snapshot.

- **Load a GitHub PR review**, including browser reload or selecting a commit: fetch the PR and its commit list, record its commits and closed state, and match against already-recorded local reviews.

- **Start new review:** allocate a fresh local lifetime and run discovery against eligible recorded PRs; the previously attached PR remains with the old lifetime.

Discovery requires an **exact Git commit ID** shared by a recorded bookmark tip and a recorded PR head. Shared ancestor commits are insufficient, even when the diff includes the whole stack. Unbookmarked agent extensions are recorded separately from the bookmark tip; WIP reviews use their working tip. Historical tip/head matches remain valid after amendments. The PR must match exactly one local candidate, and that local candidate must match exactly one PR candidate. Ambiguous matches stay separate. Closed records and already-associated records are excluded from new matching. Existing links are retained; older unlinked records acquire tip evidence when reopened rather than guessing it from their saved ranges.

The comparison uses accumulated snapshots Biff has recorded, not a fresh scan of all JJ history or a search through every GitHub PR. Branch names, similar patches, and JJ change IDs do not establish a local-to-PR match. Dashboard loads, progress/comment edits, and discussion streams do not run discovery. Pushing commits alone therefore does not trigger reconciliation: reload/open the relevant reviews to record the matching snapshots. Linking never publishes comments.

## Agent collaboration: `/biff`

`/biff` opens the workspace review with a collaboration session attached (`/workspaces/<id>?review=<session>`). It uses the same revision picker, diff viewer, keyboard navigation, and durable per-change progress as ordinary workspace reviews, with a Discussion control added. All-changes sessions share the bookmark's durable threads: comments saved through the ordinary bookmark/PR view reach an attached agent, and its replies appear live in those views. Selecting another workspace or revision leaves the attached session; its URL remains available for returning to the discussion.

In this checkout, type **`/biff` in OpenCode V2 or Claude Code** after installing/building Biff. OpenCode loads `.opencode/plugins/biff/index.ts`; Claude Code discovers `.claude/skills/biff/SKILL.md`. The linked `biff` CLI must be on PATH.

- Post comments using **+** beside a diff line. **Through line** extends the comment to a range on the same old/new side.
- Agent replies appear live in the same threads. **Discussion** lists every thread, including resolved and outdated ones.
- Reloading the browser tab (or the agent's `refresh` command) includes current unbookmarked edits above the inferred bookmark. Switching to an unrelated branch or creating another bookmark does not pull that work into the original review. Finished discussions retain their final snapshot. Threads retain their original commit and excerpt rather than moving to potentially unrelated lines.
- Closing the tab disconnects the UI; reopening or reloading reconnects to the same session. Posted feedback still reaches the agent. Inactive sessions expire after seven days. To explicitly close posting and end the feedback loop, use `biff review finish <id>`.

OpenCode pushes posted feedback into the originating conversation, even while the agent is busy. Stable prompt IDs and a persisted acknowledgment cursor prevent duplicate admission on retries. The adapter reconnects after daemon/plugin restarts. Claude Code uses the skill's bounded long-poll loop: feedback returns immediately while waiting, and comments posted while it works are picked up on the next wait. A skill alone cannot wake an idle Claude Code conversation after that loop has stopped.

### Session storage

The daemon stores agent sessions in the shared database's `sessions` table. Each row contains the diff snapshot, workspace/conversation association, threads, messages, and delivery cursors. Writes are serialized and committed before acknowledgment. No SQLite transaction is held open during a GitHub network request. Browser local storage holds unposted drafts and reading settings.

Sessions survive browser refreshes and daemon restarts, including finished reviews. Agent sessions inactive for seven days are deleted when a new session starts. Shared bookmark comments remain in durable review storage; deleting a session does not delete them. Comments are only posted to GitHub through an explicit publication action.

### CLI protocol

```sh
biff review start --session <conversation-id>  # opens or resumes this conversation's review
biff review wait <review-id>                  # JSON; returns on feedback or after 25 seconds
biff review reply <review-id> <thread-id> --body 'Fixed and verified.'
biff review refresh <review-id>
biff review ack <review-id> <batch-humanSequence>
biff review get <review-id>                   # recover full state
biff review resolve <review-id> <thread-id>   # reopen is also available
biff review finish <review-id>
```

`start` also accepts `--no-open` and `--rev @-`. Bookmark reviews refresh their inferred range; single-revision sessions refresh to the current `@`. Acknowledgment is separate from thread resolution. The OpenCode adapter owns acknowledgments in push mode; the agent owns them in portable mode.

### Use in other projects

Copy or symlink `.claude/skills/biff` into that project's `.claude/skills/` (or `~/.claude/skills/` for global use). Both agents discover that skill. To get OpenCode's `/biff` command and push adapter, add the absolute path to this checkout's `integrations/opencode.ts` to the project's `plugins` array in `opencode.jsonc`:

```jsonc
{
  "plugins": ["/absolute/path/to/biff/integrations/opencode.ts"]
}
```

Merge into existing configuration rather than replacing it. For portable OpenCode use without the adapter, create `.opencode/commands/biff.md` containing `Load the biff skill and start its portable review loop.` After a Biff server update, rebuild and restart the running daemon before using the new protocol.

## GitHub PRs

See [PR_STATUS.md](PR_STATUS.md) for dashboard flags, their transitions, derived activity badges, and filter precedence.

The PR dashboard has **My open PRs**, **Needs my review**, and **Dependabot** queues. Dependabot PRs requested for your review appear in their own queue instead of Needs my review. All three are persisted in SQLite and appear immediately on subsequent visits. While the dashboard is visible, the browser polls the local snapshot every three seconds; the backend refreshes GitHub about every two minutes. Returning to the window or choosing **Refresh** requests an earlier refresh. Saved rows remain usable during refreshes and outages. Each queue shows up to 100 recently updated PRs.

- **All / Unread / Snoozed / Ignored** filter the queue with live counts. Repository and sort preferences are saved on the backend. **Needs attention** sorts pinned PRs first, then unread PRs; **Recent activity** uses GitHub update order. Background updates preserve row order while keyboard focus is in the list.
- **New commits**, **new replies**, and **new reviews** compare exact SHAs and event IDs with what you have read. New replies count only replies from others in review threads you started or commented in; top-level PR comments and unrelated threads do not count. The first snapshot establishes an activity baseline and shows **New to queue**. Looking at the dashboard does not mark anything read. Opening the full PR revision in a visible tab acknowledges that head; opening its discussion or a comment thread acknowledges the displayed discussion. **Mark read / Mark unread** is also available explicitly.
- **Snooze for 1 day** hides a PR for 24 hours regardless of new commits or discussion activity. **Snoozed** offers **Unsnooze** to bring it back early.
- **Ignore permanently** hides a PR from every other filter, even after new activity or a restart. Find it under **Ignored** and choose **Restore to inbox**. Ignore, snooze, and pins are shared across both queues. Personal actions offer a one-minute **Undo**; an older undo cannot overwrite a newer decision.
- **h / l** switch queues, **j / k** select a PR, **Enter / Shift+Enter** open it here / in a new Biff tab, **g** opens it on GitHub, **s** snoozes it, and **u** toggles read/unread. The **•••** menu provides all personal actions. You can also paste any `github.com/owner/repo/pull/number` URL.

These dashboard actions only change Biff's local state. They do not submit GitHub reviews, change subscriptions, or modify PRs.

PR reviews support:

- Full PR changes or an individual commit, selected in the URL.
- Description, existing reviews, general comments, and inline threads (including outdated comments).
- General comments and replies to inline threads.
- Repository-user `@mention` suggestions in comments, replies, and review drafts. Use arrow keys and Enter/Tab to select, or Escape to dismiss suggestions.
- A review draft with a summary and comments on selected old/new lines in **All changes**.
- **Comment**, **Approve**, and **Request changes** submission actions.

Drafts are saved in browser local storage, keyed by PR. Only **Post comment** or **Submit review** publishes to GitHub. Inline comment coordinates are tied to the reviewed head SHA; submission fails if the PR has moved, preserving the draft. Selecting a commit only changes the diff view, not the local checkout. Code editing and commit creation remain in your working copy.

## Development and tests

`bun dev` runs Vite with an `/api` proxy and starts (or reuses) the Bun API daemon. With a separately running daemon, restart it after changing server code. `bun run build` checks TypeScript and builds `dist/`.

`bun test` runs real-JJ integration tests, fixture-backed GitHub API tests, and browser behavior tests. Browser tests use isolated Vite servers on ports 5174–5176 and `/usr/bin/chromium`; set `CHROMIUM_PATH` to use another Chromium executable. Local-review tests exercise SQLite persistence, delivery retries, and real browser/CLI replies. Browser-clock control verifies hover delays without wall-clock sleeps. GitHub write tests use fixtures rather than publishing to real PRs.

`bun run test:e2e` runs Playwright checks for reading settings and saved typography preferences.

## Read

- Import-only change blocks are excluded from review progress and next/previous unreviewed-change navigation, even when imports are expanded. Blocks that also change business code still count.
- Repository-root `schema.graphql` and `yarn.lock` are always treated as reviewed, at both file and hunk level, including after new edits. Unreviewed navigation skips them; files with those names in subdirectories still require review.
- Files named `.history.json` are also automatically reviewed at any directory depth.

- Local JJ workspace reviews also remember per-change completion. **All changes** belongs to a durable bookmark (or WIP) review lifetime, independent of the selected base policy. Exact JJ change IDs preserve continuity across amendments and rebases; unrelated JJ changes start a fresh lifetime. Individual-commit progress uses its separate stable JJ change ID. The same **Space**, **n / p**, and per-file counter apply.

- Opening a PR automatically discovers its local **All changes** review through exact commit IDs recorded in local snapshots. This also works when the PR is opened first and the local bookmark later. No manual linking is needed. Branch names and matching patches never establish a link; ambiguous matches remain independent. Once associated, both views share file/block approvals and removals, even while local edits are ahead of the PR. Existing Biff progress from both views is retained. Unmatched edits still require review.

- A closed or merged PR ends its review lifetime when Biff next reads its status. Reusing the bookmark starts fresh. **Start new review** also starts a fresh lifetime explicitly, retaining the old PR's progress. Old snapshot tabs continue to address their original lifetime.

- **Reviewed** is the single file completion checkbox. It marks the current file diff and its blocks together; clearing it removes both. Ordinary text files also become complete when all reviewable blocks are complete. New edits make a file incomplete while unchanged blocks retain approval. Metadata-only, binary, rename, and mode changes require explicit file review. In PR views, Biff imports existing GitHub Viewed marks and syncs shared review progress back to GitHub, including progress inherited from a linked bookmark. Failed syncs offer **Retry**.

- PR **All changes** reviews remember completion per change block in Biff's local data directory. **Space** saves the current change and advances; **n / p** skip completed changes, while **j / k** still move through visible lines. Completed lines are muted with a green edge. The progress count is centered beneath the current filename and counts only that file's changes. Completing a file's reviewable blocks also syncs its Viewed flag to GitHub.
- Completion survives unrelated line shifts for unique exact edits. Identical edits within a file additionally require their old/new starting line numbers to match. Changed text, split/merged edits, and renamed paths require review again. Marks are stored under `$BIFF_DATA_DIR/progress` (default `~/.local/share/biff/progress`) without the agent-review session expiration.

- **Settings** in the top navigation controls the code font and text size. Choices are saved across reviews and browser restarts. Available fonts are IBM Plex Mono, JetBrains Mono, and Monaspace Argon.
- The inline diff shows deletions above additions in one column, using the same font size and indentation. Deleted blocks collapse into thin red strips: hover or keyboard-focus a strip to expand the block. Move away to collapse it. Uncheck **Collapse deleted lines** in **Settings** to keep all old code visible.
- The **?** menu in the top navigation lists the review keyboard shortcuts.
- TypeScript import stanzas with edits fold into **N Import changes**, including unchanged imports between edits. The count is the number of added/deleted import lines. Click the summary or focus its button and press **Enter / Space** to expand or collapse it. Automatic selection and line/change navigation skip collapsed imports. Comment jumps reveal their exact import line automatically; existing threads are counted in the summary. The initial pane waits for classification so expanded imports do not flash on reload.
- **j / k** move down / up one readable line within the file and outline it. The viewport follows gradually, allowing the selection to move within the middle 20% before scrolling. Repeated presses retain scroll momentum; wheel or pointer input cancels it. Reduced-motion mode centers immediately. Collapsed deletion strips are skipped; expanded deleted lines remain navigable.
- Click a code line or its gutter to select it in place without scrolling. Keyboard navigation continues from that line. Hovering and text-selection drags do not change the selected line.
- **n / p** move to the next / previous change block, including separate edits inside one Git `@@` hunk. Each stop centers and outlines its first added line (or first deleted line for deletion-only changes). Moving beyond a file's last change opens the next file's first; moving before its first opens the previous file's last. Navigation stops at the review's ends and skips files without text changes.
- The horizontal file rail centers the current basename between neighboring files. Click a neighbor, press **h / l** or **← / →**, or open the current filename's jump list to select a file. Full paths are available on hover and in the jump list. The code panes slide in the same direction; reduced-motion preferences disable the slides.
- **h / l** move to the previous / next file and its first hunk, stopping at the review's ends.
- **Shift+H / Shift+L** immediately opens the previous / next file and saves its Biff file/block progress. In PR mode it also saves the current file's Viewed mark on GitHub in the background. You can continue marking files while earlier saves are pending. Failed GitHub saves identify the file and offer **Retry**. At either boundary it saves the mark without navigating. Already-viewed files stay viewed.
- **u / Shift+U** expand existing unmodified-line sections / peek while held. Normal context stays visible; releasing the peek restores the previous state. Working-copy and PR reviews fetch omitted lines from the reviewed revision on demand; standalone patches cannot supply omitted content.
- **d** toggles the three nearest deleted blocks above and below the selected line (plus its own block, if deleted). **Shift+D** reveals them only while held, then restores the toggle state. Expansion and collapse keep the selected line at its exact screen position. The revealed neighborhood follows selection; changing files resets the toggle.
- Adjust text from **16–34px**, starting at **22px**.

Pierre handles diff rendering, syntax highlighting, and word-level changes. This first prototype renders one file at a time; very large individual patches have not been optimized.
