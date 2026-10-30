import type { Storage } from "./storage";
import { viewedSync, viewedSyncScopes, deferViewedSync, observeGitHubViewed, prepareGitHubViewed, saveGitHubViewed, invalidateViewedSync, failViewedSync } from "./viewedFiles";
import { recordPullRequest } from "./reviewStore";
import { beginHunkReconciliation } from "./logicalHunks";
import type { GitHubReview, ViewedFiles, FileViewedState } from "../shared/types";
import type { GitHub } from "./github";
import { reconcilePrComparison } from "./prComparison";
import type { ReconciliationReporter } from "./reviewReconciliation";
import { parsePatchFiles } from "@pierre/diffs";
import { splitSemanticChanges } from "../shared/semanticChanges";
import { identifyChanges, identifyMetadata } from "../shared/changeProgress";

/** Project canonical hunk approvals onto GitHub's per-file Viewed flag. */
export class GitHubViewedSync {
  private running = new Map<string, Promise<void>>();
  private timer?: ReturnType<typeof setInterval>;

  constructor(private storage: Storage, private github: Pick<GitHub, "review" | "viewedFiles" | "setFileViewed" | "contents" | "pullRequest">) {}

  /** Resume durable receipts and discover approval changes without an open browser. */
  start() {
    this.timer ??= setInterval(() => this.wake(), 15000);
    this.timer.unref();
    this.wake();
  }

  /** Stop polling and let admitted writes finish before closing test storage. */
  async stop() { clearInterval(this.timer); this.timer = undefined; await Promise.all(this.running.values()); }

  /**
   * Classify a new comparison, optionally exposing files before PR-wide finalization.
   *
   * Progressive readers receive remote approvals first. File readiness then depends
   * only on source classification; outbound Viewed writes still require a complete inventory.
   */
  async prepare(repo: string, number: string, review: GitHubReview, reporter?: ReconciliationReporter) {
    const scope = `${repo.toLowerCase()}/${number}`;
    await this.serialize(scope, async () => {
      const current = viewedSync(this.storage, scope);
      if (!current?.ready || current.head !== review.pr.head.sha || current.base !== review.pr.base.sha) {
        if (reporter) {
          // Source classification may take seconds; remote approvals must be imported
          // before a ready file can accept user edits, not after those edits.
          const files = splitSemanticChanges(parsePatchFiles(review.patch, undefined, true).flatMap((entry) => entry.files));
          if (files.length !== review.pr.changed_files) throw new Error("Incomplete GitHub comparison; refresh the PR to retry");
          const token = beginHunkReconciliation(this.storage, scope, "pr");
          const remote = await this.github.viewedFiles(repo, number);
          if (Object.keys(remote.files).length !== files.length) throw new Error("Incomplete GitHub file list");
          const latest = await this.github.pullRequest(repo, number);
          if (latest.head.sha !== review.pr.head.sha || latest.base.sha !== review.pr.base.sha) throw new Error("PR changed; refresh the review");
          const units = [...await identifyChanges(files), ...await identifyMetadata(files, review.pr.head.sha)];
          if (!await prepareGitHubViewed(this.storage, scope, review.pr.head.sha, remote, units, token)) throw new Error("Review state changed; retry reconciliation");
          reporter.sharedReady();
          let reconciled = false;
          for (let attempt = 0; attempt < 3 && !reconciled; attempt++) {
            reconciled = await reconcilePrComparison(this.storage, this.github, scope, review, beginHunkReconciliation(this.storage, scope, "pr"), reporter);
          }
          if (!reconciled) throw new Error("Review changed during reconciliation; retry or refresh the review");
          // A user's edit after a file became ready must never be overwritten here.
          if (!await observeGitHubViewed(this.storage, scope, review.pr.head.sha, review.pr.base.sha, remote, beginHunkReconciliation(this.storage, scope, "pr"), false)) throw new Error("Review changed; retry reconciliation");
        } else if (!await this.observe(scope, repo, number, review)) return;
      }
      reporter?.sharedReady();
      await this.sync(scope);
    });
  }

  /** Retry registered PRs; canonical approvals are the durable desired state. */
  wake() {
    for (const scope of viewedSyncScopes(this.storage)) if (!this.running.has(scope)) void this.retry(scope);
  }

  /** Keep writes ordered per PR while unrelated PRs proceed independently. */
  retry(scope: string): Promise<void> { return this.serialize(scope, () => this.sync(scope)); }

  /** Report only acknowledged remote flags and persistent retry errors. */
  status(scope: string): ViewedFiles | undefined {
    const review = viewedSync(this.storage, scope);
    if (!review) return;
    return { files: Object.fromEntries(review.files.map((file) => [file.path, file.githubViewed ? "VIEWED" : "UNVIEWED" as FileViewedState])),
      ...(!review.ready ? { syncing: true } : {}), ...(review.error ? { syncError: review.error } : {}),
      syncErrors: review.files.filter((file) => file.error).map((file) => ({ path: file.path, error: file.error! })) };
  }

  /**
   * Observe GitHub's flags after shared comparison reconciliation has established canonical hunks.
   *
   * GitHub may truncate comparisons. Verify completeness and current head/base before importing remote
   * approvals or declaring files complete, including files whose only units are binary or mode changes.
   */
  private async observe(scope: string, repo: string, number: string, review: GitHubReview, importRemote = true): Promise<boolean> {
    await recordPullRequest(this.storage, scope, review.commits.map((commit) => commit.sha), review.pr.state === "closed", review.pr.head.sha);
    const token = beginHunkReconciliation(this.storage, scope, "pr");
    if (!await reconcilePrComparison(this.storage, this.github, scope, review, token)) {
      deferViewedSync(this.storage, scope, review.pr.head.sha);
      return false;
    }
    const remote = await this.github.viewedFiles(repo, number);
    if (Object.keys(remote.files).length !== review.pr.changed_files) throw new Error("Incomplete GitHub file list; Viewed flags were retained");
    const latest = await this.github.pullRequest(repo, number);
    if (latest.head.sha !== review.pr.head.sha || latest.base.sha !== review.pr.base.sha) {
      deferViewedSync(this.storage, scope, review.pr.head.sha);
      return false;
    }
    return observeGitHubViewed(this.storage, scope, review.pr.head.sha, review.pr.base.sha, remote, token, importRemote);
  }

  /** Re-read canonical completion before each write so a newer approval reversal wins on the next pass. */
  private async sync(scope: string) {
    let review = viewedSync(this.storage, scope);
    if (!review) return;
    const [owner, name, number] = scope.split("/");
    const repo = `${owner}/${name}`;
    try {
      if (review.ready && !review.error && !review.files.some((file) => file.error || file.desired !== file.githubViewed)) return;
      const pr = await this.github.pullRequest(repo, number);
      if (!review.ready || pr.head.sha !== review.head || pr.base.sha !== review.base) {
        if (!await this.observe(scope, repo, number, await this.github.review(repo, number, "all"), false)) return;
        review = viewedSync(this.storage, scope)!;
      }
      for (const entry of review.files) {
        const current = viewedSync(this.storage, scope, entry.path);
        if (!current?.ready || current.head !== review.head || current.base !== review.base) return;
        const file = current.files.find((file) => file.path === entry.path);
        if (!file) continue;
        if (file.desired === file.githubViewed) {
          if (file.error) saveGitHubViewed(this.storage, scope, review.head, review.base, file.path, undefined);
          continue;
        }
        try {
          await this.github.setFileViewed(repo, number, file.path, file.desired);
          saveGitHubViewed(this.storage, scope, review.head, review.base, file.path, file.desired);
          const latest = await this.github.pullRequest(repo, number);
          if (latest.head.sha !== review.head || latest.base.sha !== review.base) {
            invalidateViewedSync(this.storage, scope, review, latest.head.sha);
            return;
          }
        } catch (cause) {
          saveGitHubViewed(this.storage, scope, review.head, review.base, file.path, undefined, cause instanceof Error ? cause.message : String(cause));
        }
      }
      failViewedSync(this.storage, scope);
    } catch (cause) { failViewedSync(this.storage, scope, cause instanceof Error ? cause.message : String(cause)); }
  }

  /** Coalesce polling while an existing reconciliation already owns this PR. */
  private serialize(scope: string, work: () => Promise<void>): Promise<void> {
    const pending = this.running.get(scope);
    if (pending) return pending.catch(() => {}).then(() => this.serialize(scope, work));
    const task = work().finally(() => this.running.delete(scope));
    this.running.set(scope, task);
    return task;
  }
}
