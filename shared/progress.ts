export interface ChangeIdentity { path: string; hash: string; oldLine: number; newLine: number; duplicate: boolean; kind?: "file" }
export interface ReviewedChange extends ChangeIdentity { head: string; reviewedAt: string }
export interface ReviewIdentity { id: string; pr?: string; local?: { workspace: string; bookmark: string }; closed: boolean }

/** Duplicate identities remain position-dependent even if a later revision is unique. */
export function matchesChange(saved: ChangeIdentity, current: ChangeIdentity): boolean {
  return saved.kind === current.kind && saved.path === current.path && saved.hash === current.hash && (!(saved.duplicate || current.duplicate) || saved.oldLine === current.oldLine && saved.newLine === current.newLine);
}

/** Generated files stay reviewed after edits and never contribute to hunk totals. */
export function isAutoReviewedFile(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return path === "schema.graphql" || path === "yarn.lock" || path === "schema/enums.graphql"
    || name === ".history.json" || name === "metadata.ts" || name.endsWith("Codegen.ts");
}
