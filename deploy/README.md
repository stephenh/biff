# Tailscale-only Caddy deployment

Biff can run at **https://biff.draconian.app** through Caddy on sh13's Tailscale IP, **100.70.106.46**. Biff still listens only on **127.0.0.1:4567**. These are deployment instructions, not an installer; no command here changes DNS, firewall rules, or Caddy automatically.

## Security boundary

**Biff has no authentication.** Anyone who can reach this endpoint can read accessible working copies and reviews, change Biff state, and act on GitHub using **Stephen's `gh` credentials and permissions**. HTTPS and the origin checks are not user authentication. An arbitrary HTTP client can supply allowed Host/Origin headers.

- Restrict access with **Tailscale ACLs/grants to trusted devices and users only**, including access to sh13's TCP port 443. Do not rely on a broad tailnet-wide default allow policy.
- Caddy must expose this site only on `100.70.106.46`, not a public or LAN interface. Do not use Tailscale Funnel, public port forwarding, or another publicly reachable proxy for this site. A publicly trusted certificate does not make the network endpoint public, but it does not restrict clients either.
- This is one user's service, not multi-user hosting. Local processes already have access through loopback. Keep the OS account and proxy configuration trusted.
- Keep Biff's listener on loopback. The public-origin setting grants one request authority; it is not an IP allowlist. Network isolation belongs to Caddy's listener and Tailscale policy.

## Origin and Caddy configuration

Set this in the **daemon's environment**, then restart it:

```sh
export BIFF_PUBLIC_ORIGIN=https://biff.draconian.app
```

Without the setting, only `127.0.0.1`, `localhost`, and `[::1]` are accepted API hosts. With it, the exact configured public host **and port** are also accepted; subdomains, sibling domains, suffix matches, and other ports are not. The setting must be a single HTTPS origin: no credentials, wildcard, path (other than `/`), query, or fragment. Invalid settings fail startup. Removing it and restarting restores localhost-only access.

For the existing certificate setup, the relevant Caddy site should have this shape. **Review and apply any Caddy changes yourself; do not replace unrelated site configuration.**

```caddyfile
https://biff.draconian.app {
    bind 100.70.106.46
    reverse_proxy 127.0.0.1:4567
}
```

The upstream connection is HTTP, but a browser's `Origin` is still `https://biff.draconian.app`. Biff compares that Origin to the configured HTTPS origin when the request's actual Host matches the configured public authority; it does not compare it to the upstream's HTTP scheme.

**Required upstream headers:** preserve the original **Host**, **Origin**, and **Sec-Fetch-Site**. Caddy's normal HTTP `reverse_proxy` behavior already does this; no custom headers are required. Do not rewrite Host to `127.0.0.1:4567`, and do not strip or rewrite Origin or Fetch Metadata to bypass checks. If existing proxy configuration overrides Host, remove that override or use `header_up Host biff.draconian.app` inside this exact site block. Biff ignores `Forwarded`, `X-Forwarded-Host`, and `X-Forwarded-Proto` for authorization; none is required to bridge HTTPS to HTTP.

Any supplied Origin must exactly match the requested authority's expected origin. Public and localhost origins are not interchangeable, even though both are allowed hosts. Malformed and opaque (`null`) origins are rejected. `Sec-Fetch-Site: cross-site` is rejected, including on reads and when Origin is absent. Non-browser requests without Origin remain supported, as before; JSON write endpoints still require `application/json`. Biff does not enable cross-origin API access or add CORS allow headers.

## CLI and browser URLs

`biff` checks `http://127.0.0.1:$BIFF_PORT/api/health` for `{ "name": "biff" }` and reuses that daemon, whether started by the CLI or systemd. If no Biff daemon answers, it starts `server/index.ts` using the CLI's Bun executable, inherits the CLI environment, and appends logs to `$BIFF_DATA_DIR/daemon.log`.

- API calls, workspace registration, review commands, and agent connections stay on loopback. They do not depend on Caddy, DNS, or Tailscale connectivity.
- Printed/opened browser URLs also **stay on loopback**, including `biff review start`'s JSON `url`. `BIFF_PUBLIC_ORIGIN` is a server-side security setting, not a URL-generation setting. For a remote browser, replace `http://127.0.0.1:4567` with `https://biff.draconian.app`, preserving the entire path and query.
- Setting the variable in a CLI shell does **not** reconfigure a daemon it reuses. Restart the daemon with the setting. The CLI and service must use the same `BIFF_PORT`.
- If the service is stopped, running `biff` can start a CLI-owned daemon again. Avoid CLI/agent commands during the handover. Once systemd owns the listener, the CLI simply reuses it.
- Browser local storage is origin-specific. Server-side SQLite state is shared, but unsent browser drafts and display preferences do not move from localhost to the HTTPS origin automatically. Save important drafts before switching.

## User-service template

[`biff.service`](biff.service) is specific to `/home/stephen/other/biff`. It runs Bun directly in the foreground, restarts after failure, and uses `/home/stephen/.local/share/biff` explicitly so systemd's environment cannot accidentally select a new database. Logs go to the journal, not `daemon.log`.

The explicit PATH includes `~/.bun/bin`, mise shims, `~/.local/bin`, and system binaries for Bun, `gh`, and `jj`. User services do not read shell profiles. On this host, Bun is available at `/home/stephen/.bun/bin/bun`, `gh` through mise, and `jj` at `/usr/bin/jj`. Confirm these remain valid after tool upgrades. The service uses this user's normal GitHub CLI authentication; custom `GH_CONFIG_DIR` or token environment settings must be carried over explicitly if you use them. Never commit tokens to the unit file.

Lingering does not unlock a desktop keyring. If `gh` credentials are only available after interactive login, arrange appropriate unattended credential access separately before relying on GitHub operations at boot.

### Prepare without stopping the live daemon

Run as **stephen** on sh13:

```sh
cd /home/stephen/other/biff
bun install --frozen-lockfile
bun run build
env PATH=/home/stephen/.bun/bin:/home/stephen/.local/share/mise/shims:/home/stephen/.local/bin:/usr/local/bin:/usr/bin:/bin bun --version
env PATH=/home/stephen/.bun/bin:/home/stephen/.local/share/mise/shims:/home/stephen/.local/bin:/usr/local/bin:/usr/bin:/bin jj --version
env PATH=/home/stephen/.bun/bin:/home/stephen/.local/share/mise/shims:/home/stephen/.local/bin:/usr/local/bin:/usr/bin:/bin gh auth status
systemd-analyze --user verify deploy/biff.service
ss -ltnp 'sport = :4567'
```

Before handover, confirm the existing daemon's `BIFF_DATA_DIR`/`XDG_DATA_HOME` and open SQLite file. At inspection time, PID **4120983** used **`/home/stephen/.local/share/biff/inbox.sqlite`**, with no `BIFF_DATA_DIR` override. **Recheck the PID; do not kill a stale PID or another process.** If your daemon uses a different directory, change the template's `BIFF_DATA_DIR` to that exact directory first. No database migration or re-registration is needed.

### Handover (manual approval point)

The following commands **install/enable the service and stop the CLI daemon**. Run them only when you approve that handover. Close browser tabs, pause agents, and let in-flight writes/publications finish. Do not run the CLI again until systemd owns port 4567.

First install the template and reload the user manager, but do not start it yet. If the destination unit already exists, compare it and merge local changes instead of overwriting it:

```sh
install -D -m 0644 /home/stephen/other/biff/deploy/biff.service /home/stephen/.config/systemd/user/biff.service
systemctl --user daemon-reload
```

Enter the **current** Biff PID from `ss` (4120983 was the inspected PID), and inspect its executable, arguments, environment settings, and open database files:

```sh
read -r -p 'Verified current CLI Biff PID: ' BIFF_PID
ps -p "$BIFF_PID" -o user,pid,ppid,args
readlink "/proc/$BIFF_PID/exe"
tr '\0' '\n' < "/proc/$BIFF_PID/environ" | grep -E '^(BIFF_(PORT|DATA_DIR|PUBLIC_ORIGIN)|XDG_DATA_HOME)='
ls -l "/proc/$BIFF_PID/fd" | grep inbox.sqlite
```

**Only after confirming it is this user's CLI-started Biff daemon**, stop it with SIGTERM (not SIGKILL), and verify the listener is gone. If it is managed by another supervisor, stop that supervisor instead. Do not start a second daemon against the same database.

```sh
kill -TERM "$BIFF_PID"
ss -ltnp 'sport = :4567'
ps -p "$BIFF_PID" -o pid,args
```

Wait until the old process has exited and nothing listens on 4567. Create a consistent SQLite backup, then start the service:

```sh
umask 077
BIFF_BACKUP="/home/stephen/.local/share/biff/backups/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BIFF_BACKUP"
sqlite3 /home/stephen/.local/share/biff/inbox.sqlite ".backup '$BIFF_BACKUP/inbox.sqlite'"
sqlite3 "$BIFF_BACKUP/inbox.sqlite" 'PRAGMA integrity_check;'
```

The integrity check must return `ok`. Only after the backup/check succeeds, start the service:

```sh
systemctl --user enable --now biff.service
systemctl --user status biff.service --no-pager
journalctl --user -u biff.service -n 50 --no-pager
```

SQLite uses WAL mode: **never delete `inbox.sqlite`, `inbox.sqlite-wal`, or `inbox.sqlite-shm`, or copy only the main file while the daemon is running**. SQLite's `.backup` includes committed WAL data. The new service opens the existing database in place; leave the old `daemon.log` alone. Keep the backup private because it contains source excerpts and review data.

Enable lingering so the user manager and enabled service start at boot **before login** and survive logout. This is an explicit administrator action, not something Biff performs:

```sh
sudo loginctl enable-linger stephen
loginctl show-user stephen -p Linger
```

Do not run Biff itself with sudo. For later server updates, rebuild and use `systemctl --user restart biff.service`; do not start another copy with `bun start`. Loopback binding remains hard-coded in `server/index.ts`.

## Verify after the approved handover

On sh13:

```sh
ss -ltnp 'sport = :4567'
curl --fail-with-body http://127.0.0.1:4567/api/health
curl --fail-with-body http://127.0.0.1:4567/api/health -H 'Host: biff.draconian.app' -H 'Origin: https://biff.draconian.app'
curl -i http://127.0.0.1:4567/api/health -H 'Host: hostile.example'
curl -i http://127.0.0.1:4567/api/health -H 'Host: biff.draconian.app' -H 'Origin: https://hostile.example'
curl -i http://127.0.0.1:4567/api/health -H 'Host: biff.draconian.app' -H 'Sec-Fetch-Site: cross-site'
```

Expect a listener only on `127.0.0.1:4567`, two successful health responses, and three **403** responses. The backend-hop checks do not prove that the network is restricted.

From an authorized Tailscale client, verify the complete TLS/proxy path without depending on a DNS change:

```sh
curl --fail-with-body --resolve biff.draconian.app:443:100.70.106.46 https://biff.draconian.app/api/health
```

Open `https://biff.draconian.app` in that client's browser once its existing DNS resolves correctly. Verify registered working copies and saved review state. Also verify an unauthorized Tailscale device/user cannot reach TCP 443 and that the site is not reachable over public/LAN interfaces. DNS, Caddy/certificate management, firewall changes, and Tailscale policy changes are separate administrator tasks; these instructions do not apply them.
