# Biff — big diff

A browser diff viewer for big text and a new-code-first reading position. Built with React, Pierre Diffs, Vite, and Bun.

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

Reviews default to `@`, with `@-` and up to ten recent ancestor revisions in the selector. Selection does not check out a commit. The daemon snapshots the working copy, resolves the requested revision to an immutable commit ID, and loads that commit's patch. **Refresh** picks up new edits. Empty commits show a normal no-changes view.

URLs such as `/workspaces/<id>?rev=@-` preserve the selected source across reloads and new tabs. The toolbar switches between registered working copies.

## GitHub PRs

The PR dashboard has **My open PRs** and **Needs my review** queues, with filtering and links that open in new tabs. You can also paste any `github.com/owner/repo/pull/number` URL. Each queue shows up to 100 recently updated PRs.

PR reviews support:

- Full PR changes or an individual commit, selected in the URL.
- Description, existing reviews, general comments, and inline threads (including outdated comments).
- General comments and replies to inline threads.
- A review draft with a summary and comments on selected old/new lines in **All changes**.
- **Comment**, **Approve**, and **Request changes** submission actions.

Drafts are saved in browser local storage, keyed by PR. Only **Post comment** or **Submit review** publishes to GitHub. Inline comment coordinates are tied to the reviewed head SHA; submission fails if the PR has moved, preserving the draft. Selecting a commit only changes the diff view, not the local checkout. Code editing and commit creation remain in your working copy.

## Development and tests

`bun dev` runs Vite with an `/api` proxy and starts (or reuses) the Bun API daemon. With a separately running daemon, restart it after changing server code. `bun run build` checks TypeScript and builds `dist/`.

`bun test` runs real-JJ integration tests, fixture-backed GitHub API tests, and browser behavior tests. Browser tests use isolated Vite servers on ports 5174/5175 and `/usr/bin/chromium`; set `CHROMIUM_PATH` to use another Chromium executable. Browser-clock control verifies hover delays without wall-clock sleeps. GitHub write tests use fixtures rather than publishing to real PRs.

`bun run test:e2e` runs Playwright checks for reading settings and saved typography preferences.

## Read

- **Settings** in the top navigation controls the code font and text size. Choices are saved across reviews and browser restarts. Available fonts are IBM Plex Mono, JetBrains Mono, and Monaspace Argon.
- The inline diff shows deletions above additions in one column, using the same font size and indentation. Deleted blocks collapse into thin red strips: hover or keyboard-focus a strip to expand the block. Move away to collapse it. Uncheck **Collapse deleted lines** in **Settings** to keep all old code visible.
- The **?** menu in the top navigation lists the review keyboard shortcuts.
- **j / k** move down / up one readable line within the file, centering and outlining the focused line. Collapsed deletion strips are skipped; expanded deleted lines remain navigable.
- Click a code line or its gutter to select it in place without scrolling. Keyboard navigation continues from that line. Hovering and text-selection drags do not change the selected line.
- **Shift+J / Shift+K** move to the next / previous change block, including separate edits inside one Git `@@` hunk. Each stop centers and outlines its first added line (or first deleted line for deletion-only changes). Moving beyond a file's last change opens the next file's first; moving before its first opens the previous file's last. Navigation stops at the review's ends and skips files without text changes. Use the file dropdown or arrow buttons to select files directly.
- **n / p** move to the next / previous file and its first hunk, stopping at the review's ends.
- **Shift+N** marks the current PR file as Viewed on GitHub, then opens the next file after saving succeeds. On the final file it saves the mark without navigating. Already-viewed files stay viewed.
- **u / Shift+U** expand existing unmodified-line sections / peek while held. Normal context stays visible; releasing the peek restores the previous state. Working-copy and PR reviews fetch omitted lines from the reviewed revision on demand; standalone patches cannot supply omitted content.
- **d** toggles the three nearest deleted blocks above and below the selected line (plus its own block, if deleted). **Shift+D** reveals them only while held, then restores the toggle state. Expansion and collapse keep the selected line at its exact screen position. The revealed neighborhood follows selection; changing files resets the toggle.
- Adjust text from **16–34px**, starting at **22px**.

Pierre handles diff rendering, syntax highlighting, and word-level changes. This first prototype renders one file at a time; very large individual patches have not been optimized.
