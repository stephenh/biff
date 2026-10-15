# Biff — big diff

A browser diff viewer for big text and a new-code-first reading position. Built with React, Pierre Diffs, Vite, and Bun.

## Run

```sh
bun install
bun dev
```

Open the localhost URL printed by Vite. `bun run build` checks TypeScript and produces `dist/`.

`bun test` runs patch-parsing and browser behavior tests with Bun's test runner. Browser tests start an isolated Vite server on port 5174 and use `/usr/bin/chromium`; set `CHROMIUM_PATH` to use another Chromium executable. Browser-clock control verifies the 50ms hover delay without wall-clock sleeps.

`bun run test:e2e` runs the existing Playwright upload and invalid-input checks.

## Bring a patch

Open or drop one or more `.diff` / `.patch` files, or use **Paste diff**. The built-in fixture covers TypeScript, GraphQL, and JSON.

The header's **patch1** link loads the small language demo. **patch2** loads a downloaded snapshot of [graphql-service PR #9658](https://github.com/homebound-team/graphql-service/pull/9658/changes).

```sh
git diff --no-ext-diff --no-color > changes.diff
git diff --no-ext-diff --no-color --cached > staged.diff
git diff --no-ext-diff --no-color main...HEAD > branch.diff
jj diff --git --color=never > changes.diff
gh pr diff 123 --color never > pr.diff
```

Inputs are parsed in your browser. A patch includes only its hunks and supplied context; fetching full files, local-repository integration, and GitHub authentication are not implemented yet. Git's default diff excludes untracked files. Binary patches do not provide readable text changes.

## Read

- The inline diff shows deletions above additions in one column, using the same font size and indentation. Deleted blocks collapse into thin red strips: hover or keyboard-focus a strip to expand the block. Move away to collapse it. Uncheck **Collapse deleted lines** in the top toolbar to keep all old code visible.
- **j / k** move down / up one readable line within the file, centering and outlining the focused line. Collapsed deletion strips are skipped; expanded deleted lines remain navigable.
- Hover over a code line or its gutter for **250ms** to select it in place. Keyboard navigation continues from that line. Moving away, scrolling, or typing cancels a pending hover selection.
- **Shift+J / Shift+K** move to the next / previous change block, including separate edits inside one Git `@@` hunk. Each stop centers and outlines its first added line (or first deleted line for deletion-only changes). Moving beyond a file's last change opens the next file's first; moving before its first opens the previous file's last. Navigation stops at the review's ends and skips files without text changes. Use the file dropdown or arrow buttons to select files directly.
- **n / p** move to the next / previous file and its first hunk, stopping at the review's ends.
- **d** toggles the three nearest deleted blocks above and below the selected line (plus its own block, if deleted). **Shift+D** reveals them only while held, then restores the toggle state. Expansion and collapse keep the selected line at its exact screen position. The revealed neighborhood follows selection; changing files resets the toggle.
- Adjust text from **16–34px**, starting at **22px**.

Pierre handles diff rendering, syntax highlighting, and word-level changes. This first prototype renders one file at a time; very large individual patches have not been optimized.
