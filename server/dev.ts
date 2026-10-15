// The API runs in Bun; Vite remains a plain client dev server with an /api proxy.
export {};
const api = await apiRunning() ? undefined : Bun.spawn(["bun", "--watch", "server/index.ts"], { stdout: "inherit", stderr: "inherit" });
const vite = Bun.spawn(["bun", "node_modules/vite/bin/vite.js", "--host", "127.0.0.1", ...process.argv.slice(2)], { stdout: "inherit", stderr: "inherit" });
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
await Promise.race(api ? [api.exited, vite.exited] : [vite.exited]);
stop();

/** Keep dev server children from surviving their launcher. */
function stop() { api?.kill(); vite.kill(); }

/** The CLI may already have started the shared API daemon. */
async function apiRunning(): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${process.env.BIFF_PORT || 4567}/api/health`, { signal: AbortSignal.timeout(500) });
    const result = await response.json() as { name?: string };
    return response.ok && result.name === "biff";
  } catch { return false; }
}
