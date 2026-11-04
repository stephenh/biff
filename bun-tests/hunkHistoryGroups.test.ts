import { describe, expect, test } from "bun:test";
import { groupHunkHistory, type HunkObservation } from "../shared/hunkHistory";

describe("hunkHistoryGroups", () => {
  test("overlap chains form one group without a stored group identity", () => {
    // Given ranges 10–12, 12–14, and 14–16 from successive observed versions
    const observations = [observation(1, 10, 3), observation(2, 12, 3), observation(3, 14, 3)];
    // When grouping at read time
    const groups = groupHunkHistory(observations);
    // Then the transitive range is one navigable group
    expect(groups).toMatchObject([{ start: 10, end: 16, versions: [{ head: "head1" }, { head: "head2" }, { head: "head3" }] }]);
  });

  test("separate ranges produce separate ordered groups", () => {
    // Given non-overlapping changes returned out of source order
    const observations = [observation(1, 100, 1), observation(2, 10, 1)];
    // When the groups are calculated
    const groups = groupHunkHistory(observations);
    // Then the file's group list follows source order
    expect(groups.map((group) => group.start)).toEqual([10, 100]);
  });

  test("split hunks from one comparison share a single version", () => {
    // Given one old region later split into two edits
    const bridge = observation(1, 10, 10);
    const left = observation(2, 10, 2);
    const right = { ...observation(3, 18, 2), head: left.head, observedAt: left.observedAt };
    // When overlap grouping collects the comparison's edits
    const groups = groupHunkHistory([bridge, left, right]);
    // Then the split comparison is one page containing both hunks
    expect(groups[0].versions.map((version) => version.hunks.map((hunk) => hunk.id))).toEqual([[1], [2, 3]]);
  });

  test("deletion-only hunks use their old-side range", () => {
    // Given two deleted-line edits near each other but with different insertion points
    const first = { ...observation(1, 1, 1), oldLine: 30, diffText: "-one\n-two\n" };
    const second = { ...observation(2, 50, 1), oldLine: 31, diffText: "-two\n" };
    // When grouping the historical edits
    const groups = groupHunkHistory([first, second]);
    // Then their deleted source ranges establish one group
    expect(groups.map((group) => [group.start, group.end])).toEqual([[30, 31]]);
  });

  test("unchanged observations do not create duplicate timeline pages", () => {
    // Given the same region observed again after an unrelated push
    const first = observation(1, 10, 1);
    const repeated = { ...observation(2, 10, 1), hunkId: first.hunkId, diffText: first.diffText };
    // When deriving its timeline
    const groups = groupHunkHistory([first, repeated]);
    // Then only one page is needed for that content at that position
    expect(groups[0].versions.map((version) => version.head)).toEqual([first.head]);
  });

  test("a returning version remains visible after an intervening edit", () => {
    // Given A, then B, then A again at the same source range
    const first = observation(1, 10, 1);
    const changed = observation(2, 10, 1);
    const returned = { ...observation(3, 10, 1), hunkId: first.hunkId, diffText: first.diffText };
    // When deriving the region's timeline
    const groups = groupHunkHistory([first, changed, returned]);
    // Then recurrence is retained rather than globally deduplicated
    expect(groups[0].versions.map((version) => version.head)).toEqual([first.head, changed.head, returned.head]);
  });

  test("moving identical edits within a group does not create another version", () => {
    // Given identical diff text at overlapping positions with distinct stored identities
    const first = observation(1, 10, 3);
    const moved = { ...observation(2, 12, 3), diffText: first.diffText };
    // When deriving the group's timeline
    const groups = groupHunkHistory([first, moved]);
    // Then source movement alone produces one page
    expect(groups).toMatchObject([{ start: 10, end: 14, versions: [{ head: first.head }] }]);
  });
});

/** Build observations with explicit source ranges and chronological ordering. */
function observation(id: number, line: number, count: number): HunkObservation {
  return { id, hunkId: `hunk${id}`, path: "example.ts", kind: "", head: `head${id}`, base: "base", observedAt: `2026-11-0${id}`, oldLine: line, newLine: line,
    diffText: Array.from({ length: count }, (_, index) => `-old${index}\n`).join("") + Array.from({ length: count }, (_, index) => `+new${id}_${index}\n`).join("") };
}
