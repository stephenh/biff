# Biff — big diff

A browser-based diff viewer focused on:

1. "big text" -- I'm old & need bigger fonts,
2. hunk-level incremental progress tracking -- game changer for coming back into PRs
3. PR dashboard that doesn't suck -- todo, archive, snooze, new changes, unread replies

[Here's a demo video.](https://www.youtube.com/watch?v=HV-A_erOV1o)

[![Watch the Biff demo](https://img.youtube.com/vi/HV-A_erOV1o/hqdefault.jpg)](https://www.youtube.com/watch?v=HV-A_erOV1o)

## Features

Screenshots use [joist-orm/joist-orm#2039](https://github.com/joist-orm/joist-orm/pull/2039).

<table>
  <tr>
    <td width="35%" valign="top">
      <h3>Big, readable diffs</h3>
      <p>I used split diffs for years, but that gives code only ~40-50% of your horizontal screen space, and ugly line wrapping in bigger font sizes.</p>
      <p>Biff uses unified diffs but <i>collapses deleted lines</i> to give you a very split-esque view: new code is not intermixed with old code.</p>
    </td>
    <td width="65%" valign="top">
      <a href="docs/screenshots/readable-diffs.png"><img src="docs/screenshots/readable-diffs.png" alt="Joist's Table.orderBy diff with Settings open at 26px text size" width="650"></a>
    </td>
  </tr>
  <tr>
    <td valign="top">
      <h3>Hunk-level progress tracking</h3>
      <p>Biffs marks individual <b>logical hunks</b> as reviewed, so when you come back into an updated PR, <b>only the new & unreviewed hunks need reviewed</b>.</p>
      <p>Hunk identity is based on contents, not line number, so hunks moving up/down do not reset progress.</p>
    </td>
    <td valign="top">
      <a href="docs/screenshots/review-progress.png"><img src="docs/screenshots/review-progress.png" alt="A muted reviewed hunk above an unreviewed TypeScript change, with per-file and PR progress counters" width="650"></a>
    </td>
  </tr>
  <tr>
    <td valign="top">
      <h3>A PR inbox</h3>
      <p>Separate queues for your PRs, review requests, and Dependabot, with unread activity, pins, snooze, and ignore.</p>
     <p>See which PRs have new commits or replies without opening each one.</p>
    </td>
    <td valign="top">
      <a href="docs/screenshots/pr-inbox.png"><img src="docs/screenshots/pr-inbox.png" alt="The PR inbox filtered to Joist's Table.orderBy PR, with unread replies and snooze and archive actions" width="650"></a>
    </td>
  </tr>
  <tr>
    <td valign="top">
      <h3>Inline feedback for coding agents</h3>
      <p>Use <code>/biff</code> to review an agent's work in the browser and leave comments on specific lines. The agent gets your feedback and replies in the same threads.</p>
    </td>
    <td valign="top">
      <a href="docs/screenshots/agent-feedback.png"><img src="docs/screenshots/agent-feedback.png" alt="An example inline conversation between a reviewer and a coding agent on Joist's TableOrderBy type" width="650"></a>
    </td>
  </tr>
  <tr>
    <td valign="top">
      <h3>Local reviews that carry over to GitHub</h3>
      <p>Review a JJ bookmark before opening a PR, with saved progress and local comments. When Biff identifies the matching PR, both views share that review; comments stay local until you publish them.</p>
    </td>
    <td valign="top">
      <a href="docs/screenshots/local-to-github.png"><img src="docs/screenshots/local-to-github.png" alt="A local feat/table-order-by bookmark review with saved hunk progress and an Open linked PR action" width="650"></a>
    </td>
  </tr>
  <tr>
    <td valign="top">
      <h3>GitHub reviews without switching tools</h3>
      <p>Read PR discussions, reply to threads, and submit comments, approvals, or change requests from Biff. Review the full PR or select an individual commit without changing your checkout.</p>
    </td>
    <td valign="top">
      <a href="docs/screenshots/github-review.png"><img src="docs/screenshots/github-review.png" alt="An example review draft with Comment, Approve, and Request changes actions, before submission" width="650"></a>
    </td>
  </tr>
  <tr>
    <td valign="top">
      <h3>Keyboard-driven navigation</h3>
      <p>Move between files, lines, and unreviewed changes without reaching for the mouse. Space marks a change reviewed and moves on; shortcuts reveal surrounding code and collapsed deletions when needed.</p>
    </td>
    <td valign="top">
      <a href="docs/screenshots/keyboard-navigation.png"><img src="docs/screenshots/keyboard-navigation.png" alt="Review keyboard shortcuts above Joist's diff, with the Space shortcut for marking a hunk reviewed" width="650"></a>
    </td>
  </tr>
</table>

### Historical hunks

Focusing a changed hunk with `j`/`k`, hunk navigation, or a click keeps its text for Historical. This works in All changes for both GitHub PRs and local reviews, including uncommitted `/biff` iterations. Encountering a hunk does not mark it reviewed or change GitHub's Viewed flags; submitting a GitHub review also keeps its submitted hunks.

When kept hunks are no longer present in the displayed comparison, open **Historical** or press `H` to read them beside the current file. Nearby old hunks are grouped for browsing, not tracked as ancestors of current hunks. Existing captured history is preserved during the upgrade.

## Install and launch

Requires Bun and Git. Jujutsu (`jj`) is needed only for JJ workspaces; GitHub features require GitHub CLI (`gh`, authenticated with `gh auth login`).

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

The CLI starts or reuses a local Bun daemon at **http://127.0.0.1:4567**. It serves the built React SPA and runs `jj`/`git`/`gh` directly. Credentials remain with `gh`.

Git-only repositories and linked Git worktrees work without JJ installed. Colocated repositories continue to use JJ. In Git, `biff @` reviews staged, unstaged, and non-ignored untracked files against HEAD; `biff @-` reviews HEAD itself. You can also pass a Git ref or commit ID. The default branch review uses the merge base with `origin/HEAD`, `main`, or `master`; `biff review start --bookmark feature/name` selects a Git branch explicitly. Git working-tree reviews are live: file modification times and sizes, HEAD, and the index are checked before loading context or saving comments. Stale requests ask you to refresh. Biff does not create Git commits, objects, refs, or private indexes. A Git branch's review lasts until you start a new review or its linked PR closes.

- `BIFF_PORT` overrides port 4567.
- `BIFF_PUBLIC_ORIGIN=https://biff.draconian.app` opts the daemon into one additional HTTPS origin behind a reverse proxy. It does not change the loopback listener or CLI URLs. See [Caddy and systemd deployment](deploy/README.md) for the Tailscale-only setup, security requirements, and daemon handover commands.
- `BIFF_DATA_DIR` overrides the data directory (default: `$XDG_DATA_HOME/biff`, or `~/.local/share/biff`). All backend state uses one SQLite database, `inbox.sqlite`: working copies, review lifetimes, progress, discussions, comment reads, publication receipts, agent sessions and delivery cursors, repository users, and the PR inbox. The CLI-started daemon writes logs to `daemon.log`.
- SQLite uses WAL mode and transactions. Nested review/session payloads remain JSON within individual database rows; registrations and review aliases have their own tables. Old JSON files are neither read nor imported. `BIFF_REVIEW_DIR` is no longer used. Re-register working copies with `biff` or the dashboard after switching from the JSON-backed version.
- `bun start` runs the daemon in the foreground. After updating Biff, rebuild and restart the daemon to pick up server changes.

## More to add

- Working copies
- Local commits & agent sessions
- Persist review identity
- Comments are auto-migrated
- `/biff`
