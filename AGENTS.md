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
