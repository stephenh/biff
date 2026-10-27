import type { Storage } from "./storage";
import { commentReadSnapshot, commentReads } from "./reviewStore";
import type { Activity } from "../shared/inbox";
import { commentReadKey, isAutoReadAuthor } from "../shared/commentActivity";

/** Limit acknowledgement to the displayed message snapshot; late replies stay unread. */
export function receiptSnapshot(value: unknown, available: string[]): string[] {
  if (value === undefined) return available;
  // A displayed message may have been deleted before this request arrived; its receipt is harmless.
  if (!Array.isArray(value) || value.length > 10000 || value.some((key) => typeof key !== "string" || key.length === 0 || key.length > 200)) throw new Error("Invalid thread read keys");
  return [...new Set(value as string[])];
}

/** Persist automatic acknowledgements through the same receipt store as explicit reads. */
export async function autoReadComments(storage: Storage, scope: string, events: Activity[]): Promise<void> {
  const saved = new Set(commentReadSnapshot(storage, scope));
  const keys = events.filter((event) => isAutoReadAuthor(event.actor)).map(commentReadKey).filter((key) => !saved.has(key));
  if (keys.length) await commentReads(storage, scope, keys);
}

/** Share durable message read receipts across ordinary and collaboration review routes. */
export async function commentReadsResponse(request: Request, storage: Storage, scope: string): Promise<Response> {
  if (request.method === "GET") return Response.json(await commentReads(storage, scope));
  if (request.method !== "POST") return Response.json({ error: "Method not allowed" }, { status: 405 });
  if (!request.headers.get("content-type")?.startsWith("application/json")) throw new Error("Expected application/json");
  const raw = await request.text();
  if (raw.length > 1_000_000) throw new Error("Request body is too large");
  const body = JSON.parse(raw);
  if (!body || !Array.isArray(body.keys) || body.keys.length > 10000 || body.keys.some((key: unknown) => typeof key !== "string" || key.length === 0 || key.length > 200)) throw new Error("Invalid comment read keys");
  return Response.json(await commentReads(storage, scope, body.keys));
}
