# Client-provided workspaces

## Status and summary

**Local groundwork implemented; remote clients remain a proposal.** Command names and protocol details below are illustrative.

The local JJ/filesystem implementation now sits behind `WorkspaceProvider`, with registrations owned by `Workspaces`. Agent-session lookup uses central workspace IDs; the standalone adapter's path is resolved at the local API boundary. Accepted diffs and metadata are immutable `review_snapshots` records, readable without the provider. Sessions reference those records and canonical discussions, with relational delivery counters and fingerprints. Finished sessions retain a frozen discussion archive. Refresh preparation runs outside session write queues, and superseded refreshes cannot replace a newer session snapshot.

Provider registration/pairing, remote transport, source-content capture/cache, offline browser presentation, and client CLI/IPC are still future work. The local provider continues to use the existing path-derived workspace IDs. Snapshot retention currently keeps all accepted captures; cleanup must account for review/session references before it is introduced. Migration 20 intentionally discards old agent-session rows; review comments, approvals, and workspace registrations are retained.

Split Biff into a central review server and optional working-copy clients. Keep code and coding agents on the machines where development happens, while serving reviews, discussions, and agent-session state from one browser-accessible hub.

The client is a working-copy provider, not another webapp server or a remote development environment. This extends the existing local-daemon model rather than replacing it.

## Motivation

A desktop-hosted Biff instance can serve its UI to a laptop, but it cannot read the laptop's working copies or unpushed edits. Running a full Biff instance on each machine solves filesystem access but splits review state and browser URLs between machines.

Most PRs reviewed in Biff are other people's work. Those authors should not need to run Biff, use JJ, or adopt a shared development environment. GitHub remains the boundary for their PRs; only the reviewer's own local working copies need a client connection.

The desired model is **one review hub, multiple working-copy providers**, without moving every branch into a remote clone or microVM.

## Goals and non-goals

### Goals

- Open laptop and desktop working-copy reviews at the same central browser origin.
- Review unpushed changes without pushing code to GitHub or synchronizing repositories between machines.
- Preserve immutable snapshots, comments, progress, and agent feedback through browser refreshes and client/server restarts.
- Let a laptop client connect outbound without exposing an incoming network listener or serving the webapp UI.
- Keep GitHub PR reviews independent of client availability and the author's tooling.
- Preserve standalone local Biff behavior when client mode is not selected.

### Non-goals

- Hosting coding agents or keeping them running when their laptop sleeps.
- Checking out branches, editing files, running builds/tests, or providing a remote shell through the provider protocol.
- Synchronizing repositories, sharing live SQLite files, or reproducing other authors' development environments.
- Public multi-user hosting, Slack integration, or microVM orchestration.

Those could be separate projects. A persistent review session does not imply a persistent remote execution environment.

## Architecture and ownership

```text
Laptop                                    Desktop / central host
local JJ working copies                   Biff server
local coding agent                        webapp + API + SQLite
       |                                         ^
Biff CLI / agent adapter                         |
       |                                         |
Biff client ---- outbound authenticated link ----+
                                                 |
                                          browser, from any
                                          authorized device
```

| Component | Owns |
| --- | --- |
| Central server | UI, workspace registry, accepted snapshots, review identity/reconciliation, progress, discussions, publication receipts, agent sessions, delivery cursors, and GitHub access |
| Client | Local machine identity, explicitly registered working-copy roots, local workspace identities, JJ execution, connection/retry state, and the bridge to local agent adapters |
| Browser | Presentation, unsent drafts, and display preferences; no direct connection to a working-copy client |

Introduce a workspace-provider boundary around the current local filesystem/JJ operations in `server/workspaces.ts`. The central server routes a workspace request to either its local provider or a connected client provider. Keep domain logic for review lifetimes and discussion state on the server rather than implementing a second review store in the client.

Keep the desktop's local provider available so its working copies do not depend on a network round trip. Clients do not need GitHub credentials; GitHub operations continue to use the central server's `gh` account.

## Identity and snapshots

### Workspace identity

Use a durable provider ID plus a provider-local workspace ID. The server assigns a central workspace ID used in URLs and review scopes. A path is a location on that provider, not a globally unique identity.

I.e. a laptop and desktop may both register `/home/stephen/project`; they are distinct working copies. Reconnecting the laptop must recover its existing registration instead of creating a new review namespace. Keep the mapping across client restarts; machine labels and paths are display/diagnostic metadata, not authentication.

The current workspace ID is derived from its canonical path, and parts of `server/reviews.ts` look up sessions by workspace path. These assumptions must become provider-aware. Preserve existing local workspace IDs, review URLs, and progress scopes during migration; do not reset registrations or saved reviews.

### Immutable review snapshots

Resolve mutable selectors such as `@`, inferred bookmarks, and automatic bases on the client. Return a snapshot with immutable commit/change identities, the resolved base/tip, review metadata, and the prepared diff. Preserve current JJ whitespace filtering and bookmark/base semantics.

Full-context requests and comment anchors must use the snapshot's immutable coordinates, including merged-parent behavior and renamed paths. They must never silently read the client's current working-tree file instead. Keep snapshot identity separate from the durable review lifetime so refreshing a snapshot does not create a new discussion unnecessarily.

Persist accepted snapshots centrally. A useful initial capture includes full old/new contents for changed text files, subject to explicit size limits. Record which contents are available: binary, oversized, or omitted files must have a visible unavailable state rather than appearing empty. Content fetched later is cached against the same immutable snapshot.

Do not require a full repository upload. The client may become unable to recover an old commit after history cleanup; already accepted snapshots must remain useful without it. Snapshot/blob retention and cleanup must respect saved reviews and existing session lifetimes.

## Client connection and operations

Use a long-lived, authenticated outbound connection from the client to the server; WebSocket over HTTPS is a reasonable initial transport. The central server remains behind Caddy/Tailscale. The laptop needs neither an inbound tailnet port nor its own public origin.

At connection time, negotiate a protocol version and capabilities, authenticate the paired provider, and advertise its registered workspaces. Track connected/disconnected state and last-seen time. Replace an older connection for the same provider deliberately; use connection generations so a stale response cannot regain ownership after reconnect.

Expose bounded domain operations, not a general HTTP proxy or command runner:

| Operation | Purpose |
| --- | --- |
| Register/list approved workspaces | Associate client-owned IDs with locally approved roots and names |
| Prepare review snapshot | Resolve supported revision/bookmark/base selections and produce the immutable review data |
| Read snapshot file contents | Return the old/new sides for a validated path belonging to that snapshot |
| Bridge agent-session operations | Start/resume, refresh, read/wait, reply, acknowledge, resolve/reopen, and finish through the server-owned session |

Discovery, if supported, must be initiated locally within a user-approved directory. The central browser must not be able to ask the client to crawl arbitrary filesystem paths.

Messages need request IDs, deadlines/cancellation, bounded payloads/concurrency, and structured errors. Large snapshot transfers need explicit limits or chunking rather than silently increasing every API request limit. A failed or interrupted capture must not replace the last accepted snapshot with partial data. Replays must not duplicate registrations, comments, or other durable writes; use stable operation IDs for retriable mutations.

Do not hold a SQLite transaction open while waiting on the client. Validate responses against the authenticated provider, requested workspace/snapshot, and current connection generation before accepting them.

## CLI and agent sessions

Client mode is explicit. For example, a future `biff client connect --server https://biff.draconian.app` could pair/connect a provider; the exact configuration and command surface are still to be decided.

In client mode, running `biff` inside a working copy should:

1. Find its local JJ root and register it with the local client.
2. Ask the central server to open or refresh that provider's review.
3. Print/open the central browser URL, preserving revision and session parameters.

The CLI must not send a laptop path to the desktop's local provider. It must not fall through to today's `ensureDaemon()` behavior and start a full local webapp daemon when the central server or client connection is unavailable. Report the connection problem explicitly instead.

Keep ordinary standalone mode unchanged: loopback API calls, local daemon startup/reuse, and localhost browser URLs. Choose the central target through explicit client configuration, not by repurposing `BIFF_PUBLIC_ORIGIN`; that setting remains a server-side request-security setting.

A local-only control channel, preferably a protected Unix socket, can connect the CLI and agent adapters to the client without adding a browser-accessible HTTP server. The adapter/client bridge must also support discovering resumable sessions for that provider's workspace; it cannot depend on globally unique filesystem paths.

### Feedback flow

1. The local agent starts/resumes a session against the central review and receives its central URL.
2. Browser comments are committed to central SQLite before acknowledgment.
3. The server notifies the connected client of available feedback; the client delivers it to the correct local agent conversation.
4. Replies and explicit acknowledgments return to the central session through the same bridge.

Reuse the existing session sequencing, acknowledgment cursors, stable prompt IDs, and publication deduplication rather than making socket delivery a new source of truth. Notification delivery may be retried; socket receipt is not agent admission or acknowledgment. Reconnect from durable cursors, and tolerate duplicates without admitting the same prompt twice.

Transport replay protection does not by itself make agent actions exactly-once. Preserve the current boundary between feedback delivery, admission to the agent host, and an explicit acknowledgment.

## Offline behavior and recovery

| Situation | Expected behavior |
| --- | --- |
| Laptop sleeps/disconnects | Mark its workspaces offline; retain registrations, accepted snapshots, comments, and progress |
| Browser opens an offline review | Render the last accepted snapshot and cached contents, clearly labeled as offline/not refreshed |
| Refresh or uncached content needs an offline client | Return a specific unavailable error; do not substitute stale data as a successful refresh |
| User writes comments/progress while the client is offline | Save centrally against the known snapshot; defer agent delivery, not durable storage |
| Client reconnects | Reauthenticate, re-advertise stable registrations, and resume pending feedback without duplicate sessions/prompts |
| Central server restarts | Clients reconnect with bounded backoff; committed review state and delivery cursors survive |
| Local agent is not running | Keep feedback pending; do not imply the central server can wake or host that agent |

Comments that require unavailable source validation should remain drafts with a clear error, not become acknowledged anchored comments. Previously stored anchors and their code excerpts remain usable.

Follow the existing optimistic/background-save conventions for browser interactions. A failed snapshot refresh must not undo an acknowledged comment or progress write. Preserve drafts and selection, and warn before navigation/reload would discard unsaved work. Offline behavior must distinguish server reachability from provider reachability.

## Security boundaries

- Keep the central service bound to loopback behind Caddy and restrict remote access to trusted Tailscale devices/users. Do not broaden browser Host/Origin checks or trust arbitrary forwarded headers for the new transport.
- Add explicit provider pairing and revocable credentials scoped to one provider's registrations and operations. Verify the server's TLS identity. A claimed machine ID, allowed Origin, or tailnet membership is not a substitute for pairing.
- Authenticate the connection/upgrade endpoint before exposing provider operations. A native client need not send a browser Origin; that must not create an unauthenticated path for browser or third-party clients.
- Keep credentials out of review URLs, logs, and committed configuration. Protect local client state and its control socket with user-only access. Credential revocation must disconnect the active provider as well as reject later reconnects.
- Approve workspace roots locally. Canonicalize paths, reject traversal/symlink escapes, and use validated JJ selectors and argument arrays. The server cannot supply arbitrary executables, shell text, or host filesystem paths.
- Scope source requests to approved snapshots and paths. A provider may advertise/respond only for its own registrations. Browser/API callers select central workspace IDs; they cannot override provider routing or supply arbitrary client paths. Treat client responses as untrusted input and enforce size/schema limits server-side.
- A paired server is trusted to receive source from registered working copies. Snapshot uploads and central backups therefore contain private source and require appropriate access and retention controls.
- Biff's current central browser API has no per-user authentication. Pairing providers does not change that: anyone allowed to reach the hub can access its reviews and act with the server user's GitHub permissions. Multi-user authorization remains outside this proposal.

## Implementation phases

1. **Extract the provider boundary locally.** Separate workspace registry/review-domain behavior from JJ/filesystem access. Route existing desktop workspaces through a local provider; keep behavior, IDs, and storage compatible.
2. **Add provider identity, pairing, and bounded transport.** Implement authenticated connection lifecycle, workspace registration, version/capability negotiation, and online/offline status. Prove a reconnect does not duplicate registrations.
3. **Support remote review snapshots and contents.** Route preparation/content requests by provider, persist immutable results centrally, and expose explicit offline/incomplete-content states. Keep GitHub-only reviews independent.
4. **Bridge CLI and agent sessions.** Add explicit client-mode configuration and local IPC, central URL generation, provider-aware session lookup, and cursor-based feedback/reply delivery. Preserve standalone CLI behavior.
5. **Harden deployment and recovery.** Document client installation, protected credential storage, startup/shutdown, revocation, protocol upgrades, retention, and troubleshooting. Test interruptions and mixed supported versions before relying on it for daily reviews.

Do not begin by copying the existing entire server/API onto the laptop and proxying every endpoint. The provider boundary should make ownership explicit and keep GitHub credentials and durable review state central.

## Acceptance tests

- A laptop workspace opens at the central origin with unpushed edits, while the desktop's same-path workspace remains distinct.
- Full-context loading and comment anchors still show the reviewed base/head after the laptop's working copy changes, including rename and merge cases.
- Sleeping the laptop preserves readable cached reviews and central comments; provider-dependent operations fail clearly and recover after reconnect.
- Client/server/adapter restarts preserve workspace identity, review lifetimes, and agent-session association. Held requests and retries do not duplicate writes or agent prompt admission.
- Two workspaces can refresh independently; cancellation and a late response from a replaced connection cannot overwrite a newer snapshot or freeze unrelated browser actions.
- Revoked/unpaired providers, cross-provider requests, unsupported protocol versions, invalid selectors/paths, and oversized/partial snapshots are rejected without invoking arbitrary commands or losing the last accepted snapshot.
- Existing local registrations and SQLite state survive migration, and standalone CLI/local-provider tests remain unchanged in behavior.
- GitHub PR review and publication work with every client disconnected; local clients never need the server's GitHub token.

## Open questions

- What is the smallest ergonomic client configuration and pairing flow? Is the hub selected per user, project, or invocation?
- What source content should be captured eagerly, and what limits/retention policy make offline reviews useful without uploading excessive data?
- How should moving/recreating a local working copy retain or deliberately change its provider-local identity?
- Should agent adapters initially use only client IPC, or also support an explicitly authenticated direct central connection?
- How should one provider's credentials be recovered or rotated after reinstall, without allowing an unpaired replacement to claim existing workspaces?
- Which protocol-version compatibility window is necessary for independently updated desktop and laptop installations?
