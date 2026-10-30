export type ReconciliationState = "pending" | "running" | "ready" | "failed";

/** Readiness belongs to an immutable comparison, even though its URL belongs to a review. */
export interface ReconciliationStatus {
  head: string;
  base: string | null;
  state: ReconciliationState;
  files: Record<string, ReconciliationState>;
  error?: string;
}
