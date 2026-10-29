# Biff architecture: current state and true north

Reviewed against the working tree on **2026-10-25**, including the backend thread-action, hunk-approval storage, derived file completion, and optimistic progress refactors. This is a code-based design review, not a claim that every behavior has been exercised. Implementation work is tracked in [TODO.md](TODO.md).

## Executive assessment

Biff is a useful single-user application with substantial domain behavior, built on a small local-daemon stack. Its strongest architectural choices are durable review identity, immutable code snapshots, explicit publication, recoverable GitHub comment receipts, and a shared optimistic-save mechanism.

Its principal weakness is **inconsistent ownership**. The same product operation can follow different rules depending on which screen or API path invokes it. Persistence, domain policy, external integrations, and HTTP handling are often mixed together. React components compensate with independent caches, queues, and refresh events.

The target is a **domain-oriented modular monolith**:

- Backend domain operations own invariants, permissions, durable state, and external-write recovery.
- Frontend features own immediate interaction, drafts, optimistic presentation, and rendering.
- Transport and persistence support those responsibilities; they do not define them.
- One operation has one authoritative implementation across browser, CLI, agent, and worker entry points.

Joist/GraphQL/React is a plausible eventual implementation of this design. We should adopt the domain modeling, explicit relationships, typed contracts, and thin transport boundaries now. An ORM/API migration is not required to make these improvements, and Apollo is not a prerequisite for optimistic UX.

## 1. Current runtime and trust boundary

```text
React SPA ─────────── JSON HTTP / SSE ───────────┐
Biff CLI / agent adapter ─ HTTP / long polling ─┤
                                               v
                                      Bun daemon (one process)
                                      HTTP routes + services
                                        /             \
                                  SQLite/WAL       jj / gh subprocesses
                                                     /        \
                                             working copy     GitHub
```

- `server/index.ts` constructs the services, starts Viewed synchronization, and serves the API and built SPA on `127.0.0.1:4567`.
- `bin/biff.ts` registers local working copies and starts or reuses a daemon. The deployed instance uses the systemd user service instead; see [deploy/README.md](deploy/README.md).
- `server/commands.ts` executes argument arrays directly, captures output, and imposes a 60-second timeout. GitHub credentials stay with `gh`.
- `server/api.ts` checks the request host, configured public origin, and cross-site headers. This is a trusted single-user daemon, not a multi-user application with authenticated domain principals. The public deployment relies on its reverse-proxy/access boundary.
- SQLite lives in `$BIFF_DATA_DIR/inbox.sqlite`. There is one shared `Storage` connection in production. Process-local queues assume a single daemon writer; WAL does not turn those queues into distributed locks.
- [CLIENT_WORKSPACES.md](CLIENT_WORKSPACES.md) describes a future working-copy-provider design. It is a proposal, not the current runtime.

## 2. Backend architecture today

### Module map

| Module | Actual responsibility |
| --- | --- |
| `server/api.ts` | Routing, origin checks, parsing, validation, response mapping, plus several domain workflows and thread serialization |
| `server/discussionApi.ts` | Local thread commands, anchor validation, publication orchestration, GitHub edits/resolution, SSE |
| `server/reviewApi.ts` | Agent-session protocol, session commands, local comment creation, and some duplicated thread rules |
| `server/threadResolution.ts` | Shared resolve/reopen behavior for standalone and agent-session local threads, including GitHub updates and human read receipts |
| `server/progress.ts` (`Progress`) | Review lifetimes, alias discovery/merge, progress, follow-ups, discussions, read receipts, publication coordination, GitHub file-review bookkeeping |
| `server/reviews.ts` (`Reviews`) | Agent sessions, delivery cursors, shared-discussion projection/merge, notifications, long polling |
| `server/inbox.ts` | Cached PR queues/activity, tracking, personal state, undo, auto-archive policy, refresh coordination |
| `server/github.ts` | `gh` adapter, REST/GraphQL calls, permissions, publication deduplication, review preflight, and some cache/policy behavior |
| `server/workspaces.ts` | Workspace registrations, JJ queries, bookmark/base selection, immutable source loading |
| `server/githubViewedSync.ts` | Daemon-driven reconciliation of Biff progress to GitHub Viewed, persisted acknowledgements/errors on the existing review record |
| `server/storage.ts` | SQLite schema setup/evolution, connection ownership, asynchronous serialization |
| `server/hunkApprovals.ts`, `server/migrations.ts` | Targeted approval persistence and ordered upgrades from legacy JSON progress |
| `server/discussionThreads.ts` | Relational threads, messages, logical hunks, anchor evidence, and current attachments |
| `server/threadSync.ts` | Review-draft admission, GitHub thread import, exact-hunk re-anchoring, and publication coordinates |

These are concrete service classes and functions, not a layered entity model. `Progress` is effectively the review domain and repository combined. `Reviews` means agent sessions rather than the same reviews that `Progress` stores. Those names obscure the model.

### The domain model hiding inside the implementation

| Concept | Identity and lifetime | Current storage/source |
| --- | --- | --- |
| Workspace | Registered working-copy ID/path | `workspaces` |
| Review lifetime | Opaque review ID; spans related commits and may link local work to a PR | JSON in `review_records` |
| Local lookup / alias | Bookmark lookup selects a lifetime; aliases address the canonical lifetime | `local_reviews`, `review_aliases` |
| Review snapshot | Immutable base/head, file versions, and selected change range; distinct from lifetime | Response DTOs and agent-session snapshots |
| Hunk/non-text approval | Content identity within a lifetime; coordinates disambiguate duplicate edits | `hunk_approvals`; file completion is derived |
| Thread/message | Stable UUIDs owned by the review lifetime; local, review-draft, or imported GitHub thread | `review_threads`, `review_messages`; local threads are projected into agent sessions |
| Logical hunk / anchor | Content identity plus a side-relative line offset; original evidence survives head changes | `logical_hunks`, append-only `thread_anchors`, mutable `thread_attachments` |
| GitHub thread/comment | GitHub identities and permissions; Biff may attach the thread elsewhere without changing GitHub coordinates | GitHub plus message-level publication receipts and Biff attachments |
| Review draft | PR-wide summary and optimistic concurrency version; comments are independent threads | `review_draft_state`; browser copies provide unsaved-text recovery |
| Comment read receipt | Exact message identity, not a thread-wide read bit | `ReviewRecord.commentReads` |
| Follow-up | Personal flag on a block or canonical thread | `ReviewRecord.followUps` |
| GitHub file-review synchronization | Head/file classification, last acknowledged remote state, errors | `ReviewRecord.githubFileReview`; no standalone `viewed_sync` table |
| Agent session | Conversation attachment, delivery sequences/acknowledgement, expiration | `sessions` |
| Inbox | Cached remote facts plus separate personal decisions | `prs`, `queues`, `inbox_tracked_prs`, `pr_user_state`, `undo`, `preferences` |

The important distinction is **review lifetime ≠ code snapshot ≠ agent session ≠ GitHub PR**. A bookmark name is a lookup, not durable proof of identity. A GitHub Viewed flag is a coarse remote projection, not a replacement for content-based Biff progress.

### Persistence and concurrency

`Storage` uses WAL and short SQLite transactions. Nested domain objects are mostly JSON row payloads. This is a reasonable small-app starting point, but relationships and invariants largely exist in application code rather than schema constraints.

`Progress.transaction()` currently loads the complete review registry, approvals, and aliases, runs an asynchronous callback, and writes changed rows in a SQLite transaction. Several reads use this path and can allocate a review. Approval reads and batch writes now use targeted queries instead; approval reads do not allocate a lifetime. The `progress` serialization key still protects both paths. A callback that awaits GitHub does not hold a SQLite transaction open, but **does hold the application-wide progress queue**.

Other coordination is separate: session writes share the `sessions` queue; GitHub thread commands use a map in `createApi`; publication and Viewed synchronization use their own maps. These locks do not form one canonical per-thread command boundary. `Progress` instances sharing a `Storage` also share discussion listeners, so inbox synchronization wakes attached browsers and agents.

Review/session mutations can update the durable discussion and then save the session in separate commits. Recovery/projection can repair some differences, but this is not an atomic unit of work spanning both records.

### External state and jobs

- GitHub owns remote PR facts, published content, and actual thread permissions/resolution. Biff owns local notes, review intent, personal inbox decisions, receipts, and synchronization intent.
- Comment publication stores intent and uses stable hidden markers to recover remote success after a lost response. This is a useful pattern to preserve.
- The Viewed worker polls registered review state every 15 seconds, imports remote marks when preparing a new head, and persists acknowledgements/errors. PR progress mutations wake it; linked local changes are found by polling.
- Initial review loading still awaits `GitHubViewedSync.prepare()`, including remote preparation/synchronization. Background ownership therefore does not yet mean navigation is independent of remote writes.
- Viewed synchronization compares local intent with its last acknowledgement; it does not continuously reread same-head GitHub changes. Import/conflict policy and head/base races need explicit treatment.
- Inbox refreshes are backend-deduplicated but demand-driven: reading queues can schedule refreshes and archive decisions. It has no independent daemon-wide refresh timer.
- SSE delivers discussion/session snapshots; session long polling separates delivery from acknowledgement. Ordinary GitHub conversations are loaded on request and periodically refreshed by the browser.

## 3. Frontend architecture today

### Composition

`src/main.tsx` provides Wouter routes, reading settings, global background-save feedback, and an error boundary. `Reviews.tsx` loads workspace/PR data and wires feature adapters into `Viewer.tsx`. `WorkspaceCollaboration.tsx` attaches agent sessions to the same viewer.

`Viewer.tsx` is the major integration point: patch parsing, progress, follow-ups, file and line navigation, URL state, source hydration, comment jumps, search, import/deletion expansion, animation, and rendering. Pierre Diffs supplies the diff rendering/highlighting substrate. Modules such as `DiffSurface`, `diffViewport`, `importGroups`, and `navigation` encapsulate parts of the renderer, but the viewer still coordinates many independent lifecycles.

Comment surfaces adapt local, GitHub, and session data into `LineThread` UI models. `FileComments`, `PullRequestComments`, and the composers share presentation primitives, but not all command implementations. `ModalHeader`, shortcut scopes, and native dialog ownership are useful established conventions.

### Four kinds of state

| State | Current examples | Intended owner |
| --- | --- | --- |
| Authoritative domain state | Progress, receipts, threads, follow-ups, inbox decisions | Backend; FE holds a projection |
| Pending intent | Queued resolution/read actions and comment submissions | Shared FE mutation registry until backend acknowledgement |
| Drafts/preferences | Unposted composer text, typography; browser recovery copies of review drafts | Composer/preferences remain browser-local; saved review comments and summaries belong to the backend |
| Interaction/render state | Focus, selected line, scrolling, peeks, folded regions, open panel | FE component/controller; URL where navigation should be shareable |

The source diff is immutable input. A hydrated renderer object is not a new authoritative review snapshot. Async parsing/hydration must not restore obsolete navigation or selection.

### Loading, caching, and optimistic saves

- `src/api.ts` is a fetch wrapper plus component-local `useResource`. Its generic return type is a cast, not runtime contract validation. Refresh clears its current data.
- Feature hooks compensate with `saved`/`updated` state. `useLocalDiscussion` compares discussion versions; `useInbox` sequences requests; `useConversation` retains data but does not version it against mutation acknowledgements.
- Refresh uses a mixture of polling, focus listeners, SSE, DOM events, and `BroadcastChannel`. These are useful delivery mechanisms but do not provide a shared authoritative cache or uniform stale-response policy.
- `optimisticSave.ts` owns module-level keyed queues and append submissions. It preserves work across SPA unmounts, serializes each key, retains retry information, and prevents an older failure from undoing a newer intent. `BackgroundSaveStatus` handles feedback and reload warnings.
- These queues are **in memory**, not a durable offline outbox. Closing/reloading the page can lose unacknowledged operations; the warning is intentional.
- Progress now uses shared optimistic queues: Space advances immediately, file/hunk writes serialize per file, unrelated files proceed independently, and failed mutations retain a real Retry after navigation. Adoption is still incomplete for follow-ups, local/session composers, and standalone thread resolution, which retain foreground saves.
- Queue scopes generally use endpoints. Local/PR/session URLs can refer to the same durable entity but create separate optimistic queues.

## 4. Responsibility rules (the target contract)

| Concern | Backend responsibility | Frontend responsibility |
| --- | --- | --- |
| Identity | Resolve canonical lifetime/thread/message IDs and aliases | Use returned IDs; retain route/source context separately |
| Snapshot validity | Validate base/head, source membership, anchors, and content identities | Send the exact displayed snapshot; explain stale-snapshot errors |
| Permissions | Enforce author/actor and GitHub capabilities | Hide/disable unavailable actions; never make enforcement optional |
| Read state | Persist exact displayed-message receipts and bot policy | Decide when the reader explicitly acknowledges; preview only those IDs |
| Resolve/complete | Execute combined domain effects; owned completion may resolve when permitted | Optimistically preview, advance immediately, retain retry intent |
| Hunk completion | Own per-hunk reviewed state; derive file completion from its hunks; a file-level action batches hunk updates | Select the target and preview those hunk updates and derived file state immediately |
| Follow-up | Persist flag and coupled completion as one command | Preview both effects and retain selection on failure |
| Publication | Validate snapshot, deduplicate submission, recover remote receipts | Preserve each submitted draft and show pending vs published honestly |
| External sync | Persist intent/status, schedule/retry, reconcile remote acknowledgements | Display status and request retry; mounting a screen must not perform the job |
| Inbox | Own eligibility, read/activity policy, archive/snooze/undo and refresh policy | Filter/sort presentation, keyboard focus, stable row order |
| Agent delivery | Own session attachment, cursor ordering, acknowledgement and replay semantics | Agent adapter transports feedback; UI displays shared discussion |
| Rendering | Supply immutable inputs and domain classification | Own pixels, virtualization, selection, focus, URL navigation, animations |

Shared pure code is appropriate for deterministic projections and optimistic previews. Sharing a function does not give the browser authority to invent its inputs or bypass server validation.

### Progress: hunks are authoritative; files are derived

The browser calculates hunk identities and submits reviewed/unreviewed state; file actions batch the displayed hunks. The backend validates payload shape and review scope and persists the batch atomically. It does not reconstruct the diff for each write. Approvals belong to the durable review and match content across diff versions. Comparison receipts, signing keys, and review-version records are unnecessary for this contract.

The target model has one reviewed yes/no value per reviewable hunk. Here, “hunk” means Biff's individual change block, which can be smaller than a Git `@@` section. A file is reviewed when all its reviewable hunks are reviewed. There is no independent Biff file approval that can override an unreviewed hunk.

Persist **approvals**, not hunks: move the existing approval fields (`path`, content `hash`, duplicate coordinates, `head`, and `reviewedAt`) into a dedicated `hunk_approvals` table owned by the canonical review ID. A matching row means reviewed; absence means unreviewed. Reconstruct hunks from available diffs and retain the existing content-matching semantics. Do not add stored hunk content or retained diff snapshots for progress tracking. If an old comparison can no longer be loaded, report that limitation rather than silently applying its action to the latest diff. Existing agent-session snapshot storage is a separate concern; this decision does not introduce a new historical archive.

- **Mark file reviewed** means mark all its reviewable hunks reviewed in one operation.
- **Mark file unreviewed** means clear those hunk approvals in one operation.
- Changing one hunk affects that hunk's approval and the derived file result. Unchanged hunks retain approval under the content-matching rules.
- GitHub's Viewed flag is an external projection of the derived file result. Its last acknowledgement/error is synchronization bookkeeping, not another Biff review decision. Importing a GitHub Viewed mark must translate into hunk approvals for the corresponding comparison.

Legacy explicit file approvals (`kind: "file"`) remain only as migration evidence in review JSON. They are not returned as current approvals and cannot short-circuit the hunk calculation. Loading an exactly matching comparison translates that evidence into review-unit approvals; a new progress write discards legacy evidence for the affected file so it cannot resurrect cleared approvals.

Binary changes, renames, and mode changes use a `metadata` review unit per file, separate from text hunks and included in the file action. Its identity captures the non-text change; binary/no-text units include blob evidence (or the head when blob IDs are absent). Text edits do not invalidate an unchanged rename/mode approval. Files with no reviewable units are complete; generated-file exclusions remain policy-derived. Non-text units are currently controlled through the file checkbox rather than a separate hunk UI.

### Discussions: thread identity is not a GitHub coordinate

Saved review comments are relational threads, not per-commit browser draft blobs. A thread anchor links to a logical hunk and records a LEFT/RIGHT offset, selected text/range, and original snapshot evidence. Explicit re-anchoring appends evidence; automatic following updates only the current attachment. No retained whole-diff archive is needed.

PR synchronization notices changed head/base comparisons and matches the same semantic change fingerprints used by review progress. Exact, unambiguous matches follow line shifts. When neighboring edits change a fingerprint, unique selected text in the same file (including a recorded rename) can recover the attachment. Missing, changed, or ambiguous selected code leaves the thread visible as needing re-anchoring in Comments. Draft text is persisted before fetching historical diffs, and publication admits missing drafts before translating their locations. A head change never deletes its text. A second metadata check prevents a slow obsolete comparison from installing stale locations.

The same attachment rule applies to imported GitHub discussions. Biff retains the original GitHub comment/thread IDs, links, permissions, and reply/resolve targets while showing its own current location. Moving an attachment inside Biff does not pretend to move the comment on GitHub.

Draft edits are optimistic and version-checked on the server. A stale tab cannot replace newer saved text. Browser-only legacy comments migrate additively with deterministic IDs and import receipts, so retries cannot resurrect submitted notes. Background review submission uses a stable retry marker; only acknowledged submitted text leaves the active draft. Unmatched comments remain unsent and visible, and an approval cannot silently omit them.

### Example: complete a thread

1. UI snapshots the displayed message IDs and immediately previews them read, advances focus, and previews resolution if eligible.
2. A typed command names the canonical thread, actor/context, displayed IDs, and submission identity where needed.
3. The application service resolves aliases and serializes against other commands for that thread, regardless of entry point.
4. Domain rules determine ownership/permissions and effects. The GitHub adapter performs a needed remote mutation; local receipts are committed with acknowledged local state.
5. The response includes affected canonical state, capabilities, receipts, and a revision. The shared FE resource layer applies it without replacing newer state for another entity.
6. A failure retains retry intent. A new reply never inherits the earlier displayed-message acknowledgement.

SQLite and GitHub cannot share a transaction. If GitHub succeeds and Biff loses the response or crashes before its local commit, recovery must inspect/retry idempotently. Do not describe that sequence as atomic remote-and-local persistence.

## 5. True north practices

### Domain-first backend, thin transports

Organize by recognizable concepts and use cases: review lifetimes, snapshots/progress, discussions/publication, inbox, and agent sessions. Commands such as `completeThread`, `resolveThread`, `markFileReviewed`, and `publishMessages` should be callable without constructing a `Request` or running React.

HTTP handlers validate/translate wire input, invoke a command/query, and map errors/results. Domain operations enforce invariants. Repositories own SQL and atomic persistence. Adapters own JJ/GitHub protocol details. Workers call the same domain operations. Avoid generic CRUD setters for coupled behavior and avoid a forest of pass-through service/repository wrappers.

Suggested dependency direction (logical boundaries first, folders when useful):

```text
HTTP / CLI protocol / workers -> application commands -> domain policies
                                        |
                              persistence + external ports
                                        |
                               SQLite / GitHub / JJ adapters

React features -> typed API/resource layer -> server
React renderer -> pure snapshot/classification helpers
```

Neither server domain code nor contracts should import from `src/`. Shared classification should live in a browser-independent module, with renderer-specific coordinates added separately.

### Explicit identity and a real unit of work

Use canonical IDs for domain operations and queue keys. Keep route aliases and GitHub IDs as explicit references. Model relationships and lifecycle rules instead of inferring entity kinds from arbitrary string prefixes throughout the app.

Read only the necessary records; commit related local changes together. Keep network calls outside database transactions **and outside unrelated entities' serialization queues**. Resolve aliases before selecting locks. Define ordering/conflict behavior across tabs rather than assuming browser queues provide server concurrency control.

JSON columns are acceptable for cohesive snapshot/value data. Extract independently addressed or growing entities when their relationships, updates, or constraints justify it. Use versioned, testable migrations. Do not introduce a table merely because a worker needs bookkeeping; name and place state according to its domain lifecycle.

### Typed, versioned operation contracts

Define command inputs, runtime validation, result shapes, and structured errors centrally. Return the affected canonical projection with revision information. Expected conflict/permission/validation/upstream failures should not all become HTTP 400 strings.

Queries should normally be reads. Where loading discovers a review or refreshes a remote cache, make that boundary explicit and idempotent. A GET must never accidentally acknowledge human reading or publish content. Existing bot ingestion receipts are an explicit domain policy, not human read acknowledgement.

A single database snapshot can make local fields coherent; GitHub responses plus local receipts are not automatically a cross-system atomic snapshot. Define merge/revision semantics accordingly.

### One server-state and mutation model on the frontend

Keep one canonical resource view per entity and apply ordered acknowledgements there. Polling/SSE/focus/broadcast events trigger refresh or deliver versioned data; they should not each implement their own reconciliation policy.

Keep the existing optimistic-save behavior as a requirement. Reversible actions update immediately, navigation does not await saves, failures remain visible with real Retry, and stale results cannot undo newer intent. Keyed setters may coalesce; additive submissions must preserve every submitted item and deduplicate on the backend. A resource refresh failure must not roll back a successful mutation.

Use typed intents, not JSON strings and random fields merely to force a value queue to behave like a command queue. Distinguish a pending preview, a Biff acknowledgement, and a GitHub acknowledgement in both contracts and UI.

Non-idempotent publication deserves explicit submission/recovery semantics; moving it to a background promise alone is insufficient. Durable browser offline queues are a separate product decision, not something this architecture currently promises.

### Observable, recoverable background work

Persist desired state and remote receipts with their owner. Schedule independently of mounted screens, bound concurrency, back off failures, and make retries inspectable. Reconcile stale snapshot/head/base changes and define what happens when a person changes the same flag directly in GitHub.

Shutdown should stop admission, stop timers, and drain admitted writes before closing storage. Log operation/entity context and distinguish loading failures, mutation failures, and synchronization failures.

### Small feature controllers, deliberate rendering complexity

Split the viewer by lifecycle and ownership: review resource/commands, navigation/selection, hydration, and renderer integration. Keep interaction state local where possible. Do not replace one giant component with a giant hook that has the same coupling.

Domain DTOs should not expose a renderer's mutable internal object graph. Maintain precise adapters for immutable diff input, source hydration, and render coordinates. Preserve current stale-render guards and real-browser coverage when extracting these pieces.

### Tests at the authoritative boundary

- Pure tests: identity matching, classification, unread policy, optimistic projections.
- Backend tests: real SQLite plus controllable external adapters; call actual application commands/API. Cover aliases, permissions, concurrency, lost responses, restart recovery, and atomic local effects.
- Browser tests: held requests, immediate state/navigation, rapid reversals, modal dismissal/remount, failed-save retry, and renderer focus/scroll behavior.
- A small end-to-end slice should use the real Biff API with fixture-backed GitHub. A browser mock that reimplements thread policy cannot prove the backend rule works.
- Test fixtures should share contract shapes, not reproduce production algorithms. Keep test ports/databases isolated from the live service.

## 6. Current architectural debt

These are observed code paths or design limitations, not hypothetical reasons to change stacks. The corresponding cleanup IDs are in [TODO.md](TODO.md).

| Finding | Evidence and consequence | Cleanup |
| --- | --- | --- |
| Business rules still live in some transport handlers | `api.ts` owns GitHub complete/resolve and `discussionApi.ts` owns publication; local resolution and edit/delete now use shared functions | B1 |
| Thread ownership cleanup is partial | Standalone and session resolve/reopen and edit/delete share implementations; reply/publication coordination remains separate | C1/B1 |
| Read snapshot contract is permissive | `receiptSnapshot(undefined, available)` acknowledges all fetched messages; general receipt POST validates shape, not membership | C2 |
| Broad registry lock and full-registry reads | `Progress.transaction()` scans all reviews even for common reads; remote work inside discussion edits blocks unrelated progress | B2 |
| Split session/discussion ownership | `Reviews.update()` merges copied threads, saves discussion, then saves session; rules and commits span two owners | B3 |
| Shared classification still carries render coordinates | Fingerprinting/import classification now live under `shared/`; `ChangeBlock` still combines domain identities and renderer coordinates | B4 |
| Progress intentionally accepts client-calculated identities | Backend validates payload shape and review scope, then atomically persists approvals; diff membership verification is not required | C3 (complete) |
| Optimistic convention only partially adopted | Progress is migrated; `useFollowUps`, local/session composers, and `ThreadResolution` retain independent busy/error logic | F1–F2 |
| Commands squeezed into a value queue | `useThreadResolutions` serializes intent to JSON with a random request field and empty-string confirmed values | F3 |
| Multiple caches and invalidation conventions | `useResource`, `useConversation`, `useLocalDiscussion`, receipts, inbox, broadcasts, and SSE each handle freshness differently | F4 |
| Queue identity follows routes | Endpoint-scoped pending state can split one linked review/thread across local, PR, and session views | F3 |
| Viewed worker is an initial implementation | Cached acknowledgements, awaited preparation, bypassing `/viewed` POST, fixed polling, and incomplete snapshot/conflict policy | C4 |
| Append retry guarantees vary | GitHub comments have marker recovery; local create/reply and whole-review submission lack the same submission-ID contract | C5 |
| Composition and lifecycle are implicit | Optional production services, nested `new Progress` in Inbox, and no shutdown wiring in `index.ts` | B5 |
| Wire contracts and errors are ad hoc | Per-route parsing, `unknown` payloads, generic casts, broad 400 catch | B6 |
| Original schema evolution is still constructor logic | Approval extraction uses an ordered migration; older schema detection/DDL/backfill remain in `storage.ts` | B7 |
| Viewer is a cross-feature coordinator | `Viewer.tsx` mixes domain mutations, route state, hydration, rendering, focus, search, and animation | F5 |
| Tests/docs have drifted from behavior | Browser expectations still reference old comment counts/toolbar labels; README still mentions filesystem progress storage | Q1–Q2 |

## 7. Eventual Joist / GraphQL / React direction

The preference is for an application whose domain is easy to understand by reading explicit entities, relationships, operations, and typed client queries. That preference should shape today's boundaries.

- A future entity model could represent review lifetimes, workspace associations, threads/messages, approvals, receipts, and agent sessions explicitly. Entity validations/derived values and a unit of work should replace scattered cross-record invariants, not merely wrap JSON blobs in ORM classes.
- GraphQL could replace transport DTO plumbing with a schema and generated operation types. Resolvers should invoke the same commands; mutations should express user intent and return changed state/capabilities, rather than exposing unrestricted entity setters.
- Do not route every piece of a large immutable diff through a normalized graph solely for consistency. Bulk patch/source loading can retain a dedicated transport if measurement justifies it.
- React remains the interaction layer. Select a query/cache integration based on stale-response correctness and optimistic behavior. Apollo's normalized cache does not automatically solve ordered writes, rollback, or durable external sync; an explicit mutation-intent layer may still be necessary.
- Joist adoption requires a separate storage/runtime/schema decision, migration plan, and recovery tests. GraphQL adoption requires an API contract decision. Neither decision should be smuggled into a cleanup ticket.

**Migration readiness is the near-term goal:** commands independent of HTTP, repositories independent of UI, explicit IDs/relationships, typed operation results, and tests at those boundaries. Then changing infrastructure is an implementation choice rather than rediscovering the business rules.

## 8. How to use this document

For a new feature, identify its domain owner, command/query contract, canonical identity, snapshot rules, failure/retry semantics, and UI preview before adding effects or another cache. Apply these rules to touched flows; use TODO IDs for existing exceptions.

Read `README.md` for user behavior, `PR_STATUS.md` for inbox semantics, `AGENTS.md` for implementation/deployment conventions, and `TODO.md` for sequenced remediation. Update this document when a boundary or ownership decision changes, rather than leaving the target described as if it were already implemented.
