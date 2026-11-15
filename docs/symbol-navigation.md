# Symbol navigation

Reviews support **Ctrl/Cmd+O** to search declarations, and **Ctrl/Cmd-click** to follow an exact identifier name. Hold the modifier to underline known names. Comments and strings intentionally support the same navigation. Ambiguous names open a chooser; **Back** or **Alt+Left** returns to the original source line.

The picker defaults to Head; choose Base for removed or historical declarations in the displayed comparison. Navigation expands omitted context and folded imports when necessary. Scope is the changed files' complete source, not the whole repository. This is name-based navigation, not type-aware reference resolution.

## Extraction and storage

- The backend uses the pinned npm dependency `@ast-grep/cli` and its Rust `outline` command. No global executable or LSP is required.
- `bun install` must include optional platform dependencies. The package's trusted postinstall installs its native executable.
- Extraction uses bundled outline rules for top-level declarations and their members. Language coverage and nested-declaration coverage follow ast-grep's outline support; unsupported files contribute no declarations.
- Each invocation reads only the supplied old/new source files in a temporary directory, with an explicit empty configuration and custom language loading disabled. It never scans a checkout or loads the repository's configuration.
- `symbol_indexes` has a synthetic ID and a review foreign key. Rows are unique by review, explicit comparison tuple, current/previous path, and indexer version. There is no content-addressed cache or repository-wide symbol index.
- Files larger than 2 MB report a retryable indexing error; binary files contribute no symbols. Very long rendered lines skip speculative underlining rather than creating a large main-thread task.

## Non-blocking loading

The viewer waits for its first prepared diff's paint opportunity before requesting symbol work. The API returns an admission response without awaiting source loading or extraction. One background worker loads and indexes one file at a time, uses a single parser thread, shares existing GitHub source requests, and yields between files. Completed file indexes persist in SQLite; failed files can be retried without reparsing successful cached files.

The browser polls progressively and discards responses from obsolete comparisons. Clicks and hover use an in-memory name lookup with no network request. Underlining processes mounted rows in idle batches and uses native highlight ranges rather than changing Pierre's text DOM. Historical reference panes do not use the current comparison's index.

## Dependency licenses

ast-grep 0.51.2 is [MIT-licensed](https://github.com/ast-grep/ast-grep/blob/0.51.2/LICENSE). Tree-sitter is MIT-licensed. The Tree-sitter packages listed in that release's Cargo.lock declare MIT licenses except `tree-sitter-elixir` and `tree-sitter-hcl`, which declare Apache-2.0. These are permissive licenses; this check is not a complete redistribution-notice audit of every Rust dependency.

Keep applicable upstream copyright/license notices when redistributing the native binaries, and recheck licenses and outline output when upgrading the pinned dependency.
