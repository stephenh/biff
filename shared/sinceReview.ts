import type { ChangeIdentity } from "./progress";

export interface SinceReview {
  review?: { id: number; head: string; base: string; submittedAt: string | null };
  head: string | null;
  base: string | null;
  hunks: (ChangeIdentity & { sinceReview: "existing" | "new"; present: boolean })[];
}
