import type { RunCommand } from "./commands";

/** Fetch private GitHub screenshots without sending gh credentials to the browser or signed asset host. */
export async function githubAttachment(id: string, run: RunCommand, request: (url: string | URL, options?: RequestInit) => Promise<Response> = fetch): Promise<Response> {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)) throw new Error("Invalid GitHub attachment");
  const token = (await run(["gh", "auth", "token", "--hostname", "github.com"])).trim();
  let response = await request(`https://github.com/user-attachments/assets/${id}`, {
    headers: { Authorization: `Bearer ${token}` }, redirect: "manual", signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 302) {
    const target = new URL(response.headers.get("location") ?? "");
    if (target.protocol !== "https:" || !(target.hostname.endsWith(".amazonaws.com") || target.hostname.endsWith(".githubusercontent.com"))) throw new Error("Unexpected GitHub attachment redirect");
    // Signed URLs authorize the asset request themselves; never forward the GitHub token.
    response = await request(target, { redirect: "error", signal: AbortSignal.timeout(30_000) });
  }
  if (!response.ok) throw new Error(`GitHub attachment failed (${response.status})`);
  const type = response.headers.get("content-type")?.split(";")[0].trim() ?? "";
  if (!/^image\/(png|jpeg|gif|webp|avif)$/.test(type)) throw new Error("Unsupported screenshot format");
  return new Response(response.body, { headers: { "Content-Type": type, "Cache-Control": "private, max-age=3600", "X-Content-Type-Options": "nosniff" } });
}
