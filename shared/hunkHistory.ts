import { hunkLineCounts, type HunkText } from "./hunkText";
import type { ChangeIdentity } from "./progress";

export interface HunkComparison { head: string; base: string }
export interface SeenHunk extends ChangeIdentity { seenAt: string; present: boolean }
export interface SeenHunks extends HunkComparison { hunks: SeenHunk[] }

export interface HunkObservation extends HunkText {
  id: number;
  hunkId: string;
  path: string;
  kind: string;
  head: string;
  base: string;
  observedAt: string | null;
}
export interface HunkHistory { observations: HunkObservation[]; missing: number; backfillError?: string }
export interface HunkHistoryVersion { head: string; base: string; observedAt: string | null; hunks: HunkObservation[] }
export interface HunkHistoryGroup { start: number; end: number; versions: HunkHistoryVersion[] }

/**
 * Group intersecting source ranges, then collect each comparison's hunks into a version.
 *
 * These are approximate regions, not ancestry. I.e. ranges 10–20, 18–25, and 24–30
 * become one group 10–30 even if the first and last hunks do not overlap directly.
 */
export function groupHunkHistory(observations: HunkObservation[]): HunkHistoryGroup[] {
  const regions = observations.map((hunk) => {
    const counts = hunkLineCounts(hunk.diffText);
    const start = counts.new ? hunk.newLine : hunk.oldLine;
    return { hunk, start, end: start + Math.max(1, counts.new || counts.old) - 1 };
  }).sort((a, b) => a.start - b.start || a.end - b.end || a.hunk.id - b.hunk.id);
  const groups: (HunkHistoryGroup & { observations: HunkObservation[] })[] = [];
  for (const region of regions) {
    let group = groups.at(-1);
    if (!group || region.start > group.end) {
      group = { start: region.start, end: region.end, versions: [], observations: [] };
      groups.push(group);
    }
    group.end = Math.max(group.end, region.end);
    group.observations.push(region.hunk);
  }
  for (const group of groups) {
    const versions = new Map<string, HunkHistoryVersion>();
    for (const hunk of group.observations.sort((a, b) => (a.observedAt ?? "").localeCompare(b.observedAt ?? "") || a.id - b.id)) {
      const key = `${hunk.head}:${hunk.base}`;
      let version = versions.get(key);
      if (!version) { version = { head: hunk.head, base: hunk.base, observedAt: hunk.observedAt, hunks: [] }; versions.set(key, version); }
      version.hunks.push(hunk);
    }
    group.versions = [...versions.values()];
    for (const version of group.versions) version.hunks.sort((a, b) => a.newLine - b.newLine || a.oldLine - b.oldLine || a.id - b.id);
    // Unrelated pushes can observe the same region repeatedly. Keep a returning version
    // after an intervening edit, but do not make readers page through unchanged content.
    group.versions = group.versions.filter((version, index, all) => index === 0 || versionSignature(version) !== versionSignature(all[index - 1]));
  }
  return groups.map((group) => ({ start: group.start, end: group.end, versions: group.versions }));
}

/** Once grouped, source movement alone does not make a new version of the edits. */
function versionSignature(version: HunkHistoryVersion): string {
  return JSON.stringify(version.hunks.map((hunk) => [hunk.kind, hunk.diffText]));
}
