import type { ReviewLine } from "../shared/types";

/** Restore only the explicit file URL, never a different file or comparison. */
export function readReviewPosition(scope: string | undefined, path: string | undefined): ReviewLine | undefined {
  if (!scope || !path) return;
  try {
    const saved: unknown = JSON.parse(sessionStorage.getItem(`biff:position:${scope}`) ?? "null");
    if (!saved || typeof saved !== "object" || !("path" in saved) || saved.path !== path
      || !("line" in saved) || typeof saved.line !== "number" || !Number.isSafeInteger(saved.line) || saved.line < 1
      || !("side" in saved) || (saved.side !== "LEFT" && saved.side !== "RIGHT")) return;
    return { path, line: saved.line, side: saved.side };
  } catch { /* Browser storage is optional for the reading cursor. */ }
}

/** Keep tab-local source coordinates independent of commit hashes and hunk identities. */
export function saveReviewPosition(scope: string | undefined, line: ReviewLine) {
  if (!scope) return;
  try { sessionStorage.setItem(`biff:position:${scope}`, JSON.stringify(line)); }
  catch { /* Browser storage is optional for the reading cursor. */ }
}
