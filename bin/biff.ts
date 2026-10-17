#!/usr/bin/env bun
import { mkdir, open } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { runCommand } from "../server/commands";
import { reviewCommand } from "./review";

const args = process.argv.slice(2);
const port = Number(process.env.BIFF_PORT || 4567);
const origin = `http://127.0.0.1:${port}`;
if (args.includes("--help")) {
  console.log("biff [@|@-|REV] [--no-open]\nbiff --dashboard\nbiff --prs\nbiff review start [--session ID] [--rev REV] [--no-open]\nbiff review get|wait|refresh|finish ID\nbiff review wait ID [--after SEQUENCE]\nbiff review reply ID THREAD --body TEXT\nbiff review resolve|reopen ID THREAD\nbiff review ack ID SEQUENCE\n\nRegisters the current JJ working copy and opens its diff. BIFF_PORT defaults to 4567.");
} else {
  await ensureDaemon();
  if (args[0] === "review") {
    await reviewCommand(args.slice(1), origin);
  } else {
    let path = args.includes("--prs") ? "/prs" : "/workspaces";
    if (!args.includes("--dashboard") && !args.includes("--prs")) {
      const root = (await runCommand(["jj", "root", "--no-pager"])).trim();
      const response = await fetch(`${origin}/api/workspaces`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: root }) });
      const result = await response.json() as { id?: string; error?: string };
      if (!response.ok || !result.id) throw new Error(result.error || "Could not register working copy");
      const revision = args.find((arg) => !arg.startsWith("--"));
      path = `/workspaces/${result.id}${revision ? `?rev=${encodeURIComponent(revision)}` : ""}`;
    }
    const url = origin + path;
    console.log(url);
    if (!args.includes("--no-open")) await runCommand([process.platform === "darwin" ? "open" : "xdg-open", url]);
  }
}

/** Reuse one local daemon across terminals and browser tabs. */
async function ensureDaemon() {
  if (await isRunning()) return;
  const directory = process.env.BIFF_DATA_DIR || join(process.env.XDG_DATA_HOME || join(homedir(), ".local/share"), "biff");
  await mkdir(directory, { recursive: true });
  const log = await open(join(directory, "daemon.log"), "a", 0o600);
  const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../server/index.ts")], { stdin: "ignore", stdout: log.fd, stderr: log.fd });
  child.unref();
  await log.close();
  for (let attempt = 0; attempt < 50; attempt++) {
    if (await isRunning()) return;
    await Bun.sleep(100);
  }
  throw new Error(`Biff did not start. Check ${directory}/daemon.log`);
}

/** Distinguish Biff from an unrelated process already occupying the port. */
async function isRunning(): Promise<boolean> {
  try {
    const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(500) });
    const body = await response.json() as { name?: string };
    return response.ok && body.name === "biff";
  } catch { return false; }
}
