import type { Storage } from "./storage";
import type { ReconciliationStatus } from "../shared/reconciliation";

interface Job {
  status: ReconciliationStatus;
  work: (report: ReconciliationReporter) => Promise<void>;
  shared: ReturnType<typeof Promise.withResolvers<void>>;
  done: Promise<void>;
}
export interface ReconciliationReporter {
  sharedReady(): void;
  running(path: string): void;
  ready(path: string): void;
}
const jobs = new WeakMap<Storage, Map<string, Job>>();

/** Admit one job per comparison; serialize replacements so old work cannot finish over a new snapshot. */
export function startReviewReconciliation(storage: Storage, scope: string, comparison: Pick<ReconciliationStatus, "head" | "base">, paths: string[], work: Job["work"]): ReconciliationStatus {
  let entries = jobs.get(storage);
  if (!entries) { entries = new Map(); jobs.set(storage, entries); }
  const previous = entries.get(scope);
  if (previous && previous.status.head === comparison.head && previous.status.base === comparison.base) return previous.status;
  const job: Job = { status: { ...comparison, state: "running", files: Object.fromEntries(paths.map((path) => [path, "pending"])) }, work, shared: Promise.withResolvers<void>(), done: Promise.resolve() };
  entries.set(scope, job);
  run(job, previous?.done);
  return job.status;
}

/** Status reads do not start new work or require a synthetic reconciliation identity. */
export function reviewReconciliation(storage: Storage, scope: string): ReconciliationStatus | undefined {
  return jobs.get(storage)?.get(scope)?.status;
}

/** State endpoints wait only for shared approvals and attachments, never for other files' source. */
export async function waitForReviewState(storage: Storage, scope: string): Promise<void> {
  await jobs.get(storage)?.get(scope)?.shared.promise;
}

/** Drain admitted work before closing its database, including failed jobs. */
export async function settleReviewReconciliations(storage: Storage): Promise<void> {
  await Promise.all([...jobs.get(storage)?.values() ?? []].map((job) => job.done));
}

/** A failed job retains its comparison and work so Retry works after navigating away. */
export function retryReviewReconciliation(storage: Storage, scope: string): ReconciliationStatus | undefined {
  const job = jobs.get(storage)?.get(scope);
  if (job?.status.state === "failed") {
    job.shared = Promise.withResolvers<void>();
    job.status = { ...job.status, state: "running", error: undefined, files: Object.fromEntries(Object.entries(job.status.files).map((entry) => [entry[0], entry[1] === "ready" ? "ready" : "pending"])) };
    run(job);
  }
  return job?.status;
}

/** Catch background failures and expose them through status rather than unhandled rejections. */
function run(job: Job, previous?: Promise<void>) {
  void job.shared.promise.catch(() => {});
  job.done = Promise.resolve(previous).then(async () => {
    try {
      await job.work({ sharedReady: () => job.shared.resolve(), running: (path) => { if (job.status.files[path] !== "ready") job.status.files[path] = "running"; }, ready: (path) => { job.status.files[path] = "ready"; } });
      job.shared.resolve();
      for (const path of Object.keys(job.status.files)) job.status.files[path] = "ready";
      job.status.state = "ready";
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      job.status.state = "failed";
      job.status.error = error.message;
      for (const path of Object.keys(job.status.files)) if (job.status.files[path] !== "ready") job.status.files[path] = "failed";
      job.shared.reject(error);
    }
  });
}
