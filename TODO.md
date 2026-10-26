# Architecture cleanup

Companion to [ARCHITECTURE.md](ARCHITECTURE.md), reviewed **2026-10-25**. These are proposed cleanup tasks, not changes implemented by this review. Priorities describe sequencing: **P0** correctness/recovery boundaries, **P1** consistent ownership and UX, **P2** maintainability/operations. IDs are stable so follow-up work can refer to them.

Keep each change feature-sized. Preserve immutable snapshots, review identity, drafts, publication receipts, keyboard behavior, and persisted data. Avoid a wholesale stack rewrite.

### Implemented progress slice (2026-10-25)

- [x] Extract hunk approvals into a dedicated table with an ordered migration, preserved timestamps, and atomic linked-review merges. Hunk content/diff snapshots are not added to storage.
- [x] Derive file completion from text and non-text review units. File actions batch unit updates; legacy file evidence is translated only against matching comparisons and never overrides current approvals.
- [x] Move progress saves to shared optimistic queues with immediate navigation, per-file ordering, independent other-file saves, rollback, and retained Retry across SPA navigation.
- [x] Share completion policy and move fingerprint/import classification out of `src/` for backend callers.

The wider tickets remain open: F1 still includes follow-ups; B2 still includes the broad registry lock; F3/F4 still cover canonical cross-route queues and unified resource freshness. Progress accepts client-calculated hunk identities; server-side diff reconstruction and review-version records are not required.

## Recommended sequence

1. Establish trustworthy focused tests (Q1), then unify thread command semantics (B1/C1/C2).
2. Make append retries safe (C5) and close the Viewed synchronization policy gaps (C4).
3. Finish shared classification cleanup (B4), then migrate follow-ups to optimistic saves (F1).
4. Introduce canonical mutation/resource identity (F3/F4), then finish composer adoption (F2).
5. Narrow persistence locks and clarify session ownership (B2/B3/B5), with migration infrastructure (B7) before structural schema changes.
6. Extract viewer controllers and complete contract/operations cleanup (F5/B6/Q2/Q3).

These tracks can overlap when their contracts are explicit. Do not hold correctness fixes until every structural task is complete.

## P0 — correctness and recoverability

### C1 — One thread command across standalone reviews and agent collaboration

- [ ] Route equivalent resolve/reopen/reply/edit/delete operations through one application boundary.
- **Entry points:** A standalone bookmark/PR review uses the workspace or GitHub discussion APIs (`discussionApi.ts` and `api.ts`). A review opened with `/biff` has an attached agent session: its browser UI and `biff review` CLI commands use `/api/reviews/<session-id>/...` (`reviewApi.ts`). Both can address the same durable local thread; attaching an agent should not change that thread's rules.
- **Completed slice:** Standalone and agent-session resolve/reopen call `resolveDiscussionThread`. Published threads update GitHub before local state commits; only human resolution records read receipts. Route tests cover reopening, remote failures, and agent/human receipt behavior.
- **Remaining evidence:** `server/reviewApi.ts` still constructs a `Request` to reuse edit/delete handling in `discussionApi.ts`. Reply handling, thread locks, and publication locks remain separately scoped.
- **Change:** Resolve canonical thread identity first; define actor-specific human vs agent behavior explicitly. Preserve the rule that completing somebody else's GitHub thread reads it without resolving it. Make published-thread behavior consistent across entry points and decide how replies affect remote resolution.
- **Done when:** Tests exercise equivalent commands through both the standalone bookmark/PR APIs and the agent-session API, verify remote/local outcomes and displayed receipts, and hold concurrent operations against the same canonical thread. Unrelated threads proceed independently.
- **Dependency:** Extract the relevant command from B1 as part of this work, rather than adding another route-to-route call.

### C2 — Make displayed-message acknowledgement an explicit contract

- [ ] Require human resolve/complete/read commands to include the IDs of the messages the reader is acknowledging; define compatibility behavior for existing CLI callers.
- **Example:** The loaded thread contains comments A and B when the reader presses Space. The request includes A and B's IDs. If reply C arrives before the server processes the request, only A and B become read; C stays unread. This fixed list is the message snapshot—not a screenshot, and not a claim that scrolling past a message proves it was read. Retrying the action must use the same list.
- **Evidence:** `server/commentReadsApi.ts` defaults omitted keys to all available messages. Its standalone POST accepts arbitrary bounded strings. `useCommentReads` still independently fetches receipts even when its parent response includes them.
- **Change:** Validate key shape and bounds, not current message existence. Accept deleted-after-display IDs without rejecting the remaining receipts or acknowledging later replies. Distinguish automatic bot ingestion, human acknowledgement, and agent resolution; map local/published message identities consistently.
- **Done when:** Missing/invalid snapshots cannot silently read newly arrived feedback; a held command leaves late replies unread; local/PR/session views agree after publication and retry. Compatibility is documented and tested.

### C3 — Make hunk approvals authoritative and file completion derived

- [x] Keep reviewed yes/no state per reviewable hunk. Derive file completion from all its hunks; replace independent Biff file approvals with batch hunk updates.
- **Storage decision:** Store only approvals in a dedicated `hunk_approvals` table, with the canonical review ID plus the existing approval POJO fields. Do not persist individual hunks, hunk content, or diff snapshots for progress tracking. Derive hunks from available diffs; a matching approval row means reviewed, and absence means unreviewed. Preserve duplicate-aware matching rather than assuming `(review_id, path, hash)` alone uniquely identifies an approval.
- **First implementation slice:** Add an ordered migration for existing hunk approvals, targeted persistence methods, and atomic approval merging when review aliases are joined. Preserve current behavior initially, keeping legacy file approvals until the file-action conversion is ready. Test restart persistence, matching after line shifts, duplicate edits, clearing, and linked-review merging before changing UI behavior.
- **Rule:** Marking a file reviewed marks all its reviewable hunks reviewed. Clearing the file marks those hunks unreviewed. No file flag can override an unreviewed hunk. “Hunk” here means Biff's individual change block, not necessarily an entire Git `@@` section.
- **Request contract:** The client supplies hunk identities and reviewed state. The backend validates payload shape and review scope, then persists the batch atomically. It does not reconstruct a diff to verify membership.
- **File actions:** The client batches the hunks from the displayed file. New edits have different identities and remain unreviewed; unchanged hunks retain approvals through content matching.
- **Ownership:** The durable review owns approvals. Neither comparison receipts nor review-version records are needed for personal progress. An unmatched identity does not mark unrelated content reviewed.
- **Implemented:** Separate approval storage, legacy migration, derived file completion, explicit metadata hunks, and optimistic per-file saves with retained Retry. Follow-up flagging and hunk completion remain one backend transaction.
- **Dependency:** B4; preserve existing identity fingerprints unless an explicit data migration is supplied.

### C4 — Finish the Viewed synchronization contract

- [ ] Make reconciliation policy explicit and independently schedulable, with reliable status/recovery.
- **Evidence:** `server/githubViewedSync.ts`, `/viewed` and `/review` routes in `server/api.ts`, `src/GitHubViewer.tsx`.
- **Change:**
  - Derive outgoing GitHub Viewed state from hunk completion. Translate imported Viewed marks into approvals of the corresponding hunks, not an independent Biff file flag. GitHub acknowledgement/error state remains synchronization bookkeeping.
  - Decide whether same-head GitHub changes are imported, ignored, or reconciled with Biff intent; do not let cached acknowledgement accidentally choose policy.
  - Track sufficient base/head/snapshot identity; test target-branch movement and head changes during preparation/writes.
  - Separate required snapshot preparation from remote write completion so review navigation does not await GitHub synchronization.
  - Remove or route direct `/viewed` writes through the same authority after auditing callers.
  - Define retry/backoff, wake-up behavior after a reversal during a held write, and closed-review lifecycle.
  - Persist preparation failures where retry/status can expose them; handle detached task failures and shutdown.
- **Done when:** Restart, lost response, alias merge, linked local writes, direct GitHub changes, head/base movement, failed initial preparation, and rapid reversals have explicit tested outcomes. Opening a browser is not required for admitted work to complete. State remains on the review record unless a separately justified domain model replaces it.

### C5 — Consistent idempotency for append/publication operations

- [ ] Add stable submission identities and recovery semantics to local comment creation/replies, session message operations, and whole GitHub review submission.
- **Evidence:** Local/session routes generate new message IDs on each request; `GitHub.submitReview` directly writes a review. GitHub comment writes and local-message publication already have marker recovery patterns.
- **Change:** Persist deduplication receipts for local commands. For GitHub review submission, investigate available recovery evidence and explicitly represent an uncertain outcome rather than automatically resending an unsafe append. Keep each submitted payload stable while allowing a later draft to evolve independently.
- **Done when:** A server commit followed by a lost response/restart produces one logical submission on retry. A failed earlier submission does not erase a newer draft. Existing per-message publication markers continue to recover partial success.
- **Dependency:** Required before moving these append paths into background submissions in F2.

## P1 — backend boundaries

### B1 — Extract application commands from HTTP handlers

- [ ] Move thread, discussion/publication, and session use cases out of `api.ts`, `discussionApi.ts`, and `reviewApi.ts`.
- **Change:** Introduce focused domain/application modules with typed arguments/results. Keep host/origin checks, wire parsing, and response mapping in transport. Replace `reviewApi`'s fabricated `Request` to `discussionApi` with a command call. Name the durable review owner and agent-session owner distinctly; `Progress` and `Reviews` currently hide that distinction.
- **Done when:** Browser, CLI/session, and worker entry points can call the same operations without HTTP objects. Rules have one implementation and boundary tests. Extraction does not create empty wrapper layers.

### B2 — Narrow review persistence and serialization

- [ ] Replace common whole-registry loads with targeted reads/writes and explicit lookup-vs-create operations.
- **Evidence:** `Progress.transaction()` loads all review records/aliases under one `progress` queue, including read paths. Published edits/resolution can await remote work within that queue.
- **Change:** Introduce focused persistence operations; keep alias merge atomic. Use canonical per-entity ordering and revisions/conflict checks where asynchronous external work separates read and commit. Never hold unrelated review operations behind a GitHub request.
- **Done when:** A held remote edit in review A does not block reading/updating review B. Concurrent alias merge/removal cannot resurrect approvals or lose comments. Querying an unknown review does not allocate it except through an explicit get-or-create contract.

### B3 — Clarify canonical discussion versus session projection

- [ ] Make agent sessions reference/project the canonical discussion instead of being a competing thread mutation model.
- **Evidence:** `Reviews.syncDiscussion`, `mergeThreadEdits`, and `Reviews.update` copy threads and coordinate separate discussion/session saves.
- **Change:** Keep per-session delivery sequences, acknowledgement, and finished-snapshot semantics explicit. Decide which local writes must commit together and which session projections can be rebuilt after interruption. Preserve standalone single-revision sessions.
- **Done when:** A crash between discussion and session updates cannot lose or double-deliver logical feedback. Deleted/edited messages are not resurrected. Agent acknowledgement stays distinct from human read receipts and thread resolution.

### B4 — Move classification out of frontend modules

- [ ] Extract pure file/block identity, import classification, and completion policy into browser-independent domain/shared modules.
- **Evidence:** Server imports `src/changeProgress`, `src/importGroups`, and `src/importFolds`; `ChangeBlock` combines domain identity with renderer coordinates.
- **Change:** Separate durable fingerprints/classification from `fileIndex`, display row, selection, and fold presentation. Keep a thin Pierre-specific adapter where needed instead of prematurely replacing the parser.
- **Done when:** Server code has no imports from `src/`; both runtimes use identical policy fixtures; persisted hashes remain compatible or have a migration.

### B5 — Explicit composition and service lifecycle

- [ ] Construct each domain service once and inject its dependencies at the composition root.
- **Evidence:** `Inbox` constructs another `Progress`; `createApi` connects services as a side effect; most services are optional in `Services`; `index.ts` starts the worker without shutdown handling.
- **Change:** Make production dependencies required and give tests explicit fixtures/capabilities. Share event ownership. Add stop/drain hooks for workers, external operations, streams, and storage, wired to daemon termination.
- **Done when:** A missing production service fails at startup, notifications have one owner, and graceful restart drains admitted local writes without hanging indefinitely on external work.

### B6 — Typed transport contracts and error categories

- [ ] Define shared operation inputs/results and runtime validation, independent of an eventual GraphQL schema.
- **Evidence:** Repeated body parsing and validation; `post<T>`/`request<T>` casts; opaque string errors; `createApi` maps nearly every thrown error to 400.
- **Change:** Use discriminated commands and errors, return canonical IDs/revisions/affected state, and distinguish validation, permission, stale snapshot/conflict, missing data, and upstream failure. Keep useful `jj`/`gh` diagnostic text.
- **Done when:** Production callers and fixtures consume the same contract types; malformed inputs are checked at runtime; UI retry decisions do not parse error prose. No GraphQL dependency is required for completion.

## P1 — frontend consistency

### F1 — Optimistic progress and follow-ups

- [ ] Replace `useChangeProgress` and `useFollowUps` component-local write machinery with shared keyed intent queues.
- **Remaining evidence:** Progress now previews and saves in shared queues, including real mutation retries. Follow-up saves still drop input while `writing.current` and wait before advancing.
- **Change:** Preview coupled flag/completion effects immediately, navigate immediately, preserve latest intent per entity, and keep failures/retry after route or modal changes. A retry must replay the failed command, not merely reload state.
- **Done when:** Held writes do not block navigation or other entities. Rapid reversal, cross-file actions, route changes, server rejection, and real Retry are browser-tested. Undo uses the acknowledged state and cannot overwrite newer intent.
- **Dependency:** C3's authoritative contract; use current optimistic primitives rather than building another queue.

### F2 — Finish local/session/comment mutation adoption

- [ ] Audit and migrate foreground reversible mutations in `ThreadResolution`, `LocalThreadDialog`, `WorkspaceCollaboration`, and comment edit/delete surfaces.
- **Change:** Use shared save feedback and stable domain scopes. For append operations, use unique non-coalesced submissions only after C5 makes retries safe. Preserve appropriate destructive confirmation and honest publication status. Review submission may retain an explicit foreground interaction if that is the chosen product behavior; it still needs recovery.
- **Done when:** Closing a surface does not lose reversible pending intent or failure feedback, reopening preserves drafts, later drafts survive earlier acknowledgements, and every Retry has defined semantics.

### F3 — Canonical queue identity and typed thread intents

- [ ] Replace endpoint-derived identity and serialized command strings with canonical entity keys and typed intents.
- **Evidence:** `useThreadResolutions` uses JSON strings, a random request field, and an empty confirmed value; local/PR/session views use different URLs for shared entities.
- **Change:** Distinguish value setters from commands in the save abstraction only where needed. Keep acknowledged entity state separate from pending command preview. Resolve local/published/session aliases consistently.
- **Done when:** Two mounted surfaces for one thread share pending state, ordering, and Retry. Acknowledgement after the originating component unmounts reaches the active resource; an older failed resolve cannot undo an acknowledged reopen.

### F4 — One resource freshness/reconciliation convention

- [ ] Consolidate feature-level server snapshots and invalidation into a resource layer with canonical keys and explicit revisions.
- **Evidence:** `useResource` clears data; feature hooks duplicate saved state; `useConversation` blindly accepts refreshed data; local discussions alone compare discussion versions; receipts combine multiple fetches and events.
- **Change:** Preserve last good same-resource data during refresh, clear it on identity change, deduplicate loads, and reject stale results relative to acknowledged mutations. Have SSE/polling/focus/broadcast signals enter the same reconciliation path. Remove redundant receipt fetches where the parent contract supplies the required snapshot.
- **Done when:** A GET started before a mutation cannot undo that mutation when it completes later. Linked views converge without remounting. Switching resources cannot display prior-resource data. Refresh failure does not roll back a successful save.
- **Scope:** Evaluate a small library or focused existing primitives; do not build a general client framework or adopt Apollo solely to close this ticket.

### F5 — Decompose the viewer by lifecycle

- [ ] Separate review resources/commands, navigation/selection, async hydration, and Pierre rendering integration from `Viewer.tsx`.
- **Change:** Extract one tested responsibility at a time. Reduce the feature prop/callback web in `Reviews.tsx` and comment adapters. Keep shared dialog/shortcut conventions and renderer-specific state close to the renderer.
- **Done when:** Domain workflows are understandable without reading viewport code; hydration cannot change a newer navigation choice; existing keyboard, comment jump, selection, scroll, and expansion tests pass. Avoid a renamed monolithic hook.

## P2 — persistence, verification, and operations

### B7 — Versioned migrations and explicit persistence shapes

- [ ] Replace constructor-time schema probing/backfill with ordered migrations and upgrade fixtures.
- **Evidence:** `server/storage.ts` contains table renaming, conditional column addition, and queue backfill. Most nested records are unvalidated JSON.
- **Change:** Version persisted shapes and preserve existing data. Normalize independently growing/addressed entities when B2/B3 identify a concrete need; retain cohesive snapshot JSON. Keep domain names and retention policies explicit.
- **Done when:** A fixture from each supported schema upgrades once, repeat startup is harmless, rollback/recovery is documented, and corrupt/unsupported records produce actionable diagnostics.

### Q1 — Repair test drift and strengthen real-boundary coverage

- [ ] Fix obsolete browser expectations and separate fixture-contract checks from backend behavior checks.
- **Evidence:** Recent broad runs failed on old `Comments (3)`/toolbar expectations and overlay positions; targeted new command/worker tests passed. `bun-tests/integration.test.ts` simulates some backend behavior in route fixtures. A green targeted subset is not a green full suite.
- **Change:** Review each failure against intended UX before changing assertions. Add a small real-API browser slice with controlled GitHub responses. Keep unit/domain/backend and browser checks discoverable, isolated, and independently runnable; avoid live service/database dependencies in test setup.
- **Done when:** Relevant full suites have a known reproducible result, remaining unrelated failures are individually tracked, and tests prove authoritative behavior instead of reproducing it in mocks. Include held requests, lost responses, and restart cases at the correct boundary.

### Q2 — Reconcile documentation and terminology

- [ ] Update README behavior/storage/testing descriptions and cross-link the architecture documents.
- **Evidence:** README still mentions `$BIFF_DATA_DIR/progress`, underdescribes the Playwright suite, and describes older dashboard/read behavior. `Progress`, `Reviews`, and several stale comments use overloaded terminology.
- **Change:** Audit claims against the implementation and current product intent. Distinguish current behavior, target policy, and proposed features; keep deployment instructions authoritative for the running instance.
- **Done when:** A reader can find the domain owner and verification command from the docs, and no documented current feature relies on removed storage or obsolete UI behavior.

### Q3 — Background job visibility and bounded resource lifetime

- [ ] Add operation/entity context to logs and bound long-lived in-memory registries where safe.
- **Evidence:** Viewed polling and multiple promise maps own detached work; `BackgroundSaveRegistry.clearSaved` clears receipts but completed submissions/queues can remain retained. `index.ts` exposes only basic health.
- **Change:** Provide inspectable sync state/last attempt and useful errors without adding a generic jobs dashboard. Release settled registry entries only after active consumers and retries no longer need them. Add bounded job concurrency/backoff as needed by C4.
- **Done when:** A failed worker can be diagnosed without opening a specific screen, a long browser session does not retain unlimited completed submission closures, and failures remain retryable after cleanup.

## Deferred decisions — not cleanup prerequisites

- **Joist:** Evaluate after B1–B4 clarify entities, relationships, and transaction boundaries. Decide database/runtime compatibility and data migration explicitly; do not assume SQLite JSON records map directly to the desired entity model.
- **GraphQL:** Evaluate after B6 establishes operation semantics. Preserve intent-based mutations, revisions, and authoritative errors; keep bulk diff/source transport pragmatic.
- **Apollo or another client cache:** Evaluate against F3/F4 and held-request tests. Preserve an explicit optimistic command layer if the cache cannot supply the required ordering/retry semantics.
- **Remote working-copy providers:** Follow `CLIENT_WORKSPACES.md` as a separate feature; this cleanup should make its adapter boundary easier, not implement it incidentally.
- **Multi-user or multi-process operation:** Requires explicit principals, receipt ownership, authorization, and distributed concurrency design. Current single-user assumptions must not silently become a hosted product contract.
- **Durable offline browser writes:** A separate promise requiring a persisted outbox and replay protocol. Current guarantees cover SPA navigation plus reload warnings, not offline durability.
