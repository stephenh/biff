export interface ChangeIdentity { path: string; hash: string; oldLine: number; newLine: number; duplicate: boolean; kind?: "file" | "metadata" }
export interface ReviewedChange extends ChangeIdentity { head: string; reviewedAt: string }
export interface ReviewIdentity { id: string; pr?: string; local?: { workspace: string; bookmark: string }; closed: boolean }

/** Empty/excluded files need no approval; non-text changes are explicit review units. */
export function fileReviewed(path: string, units: ChangeIdentity[], reviewed: (unit: ChangeIdentity) => boolean): boolean {
  return isAutoReviewedFile(path) || units.every(reviewed);
}

/** Stable queue identity retains coordinates even for currently unique edits. */
export function changeKey(change: ChangeIdentity): string {
  return JSON.stringify([change.path, change.kind ?? "", change.hash, change.oldLine, change.newLine, change.duplicate]);
}

/** Duplicate identities remain position-dependent even if a later revision is unique. */
export function matchesChange(saved: ChangeIdentity, current: ChangeIdentity): boolean {
  return saved.kind === current.kind && saved.path === current.path && saved.hash === current.hash && (!(saved.duplicate || current.duplicate) || saved.oldLine === current.oldLine && saved.newLine === current.newLine);
}

/** Generated files stay reviewed after edits and never contribute to hunk totals. */
export function isAutoReviewedFile(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return path === "schema.graphql" || path === "yarn.lock" || path === "schema/enums.graphql"
    || path === "graphql-codegen-joist.mjs"
    || path === "src/entities/entities.ts" || path === "src/entities/codegen/metadata-docs.ts"
    || name === ".history.json" || name === "metadata.ts" || name.endsWith("Codegen.ts");
}
