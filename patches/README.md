# Pierre host-fold patch

`@pierre/diffs` is pinned to **1.5.2**. Bun applies the adjacent patch through
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

Supported: non-virtualized, read-only, unified `FileDiff`, as used by Biff.
Split views, finite render ranges, and editing reject active folds explicitly.
General virtualizer height estimation and native annotations inside folded ranges
are not supported by this experiment. Biff's own comment overlay uses original
source coordinates and explicitly expands a fold when jumping to a comment.

This removes DOM/layout work and creation of hidden import rows. It does **not**
avoid Pierre's earlier syntax-tokenization work. Classification can also require a
full-source fetch for a partial import declaration; Biff waits before mounting the
renderer and reuses that request for native context loading.

## Updating

Review the four patched dependency files on each upgrade. Do not loosen the pinned
version without rebasing the patch. Keep the native separator structure, grid row
count, and original coordinates intact.

Checks:

```sh
bun install --frozen-lockfile
bun test bun-tests/importGroups.test.ts bun-tests/hostFolds.test.ts
bun run test:e2e --grep 'Import folding'
bun run build --logLevel error
```

`bun patch --commit` can include unrelated package-manager cache markers or bundled
type-file removals. Review the patch and remove those artifacts before committing.
