import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { createApi } from "./api";
import { GitHub } from "./github";
import { Workspaces } from "./workspaces";
import { Reviews } from "./reviews";
import { Progress } from "./progress";
import { Inbox } from "./inbox";
import { Storage } from "./storage";
import { GitHubViewedSync } from "./githubViewedSync";

const data = process.env.BIFF_DATA_DIR || join(process.env.XDG_DATA_HOME || join(homedir(), ".local/share"), "biff");
const dist = resolve(import.meta.dir, "../dist");
const storage = new Storage(join(data, "inbox.sqlite"));
const github = new GitHub(undefined, storage);
const inbox = new Inbox(storage, github);
const progress = new Progress(storage);
const githubViewedSync = new GitHubViewedSync(progress, github);
githubViewedSync.start();
const api = createApi({ workspaces: new Workspaces(storage), github, inbox, reviews: new Reviews(storage), progress, githubViewedSync }, process.env.BIFF_PUBLIC_ORIGIN);
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.BIFF_PORT || 4567),
  idleTimeout: 120,
  maxRequestBodySize: 1_000_000,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return api(request);
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("Not found", { status: 404 });
    const path = resolve(dist, `.${decodeURIComponent(url.pathname)}`);
    if (!path.startsWith(dist + sep) && path !== dist) return new Response("Not found", { status: 404 });
    const file = Bun.file(path);
    if (path !== dist && await file.exists()) return new Response(file);
    const index = Bun.file(join(dist, "index.html"));
    if (!(await index.exists())) return new Response("Build Biff first: bun run build", { status: 503 });
    return new Response(index, { headers: { "Cache-Control": "no-cache" } });
  },
});
console.log(`Biff: ${server.url}`);
