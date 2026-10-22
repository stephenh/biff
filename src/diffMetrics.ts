import type { FileDiffMetadata } from "@pierre/diffs";

export interface DiffTiming {
  phase: string;
  durationMs: number;
  file?: string;
  /** Zero-based native patch hunk and replacement-block indexes, not navigation stops. */
  hunk?: number;
  block?: number;
  pass?: string;
  outcome?: string;
  lines?: number;
  characters?: number;
}
export interface ReviewTimings {
  id: number;
  label: string;
  startedAt: string;
  fileCount: number;
  dropped: number;
  samples: DiffTiming[];
}

/** Keep bounded, tab-local diagnostics without storage writes or React notifications on the hot path. */
export class DiffMetrics {
  private reviews: (ReviewTimings & { nextSample: number })[] = [];
  private sequence = 0;

  constructor(private reviewLimit = 8, private sampleLimit = 4000) {}

  /** Each preparation gets its own identity, even when a PR is opened again. */
  begin(label: string): number {
    const id = ++this.sequence;
    this.reviews.push({ id, label, startedAt: new Date().toISOString(), fileCount: 0, dropped: 0, samples: [], nextSample: 0 });
    if (this.reviews.length > this.reviewLimit) this.reviews.shift();
    return id;
  }

  /** Late completions from evicted reviews must not attach to a newer review. */
  record(id: number, timing: DiffTiming) {
    const review = this.reviews.find((entry) => entry.id === id);
    if (!review || !Number.isFinite(timing.durationMs) || timing.durationMs < 0) return;
    if (review.samples.length === this.sampleLimit) {
      review.samples[review.nextSample] = { ...timing };
      review.nextSample = (review.nextSample + 1) % this.sampleLimit;
      review.dropped++;
    } else review.samples.push({ ...timing });
  }

  /** Count parsed files separately from files that were actually rendered. */
  files(id: number, count: number) {
    const review = this.reviews.find((entry) => entry.id === id);
    if (review) review.fileCount = count;
  }

  /** Reports are copies so inspecting or exporting them cannot affect recording. */
  snapshot(): ReviewTimings[] {
    return this.reviews.map((review) => ({
      id: review.id, label: review.label, startedAt: review.startedAt, fileCount: review.fileCount, dropped: review.dropped,
      samples: [...review.samples.slice(review.nextSample), ...review.samples.slice(0, review.nextSample)].map((sample) => ({ ...sample })),
    }));
  }
}

export const diffMetrics = new DiffMetrics();
const fileReviews = new WeakMap<FileDiffMetadata, number>();

/** Retain review attribution through navigation without keeping parsed diffs alive. */
export function trackDiffFile(file: FileDiffMetadata, review: number) {
  fileReviews.set(file, review);
}

/** Hydrated metadata still belongs to the originally parsed review and file. */
export function inheritDiffTracking(original: FileDiffMetadata, hydrated: FileDiffMetadata) {
  const review = fileReviews.get(original);
  if (review !== undefined) fileReviews.set(hydrated, review);
}

/** The viewer owns attribution even when Pierre replaces metadata during source hydration. */
export function recordFileTiming(file: FileDiffMetadata, timing: DiffTiming) {
  const review = fileReviews.get(file);
  if (review !== undefined) diffMetrics.record(review, { ...timing, file: file.name });
}
