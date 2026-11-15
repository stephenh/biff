import type { SymbolFile } from "../shared/symbols";
import type { SymbolSource } from "./symbolIndexes";

/** Validate only immutable source selectors and bounded file manifests, never caller-supplied source text. */
export function symbolRequest(body: Record<string, unknown>): { head: string; base?: string; single: boolean; retry: boolean; files: SymbolFile[]; revision: string } {
  if (typeof body.head !== "string" || !/^(?:[a-f0-9]{40,64}|worktree:[^\s]{1,200})$/.test(body.head)) throw new Error("Invalid symbol head revision");
  if (body.base !== undefined && (typeof body.base !== "string" || !/^[a-f0-9]{40,64}$/.test(body.base))) throw new Error("Invalid symbol base revision");
  if (!Array.isArray(body.files) || body.files.length > 5000) throw new Error("Invalid symbol file list");
  const files: SymbolFile[] = body.files.map((entry: unknown) => {
    if (!entry || typeof entry !== "object" || !("path" in entry) || !("oldPath" in entry)) throw new Error("Invalid symbol file");
    return { path: sourcePath(entry.path), oldPath: sourcePath(entry.oldPath) };
  });
  const head = body.head;
  const base = body.base as string | undefined;
  const single = body.single === true;
  return { head, base, single, retry: body.retry === true, files, revision: JSON.stringify([head, base ?? null, single]) };
}

/** Share the request manifest with polling; callbacks stay server-owned and never cross the wire. */
export function symbolSource(scope: string, request: ReturnType<typeof symbolRequest>, load: SymbolSource["load"]): SymbolSource {
  return { scope, revision: request.revision, files: request.files, load };
}

/** Paths are repository-relative; temporary parser paths are independently constructed from basenames. */
function sourcePath(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 4096 || value.startsWith("/") || value.split("/").some((part) => part === "..") || /[\0\r\n]/.test(value)) throw new Error("Invalid symbol source path");
  return value;
}
