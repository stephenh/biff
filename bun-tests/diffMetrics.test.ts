import { describe, expect, test } from "bun:test";
import { DiffMetrics, diffMetrics, measureFileTiming, recordFileTiming } from "../src/diffMetrics";
import { parseInput } from "../src/patches";
import { createTwoFilesPatch } from "diff";

describe("diffMetrics", () => {
  test("reopening the same PR keeps separate load identities", () => {
    // Given two preparations of the same review
    const metrics = new DiffMetrics();
    const first = metrics.begin("PR 12");
    const second = metrics.begin("PR 12");

    // When both loads finish work
    metrics.record(first, { phase: "patch parsing", durationMs: 12 });
    metrics.record(second, { phase: "patch parsing", durationMs: 3 });

    // Then their samples remain separate
    expect(metrics.snapshot().map((review) => review.samples)).toEqual([[{ phase: "patch parsing", durationMs: 12 }], [{ phase: "patch parsing", durationMs: 3 }]]);
  });

  test("late work for an evicted review cannot contaminate the current review", () => {
    // Given a buffer that holds only one review
    const metrics = new DiffMetrics(1);
    const old = metrics.begin("Old PR");
    metrics.begin("Current PR");

    // When an old source request completes
    metrics.record(old, { phase: "source fetch", durationMs: 100 });

    // Then only the current review remains and has no old work
    expect(metrics.snapshot()).toMatchObject([{ label: "Current PR", samples: [] }]);
  });

  test("sample limits retain recent work in chronological order", () => {
    // Given space for two samples in one review
    const metrics = new DiffMetrics(1, 2);
    const review = metrics.begin("Large PR");

    // When recording wraps the ring buffer more than once
    for (let durationMs = 1; durationMs <= 5; durationMs++) metrics.record(review, { phase: "syntax rendering", durationMs });

    // Then the bounded report keeps the latest samples and discloses omissions
    expect(metrics.snapshot()).toMatchObject([{ dropped: 3, samples: [{ durationMs: 4 }, { durationMs: 5 }] }]);
  });

  test("reports cannot mutate the live collector", () => {
    // Given a recorded file timing
    const metrics = new DiffMetrics();
    const review = metrics.begin("PR 12");
    const timing = { phase: "syntax rendering", durationMs: 8 };
    metrics.record(review, timing);

    // When the caller and a report consumer mutate their copies
    timing.durationMs = 90;
    metrics.snapshot()[0].samples[0].durationMs = 100;

    // Then the recorded measurement is unchanged
    expect(metrics.snapshot()[0].samples).toEqual([{ phase: "syntax rendering", durationMs: 8 }]);
  });

  test("invalid durations never poison phase totals", () => {
    // Given a new collector
    const metrics = new DiffMetrics();
    const review = metrics.begin("PR 12");

    // When invalid clock measurements arrive
    for (const durationMs of [-1, NaN, Infinity]) metrics.record(review, { phase: "patch parsing", durationMs });

    // Then there are no unusable samples
    expect(metrics.snapshot()[0].samples).toEqual([]);
  });

  test("file samples retain their review attribution after another review opens", () => {
    // Given a parsed review and then a different review
    const patch = createTwoFilesPatch("example.ts", "example.ts", "const oldName = 1;\n", "const newName = 1;\n");
    const [file] = parseInput(patch, false, "First review");
    parseInput(patch, false, "Second review");

    // When the first file finishes a background operation
    recordFileTiming(file, { phase: "source fetch", durationMs: 15 });

    // Then the measurement still belongs to its original review
    expect(diffMetrics.snapshot().filter((review) => review.samples.some((sample) => sample.phase === "source fetch")).map((review) => review.label)).toEqual(["First review"]);
  });

  test("preparation records phase costs and parsed file counts", () => {
    // Given a real patch
    const patch = createTwoFilesPatch("metrics.ts", "metrics.ts", "const before = 1;\n", "const after = 1;\n");

    // When the viewer prepares it with diagnostics enabled
    parseInput(patch, false, "Preparation test");

    // Then the review captures preparation phases without storing source text
    expect(diffMetrics.snapshot().at(-1)).toMatchObject({ label: "Preparation test", fileCount: 1, samples: [
      { phase: "whitespace filtering", durationMs: expect.any(Number) },
      { phase: "patch parsing", durationMs: expect.any(Number) },
      { phase: "semantic splitting", file: "metrics.ts", durationMs: expect.any(Number) },
      { phase: "review preparation (inclusive)", durationMs: expect.any(Number), characters: patch.length },
    ] });
  });

  test("measured work retains its file attribution and phase", () => {
    // Given a parsed file registered with the collector
    const [file] = parseInput(createTwoFilesPatch("/dev/null", "timed.ts", "", 'const value = 1;\n'), false, "Timed work");

    // When timing synchronous work on that file
    measureFileTiming(file, "test DOM update", () => 42);

    // Then the diagnostic sample has the original resource and a finite duration
    expect(diffMetrics.snapshot().at(-1)?.samples.at(-1)).toEqual({ file: "timed.ts", phase: "test DOM update", durationMs: expect.any(Number) });
  });

  test("measurement preserves the operation's return value", () => {
    // Given a file with a synchronous operation
    const [file] = parseInput(createTwoFilesPatch("/dev/null", "timed.ts", "", 'const value = 1;\n'));

    // When diagnostics wrap the operation
    const result = measureFileTiming(file, "test work", () => 42);

    // Then callers receive the original result without awaiting anything
    expect(result).toBe(42);
  });

  test("measurement does not swallow the operation's errors", () => {
    // Given an operation that fails
    const [file] = parseInput(createTwoFilesPatch("/dev/null", "timed.ts", "", 'const value = 1;\n'));
    const error = new Error("Original failure");

    // When timing the failing operation
    // Then the original failure still reaches the caller
    expect(() => measureFileTiming(file, "test work", () => { throw error; })).toThrow(error);
  });
});
