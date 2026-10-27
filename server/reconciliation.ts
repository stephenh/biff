import type { Storage } from "./storage";

export interface HunkReconciliation { review: string; source: "local" | "pr"; version: number }
const generations = new WeakMap<Storage, Map<string, number>>();

/** Capture a generation before asynchronous comparison or remote-flag reads. */
export function beginReconciliation(storage: Storage, review: string, source: "local" | "pr"): HunkReconciliation {
  const versions = versionsFor(storage);
  const key = `${review}:${source}`;
  const version = (versions.get(key) ?? 0) + 1;
  versions.set(key, version);
  return { review, source, version };
}

/** Newer user actions and identity merges supersede earlier network responses. */
export function currentReconciliation(storage: Storage, review: string, source: "local" | "pr", token: HunkReconciliation): boolean {
  return Boolean(review) && token.review === review && token.source === source && versionsFor(storage).get(`${review}:${source}`) === token.version;
}

/** In-flight generations are ephemeral; durable comparison heads handle restart recovery. */
export function invalidateReconciliations(storage: Storage, review: string): void {
  const versions = versionsFor(storage);
  for (const source of ["local", "pr"]) {
    const key = `${review}:${source}`;
    versions.set(key, (versions.get(key) ?? 0) + 1);
  }
}

/** All domain operations on a database share the same fetch generations. */
function versionsFor(storage: Storage): Map<string, number> {
  let versions = generations.get(storage);
  if (!versions) { versions = new Map(); generations.set(storage, versions); }
  return versions;
}
