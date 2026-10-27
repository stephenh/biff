# Pierre word-diff and host-fold patch

`@pierre/diffs` is pinned to **1.6.2**. Bun applies the adjacent patch through
`package.json`'s `patchedDependencies`; `bun install --frozen-lockfile` reproduces it.

The design follows the host-defined range request in
[pierrecomputer/pierre#1146](https://github.com/pierrecomputer/pierre/issues/1146).
This is a local experimental implementation, not that author's prototype or an
upstream-supported API.

## Responsibility split

- Biff parses TypeScript and caches import regions by source/metadata version in
  `src/importFolds.ts`. Expansion state uses original old/new source coordinates.
- `resolveFoldedRanges(file)` supplies sorted, non-overlapping inclusive **unified
  indexes** for the renderer's actual metadata. This callback also runs after native
  full-source hydration; cached classification makes repeated calls inexpensive.
- Pierre's normal render iterator emits a native-style separator for each range.
  Collapsed line nodes and their gutters are never emitted; the separator adds one
  rendered grid row. Original source coordinates remain unchanged.
- Biff receives ordinary bubbled button clicks through `data-fold-toggle`, changes
  controlled expansion state, and supplies a new resolver callback identity.
  No import folding traverses or modifies the browser's rendered rows.
- Biff's existing DOM-based scrolling, comment previews, and deletion strips remain
  separate from import classification and folding.

## Scope and tradeoffs

Supported: read-only, unified `FileDiff`, including Pierre's native virtual windows.
Split views and editing reject active folds explicitly. Biff's own comment overlay
uses original source coordinates and explicitly expands a fold when jumping to a comment.

Pierre provides virtualization. Our `VirtualizedFileDiff` changes account for the
rows and separator heights introduced by host folds, including incremental window
trimming. The remaining layout fixes notify the virtualizer after font metrics
change, reconcile CSS-expanded deletion strips, and clamp overscan at EOF to avoid
rebuilding an unchanged window.

This removes DOM/layout work and creation of hidden import rows. It does **not**
avoid Pierre's earlier syntax-tokenization work. Classification can also require a
full-source fetch for a partial import declaration; Biff waits before mounting the
renderer and reuses that request for native context loading.

## Highlighting and word diffs

`src/diffHighlights.ts` selects Pierre's built-in Highlights backend. We no longer
patch cross-renderer syntax caching or speculatively highlight every review file.
Pierre retains its own renderer cache and lazy off-screen row construction.

The `word-block` patch compares small uneven replacement blocks across line breaks,
then passes its spans through Pierre's native decoration pipeline. Large blocks use
native `word-alt` highlighting. The patch also keeps opt-in `onDiffTiming` diagnostics
for syntax, word comparisons, row assembly, serialization, and DOM commits.

## Updating

Review every patched dependency file on each upgrade. Do not loosen the pinned
version without rebasing the patch. Keep the native separator structure, grid row
count, and original coordinates intact.

Checks:

```sh
bun install --frozen-lockfile
bun test bun-tests/importGroups.test.ts bun-tests/hostFolds.test.ts bun-tests/blockWordDiff.test.ts bun-tests/diffHighlights.test.ts bun-tests/fullSourceDiff.test.ts
bun run test:e2e tests/imports.spec.ts tests/virtualization.spec.ts tests/syntax-highlighting.spec.ts tests/frozen-diff.spec.ts
bun run build --logLevel error
```

`bun patch --commit` can include unrelated package-manager cache markers or bundled
type-file removals. Review the patch and remove those artifacts before committing.
