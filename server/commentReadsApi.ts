import type { Progress } from "./progress";

/** Share durable message read receipts across ordinary and collaboration review routes. */
export async function commentReadsResponse(request: Request, progress: Progress, scope: string): Promise<Response> {
  if (request.method === "GET") return Response.json(await progress.commentReads(scope));
  if (request.method !== "POST") return Response.json({ error: "Method not allowed" }, { status: 405 });
  if (!request.headers.get("content-type")?.startsWith("application/json")) throw new Error("Expected application/json");
  const raw = await request.text();
  if (raw.length > 1_000_000) throw new Error("Request body is too large");
  const body = JSON.parse(raw);
  if (!body || !Array.isArray(body.keys) || body.keys.length > 10000 || body.keys.some((key: unknown) => typeof key !== "string" || key.length === 0 || key.length > 200)) throw new Error("Invalid comment read keys");
  return Response.json(await progress.commentReads(scope, body.keys));
}
