import type { HunkReconciliation } from "./reconciliation";
import type { Storage } from "./storage";
import { needsPrComparison, reconcileHunks } from "./logicalHunks";
import { parsePatchFiles } from "@pierre/diffs";
import { identifyChanges, identifyMetadata, isImportOnly } from "../shared/changeProgress";
import { importSourceMayHelp, findImportGroups } from "../shared/importGroups";
import { splitSemanticChanges } from "../shared/semanticChanges";
import { isAutoReviewedFile } from "../shared/progress";
import type { GitHubReview } from "../shared/types";
import type { GitHub } from "./github";
import type { ReconciliationReporter } from "./reviewReconciliation";
/**
 * Register a complete PR comparison for both thread tracking and file completion.
 *
 * Classification belongs to canonical hunks. Remote Viewed flags are observed separately, after
 * this succeeds; neither a partial diff nor an outdated fetch can establish current presence.
 */
export async function reconcilePrComparison(storage: Storage, github: Pick<GitHub, "contents" | "pullRequest">, scope: string,
  review: Pick<GitHubReview, "pr" | "patch" | "commit">, token: HunkReconciliation, reporter?: ReconciliationReporter): Promise<boolean> {
  const head = review.pr.head.sha;
  const base = review.pr.base.sha;
  if (review.commit !== "all") return false;
  if (!needsPrComparison(storage, scope, head, base)) return true;
  const files = splitSemanticChanges(parsePatchFiles(review.patch, undefined, true).flatMap((entry) => entry.files));
  if (review.pr.changed_files === undefined || files.length !== review.pr.changed_files) return false;
  const blocks = await identifyChanges(files);
  const metadata = await identifyMetadata(files, head);
  const [owner, name, number] = scope.split("/");
  const repo = `${owner}/${name}`;
  const groupsByFile: ReturnType<typeof findImportGroups>[] = [];
  let cursor = 0;

  // Bound GitHub traffic while overlapping independent files. Keep results in
  // patch order so request completion order cannot change canonical hunk order.
  const results = await Promise.allSettled(Array.from({ length: Math.min(3, files.length) }, () => classifyFiles()));
  const failure = results.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
  const units = [];
  for (const [index, file] of files.entries()) {
    const groups = groupsByFile[index];
    const auto = isAutoReviewedFile(file.name);
    for (const block of blocks.filter((block) => block.fileIndex === index)) units.push({ ...block, reviewable: !auto && !isImportOnly(block, groups) });
    for (const unit of metadata.filter((unit) => unit.path === file.name)) units.push({ ...unit, reviewable: !auto });
  }
  const latest = await github.pullRequest(repo, number);
  if (latest.head.sha !== head || latest.base.sha !== base) return false;
  return reconcileHunks(storage, scope, units, head, "pr", token, base);

  /** Share a cursor so each worker starts another file as soon as it is free. */
  async function classifyFiles() {
    while (cursor < files.length) {
      const index = cursor++;
      const file = files[index];
      reporter?.running(file.name);
      const contents = importSourceMayHelp(file) ? await github.contents(repo, number, head, base, file.name, file.prevName ?? file.name, false) : undefined;
      groupsByFile[index] = findImportGroups(file, contents);
      reporter?.ready(file.name);
    }
  }
}
