# Database schema

- Give new tables a synthetic primary key. Keep domain identities in unique constraints and reference the synthetic key from new foreign keys.

# Optimistic UX and background saves

- Apply reversible user actions immediately, then persist in the background. Navigation, focus, scrolling, and unrelated actions must not wait for a save.
- Use `useOptimisticSave` for keyed values and `BackgroundSaveStatus` for feedback instead of creating another loading/error convention. Give each operation a stable, resource-specific scope and a useful label (for example, the file and line).
- For append operations such as publishing comments, use `backgroundSaves.submit` with a unique submission ID and server-side deduplication. Preserve each submission rather than coalescing it with later text.
- Show quiet Saving/Saved feedback. Keep failures visible with Retry, including after a modal closes or the user navigates elsewhere. Never silently discard an unsaved change.
- Serialize writes per entity and keep the latest intent. Other entities can save independently. A stale response or failed older write must not undo a newer action.
- On failure, restore the last acknowledged value, preserve drafts and selection, and let the user retry. Do not roll back an acknowledged write because a later refresh fails.
- Keep pending work outside transient UI. Reopening a modal must retain its optimistic state and save status.
- Preserve background work across SPA navigation, and warn before a reload or tab close would discard unsaved work.
- Respect permissions. For destructive or non-idempotent operations, use appropriate confirmation and never claim an action is published or durable before the server acknowledges it.
- Test with held requests: the UI changes before completion, unrelated actions still work, rapid reversals save in order, and failures roll back with a working retry.
- Apply this pattern to new or touched interactions; do not rewrite unrelated flows just for consistency.

# Dialog headers and keyboard help

- Use `ModalHeader` for dialogs, dialog-style popovers, and dismissible review panels. Supply the title, an accessible close label, the existing close callback (or popover target), and context-specific shortcut definitions.
- `ModalHeader` provides the shared X and collapsed `?` disclosure. `ShortcutHelp` owns question-mark handling for the active scope and leaves text inputs alone. Do not add another help toggle or window listener for it.
- Keep native dialog/popover focus and dismissal behavior with the owner. Mark non-dialog panels with `data-modal-scope`. Embedded comment views share the outer header; `ModalBusyContext` lets their pending save disable its X.
- Keep reply drafts and background save feedback intact when closing. Hide unavailable shortcuts and retain existing close restrictions during foreground saves.

# Running Biff during development

On sh13, the live Biff instance is managed by the **systemd user service `biff.service`**, running from `/home/stephen/other/biff`.

After changes intended for the running app, build successfully before restarting:

```sh
bun run build
systemctl --user restart biff.service
systemctl --user status biff.service --no-pager
curl --fail-with-body http://127.0.0.1:4567/api/health
```

- Do not restart if the build fails. Run relevant tests before deploying changes.
- Use `systemctl --user restart biff.service`, not `bun start`, manual daemon kills, or a second CLI-started daemon. Isolated test/dev servers must not compete for the live port or database.
- Backend changes take effect after restart. Frontend changes require a browser-tab refresh after rebuilding; the production app does not hot-reload. Tell the user when a refresh is needed.
- The browser URL remains `https://biff.draconian.app`. Routine app updates do not require a Caddy restart.
- Preserve the loopback-only listener at `127.0.0.1:4567`, the configured `BIFF_PUBLIC_ORIGIN`, and existing SQLite data at `/home/stephen/.local/share/biff/inbox.sqlite`.
- Local CLI commands still reuse the service and print localhost browser URLs.

See [deployment instructions](deploy/README.md) for service configuration, backups, Tailscale security requirements, and troubleshooting.
