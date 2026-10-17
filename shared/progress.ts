export interface ChangeIdentity { path: string; hash: string; oldLine: number; newLine: number; duplicate: boolean }
export interface ReviewedChange extends ChangeIdentity { head: string; reviewedAt: string }

/** Duplicate identities remain position-dependent even if a later revision is unique. */
export function matchesChange(saved: ChangeIdentity, current: ChangeIdentity): boolean {
  return saved.path === current.path && saved.hash === current.hash && (!(saved.duplicate || current.duplicate) || saved.oldLine === current.oldLine && saved.newLine === current.newLine);
}
