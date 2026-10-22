import { useState } from "react";
import { diffMetrics, type DiffTiming, type ReviewTimings } from "./diffMetrics";

interface PhaseSummary { file?: string; phase: string; pass?: string; count: number; total: number; max: number }

/** Read diagnostics only on request; recording never schedules a UI update. */
export function DiffPerformance() {
  const [reviews, setReviews] = useState<ReviewTimings[]>([]);

  return <>
    <button popoverTarget="diff-performance" onClick={() => setReviews(diffMetrics.snapshot())}>Diff performance</button>
    <section id="diff-performance" className="diff-performance" popover="auto" role="dialog" aria-labelledby="diff-performance-title">
      <header><h2 id="diff-performance-title">Diff performance</h2><button onClick={() => setReviews(diffMetrics.snapshot())}>Refresh timings</button><button onClick={() => downloadTimings(reviews)} disabled={!reviews.length}>Export JSON</button><button popoverTarget="diff-performance" popoverTargetAction="hide">Close</button></header>
      <p>Local to this tab. Last 8 review loads, up to 4,000 recent samples each. No code text or remote telemetry. Exports include filenames and review labels. Refresh to update this snapshot.</p>
      <p>Times are measured work, not total PR load time. Only visited files mount their DOM; prewarm samples prepare unopened files. Inclusive totals overlap child phases; do not add them together. Cache hits do not repeat highlighting. Hunk/block numbers are native patch positions, not navigation stops.</p>
      <p>DOM commit includes HTML serialization. Layout-read timings include browser style/layout work forced by those reads. Paint opportunity uses two animation frames, not a measurement of GPU completion; slide playback is timed separately.</p>
      <p>Native virtualization mounts a viewport-sized window. Mounted source-row counts are included in JSON exports; visible-row rendering and measurement still run on warm switches. File transitions animate the incoming pane without cloning the outgoing diff.</p>
      {!reviews.length && <p>No diff timings yet. Open a review first.</p>}
      {[...reviews].reverse().map((review) => <ReviewPerformance key={review.id} review={review} />)}
    </section>
  </>;
}

/** Show review phase totals, slow file phases, and individual hunk/block work without mixing units. */
function ReviewPerformance(props: { review: ReviewTimings }) {
  const review = props.review;
  const rendered = new Set(review.samples.filter((sample) => sample.phase === "DOM post-processing").map((sample) => sample.file)).size;
  const phases = summarize(review.samples, false);
  const files = summarize(review.samples.filter((sample) => sample.file), true).sort((a, b) => b.total - a.total).slice(0, 60);
  const hunks = review.samples.filter((sample) => sample.hunk !== undefined).sort((a, b) => b.durationMs - a.durationMs).slice(0, 60);
  const mountedRows = review.samples.filter((sample) => sample.phase === "mounted source rows").map((sample) => sample.lines ?? 0);

  return <article>
    <h3>{review.label}</h3>
    <p>Load #{review.id} · {new Date(review.startedAt).toLocaleTimeString()} · {rendered} / {review.fileCount} files rendered in retained samples{review.dropped ? ` · ${review.dropped} older samples evicted; totals below are partial` : ""}</p>
    {mountedRows.length > 0 && <p>Mounted source rows: latest {mountedRows.at(-1)}, peak {Math.max(...mountedRows)} (viewport plus overscan).</p>}
    <h4>Review phase totals</h4><TimingTable entries={phases} />
    <details><summary>Slowest file phases (up to 60)</summary><TimingTable entries={files} /></details>
    <details><summary>Slowest hunk/block samples (up to 60)</summary>
      <table><thead><tr><th>File / hunk / block</th><th>Phase / pass</th><th>Time</th><th>Outcome</th></tr></thead><tbody>{hunks.map((sample, index) => <tr key={index}><td>{sample.file} · H{sample.hunk! + 1}{sample.block === undefined ? "" : ` · B${sample.block + 1}`}</td><td>{sample.phase} / {sample.pass ?? "—"}</td><td>{milliseconds(sample.durationMs)}</td><td>{sample.outcome ?? "—"}</td></tr>)}</tbody></table>
    </details>
  </article>;
}

/** Group only matching phases and passes; inclusive and exclusive timings remain separate rows. */
function TimingTable(props: { entries: PhaseSummary[] }) {
  return <table><thead><tr><th>Phase / file</th><th>Pass</th><th>Calls</th><th>Total</th><th>Max</th></tr></thead><tbody>{props.entries.map((entry, index) => <tr key={index}><td>{entry.phase}{entry.file ? ` · ${entry.file}` : ""}</td><td>{entry.pass ?? "—"}</td><td>{entry.count}</td><td>{milliseconds(entry.total)}</td><td>{milliseconds(entry.max)}</td></tr>)}</tbody></table>;
}

/** Aggregate durations without treating repeated renders as unique files or hunks. */
function summarize(samples: DiffTiming[], byFile: boolean): PhaseSummary[] {
  const groups = new Map<string, PhaseSummary>();
  for (const sample of samples) {
    const file = byFile ? sample.file : undefined;
    const key = JSON.stringify([file, sample.phase, sample.pass]);
    const group = groups.get(key) ?? { file, phase: sample.phase, pass: sample.pass, count: 0, total: 0, max: 0 };
    group.count++;
    group.total += sample.durationMs;
    group.max = Math.max(group.max, sample.durationMs);
    groups.set(key, group);
  }
  return [...groups.values()];
}

/** Keep sub-millisecond work visible without implying clock precision beyond two decimals. */
function milliseconds(duration: number): string {
  return `${duration.toFixed(2)} ms`;
}

/** Export only on an explicit user action; paths and review labels may still be private. */
function downloadTimings(reviews: ReviewTimings[]) {
  const url = URL.createObjectURL(new Blob([JSON.stringify({ version: 1, reviews }, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "biff-diff-performance.json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
