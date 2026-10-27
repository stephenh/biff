import type { Storage } from "./storage";
import { viewedSync, viewedSyncScopes, deferViewedSync, observeGitHubViewed, saveGitHubViewed, invalidateViewedSync, failViewedSync } from "./viewedFiles";
import { recordPullRequest } from "./reviewStore";
import { beginHunkReconciliation } from "./logicalHunks";
import type { GitHubReview, ViewedFiles, FileViewedState } from "../shared/types";
import type { GitHub } from "./github";
import { reconcilePrComparison } from "./prComparison";

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

  /** Classify a new complete comparison once, then synchronize its derived file state. */
  async prepare(repo: string, number: string, review: GitHubReview) {
    const scope = `${repo.toLowerCase()}/${number}`;
    await this.serialize(scope, async () => {
      const current = viewedSync(this.storage, scope);
      if (!current?.ready || current.head !== review.pr.head.sha || current.base !== review.pr.base.sha) {
        if (!await this.observe(scope, repo, number, review)) return;
      }
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
    if (latest.head.sha !== review.pr.head.sha || latest.base.sha !== review.pr.base.sha) throw new Error("PR changed while refreshing Viewed flags; retrying on the next refresh");
    return observeGitHubViewed(this.storage, scope, review.pr.head.sha, review.pr.base.sha, remote, token, importRemote);
  }

  /** Re-read canonical completion before each write so a newer approval reversal wins on the next pass. */
  private async sync(scope: string) {
    let review = viewedSync(this.storage, scope);
    if (!review) return;
    const [owner, name, number] = scope.split("/");
    const repo = `${owner}/${name}`;
    try {
      if (review.ready && !review.files.some((file) => file.error || file.desired !== file.githubViewed)) return;
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
