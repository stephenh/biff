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
- `BIFF_DATA_DIR` overrides the data directory (default: `$XDG_DATA_HOME/biff`, or `~/.local/share/biff`). It contains `working-copies.json` and the CLI-started daemon's `daemon.log`.
- `bun start` runs the daemon in the foreground. After updating Biff, rebuild and restart the daemon to pick up server changes.

## Working Copies

The dashboard persists named JJ workspace paths. Register a copy by running `biff` anywhere inside it, or enter its path in the dashboard. **Discover in folder** registers immediate child JJ working copies (for example, inside `~/homebound`); **Forget** only removes the dashboard entry.

Reviews default to `@`, with `@-` and up to ten recent ancestor revisions in the selector. Selection does not check out a commit. The daemon snapshots the working copy, resolves the requested revision to an immutable commit ID, and loads that commit's patch. Reload the browser tab to pick up new edits. Empty commits show a normal no-changes view.

URLs such as `/workspaces/<id>?rev=@-` preserve the selected source across reloads and new tabs. The toolbar switches between registered working copies.

## Agent collaboration: `/biff`

`/biff` opens the workspace review with a collaboration session attached (`/workspaces/<id>?review=<session>`). It uses the same revision picker, diff viewer, keyboard navigation, and durable per-change progress as ordinary workspace reviews, with a Discussion control added. Selecting another workspace or revision leaves the attached session; its URL remains available for returning to the discussion.

In this checkout, type **`/biff` in OpenCode V2 or Claude Code** after installing/building Biff. OpenCode loads `.opencode/plugins/biff/index.ts`; Claude Code discovers `.claude/skills/biff/SKILL.md`. The linked `biff` CLI must be on PATH.

- Post comments using **+** beside a diff line. **Through line** extends the comment to a range on the same old/new side.
- Agent replies appear live in the same threads. **Discussion** lists every thread, including resolved and outdated ones.
- Reloading the browser tab (or the agent's `refresh` command) snapshots the current working commit. Finished discussions retain their final snapshot. Threads retain their original commit and excerpt rather than moving to potentially unrelated lines.
- Closing the tab disconnects the UI; reopening or reloading reconnects to the same session. Posted feedback still reaches the agent. Inactive sessions expire after seven days. To explicitly close posting and end the feedback loop, use `biff review finish <id>`.

OpenCode pushes posted feedback into the originating conversation, even while the agent is busy. Stable prompt IDs and a persisted acknowledgment cursor prevent duplicate admission on retries. The adapter reconnects after daemon/plugin restarts. Claude Code uses the skill's bounded long-poll loop: feedback returns immediately while waiting, and comments posted while it works are picked up on the next wait. A skill alone cannot wake an idle Claude Code conversation after that loop has stopped.

### Temporary storage

The daemon is the sole writer of `$XDG_CACHE_HOME/biff/reviews/<review-id>.json` (default `~/.cache/biff/reviews`). `BIFF_REVIEW_DIR` overrides that directory. Each file contains the diff snapshot, workspace/conversation association, threads, messages, and delivery cursors. Writes are serialized and use atomic rename before acknowledgment. No database is used. Browser local storage holds only unposted drafts.

Files survive browser refreshes and daemon restarts, including finished reviews. Reviews inactive for seven days are deleted when a new review starts. These local comments are never posted to GitHub.

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

`start` also accepts `--no-open` and `--rev @-`; refresh always loads the current `@`. Acknowledgment is separate from thread resolution. The OpenCode adapter owns acknowledgments in push mode; the agent owns them in portable mode.

### Use in other projects

Copy or symlink `.claude/skills/biff` into that project's `.claude/skills/` (or `~/.claude/skills/` for global use). Both agents discover that skill. To get OpenCode's `/biff` command and push adapter, add the absolute path to this checkout's `integrations/opencode.ts` to the project's `plugins` array in `opencode.jsonc`:

```jsonc
{
  "plugins": ["/absolute/path/to/biff/integrations/opencode.ts"]
}
```

Merge into existing configuration rather than replacing it. For portable OpenCode use without the adapter, create `.opencode/commands/biff.md` containing `Load the biff skill and start its portable review loop.` After a Biff server update, rebuild and restart the running daemon before using the new protocol.

## GitHub PRs

The PR dashboard has **My open PRs** and **Needs my review** queues, with filtering and links that open in new tabs. You can also paste any `github.com/owner/repo/pull/number` URL. Each queue shows up to 100 recently updated PRs.

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

`bun test` runs real-JJ integration tests, fixture-backed GitHub API tests, and browser behavior tests. Browser tests use isolated Vite servers on ports 5174–5176 and `/usr/bin/chromium`; set `CHROMIUM_PATH` to use another Chromium executable. Local-review tests exercise the JSON store, delivery retries, and real browser/CLI replies. Browser-clock control verifies hover delays without wall-clock sleeps. GitHub write tests use fixtures rather than publishing to real PRs.

`bun run test:e2e` runs Playwright checks for reading settings and saved typography preferences.

## Read

- Import-only change blocks are excluded from review progress and next/previous unreviewed-change navigation, even when imports are expanded. Blocks that also change business code still count.

- Local JJ workspace reviews also remember per-change completion. Progress is scoped to the workspace and stable JJ change ID, so edits and rebases preserve matching marks while switching to a different change starts separate progress. The same **Space**, **n / p**, and per-file counter apply.

- PR **All changes** reviews remember completion per change block in Biff's local data directory. **Space** saves the current change and advances; **n / p** skip completed changes, while **j / k** still move through visible lines. Completed lines are muted with a green edge. The progress count is centered beneath the current filename and counts only that file's changes. This progress is independent of GitHub's per-file Viewed flag.
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
- **Shift+H / Shift+L** immediately opens the previous / next PR file and saves the current file's Viewed mark on GitHub in the background. You can continue marking files while earlier saves are pending. Failed saves identify the file and offer **Retry**. At either boundary it saves the mark without navigating. Already-viewed files stay viewed.
- **u / Shift+U** expand existing unmodified-line sections / peek while held. Normal context stays visible; releasing the peek restores the previous state. Working-copy and PR reviews fetch omitted lines from the reviewed revision on demand; standalone patches cannot supply omitted content.
- **d** toggles the three nearest deleted blocks above and below the selected line (plus its own block, if deleted). **Shift+D** reveals them only while held, then restores the toggle state. Expansion and collapse keep the selected line at its exact screen position. The revealed neighborhood follows selection; changing files resets the toggle.
- Adjust text from **16–34px**, starting at **22px**.

Pierre handles diff rendering, syntax highlighting, and word-level changes. This first prototype renders one file at a time; very large individual patches have not been optimized.
