import { parsePatchFiles } from "@pierre/diffs";
import { identifyChanges, identifyFiles, isImportOnly } from "../src/changeProgress";
import { importSourceMayHelp } from "../src/importGroups";
import { importGroups } from "../src/importFolds";
import { splitSemanticChanges } from "../shared/semanticChanges";
import { isAutoReviewedFile, matchesChange, type ChangeIdentity, type ReviewedChange } from "../shared/progress";
import type { GitHubReview, ViewedFiles, FileViewedState } from "../shared/types";
import type { Progress } from "./progress";
import type { GitHub } from "./github";

interface SyncFile { identity: ChangeIdentity; blocks: ChangeIdentity[]; reviewable: ChangeIdentity[]; metadata: boolean; acknowledged: boolean; error?: string }
export interface GitHubFileReview { repo: string; number: string; head: string; files: SyncFile[] }

/** Reconcile durable Biff progress with GitHub without depending on an open browser. */
export class ViewedSync {
  private running = new Map<string, Promise<void>>();
  private timer?: ReturnType<typeof setInterval>;

  constructor(private progress: Progress, private github: Pick<GitHub, "review" | "viewedFiles" | "setFileViewed" | "contents" | "pullRequest">) {}

  /** Resume unfinished synchronization after daemon restarts and discover linked local progress. */
  start() {
    this.timer ??= setInterval(() => this.wake(), 15000);
    this.timer.unref();
    this.wake();
  }

  /** Stop polling and let admitted writes finish before closing test storage. */
  async stop() { clearInterval(this.timer); this.timer = undefined; await Promise.all(this.running.values()); }

  /** Pin reconciliation to a server-loaded diff and import GitHub marks once per head. */
  async prepare(repo: string, number: string, review: GitHubReview) {
    const scope = `${repo.toLowerCase()}/${number}`;
    await this.serialize(scope, async () => {
      const current = this.progress.githubFileReview(scope);
      if (current?.head !== review.pr.head.sha) await this.snapshot(scope, repo, number, review);
      await this.sync(scope);
    });
  }

  /** Retry durable work; callers can leave immediately without abandoning the write. */
  wake() {
    for (const review of this.progress.githubFileReviews()) {
      const scope = `${review.repo.toLowerCase()}/${review.number}`;
      if (!this.running.has(scope)) void this.retry(scope);
    }
  }

  /** Keep writes ordered for each PR while unrelated PRs proceed independently. */
  retry(scope: string): Promise<void> { return this.serialize(scope, () => this.sync(scope)); }

  /** Report acknowledged GitHub marks and persistent failures to any mounted view. */
  status(scope: string): ViewedFiles | undefined {
    const review = this.progress.githubFileReview(scope);
    if (!review) return;
    return { files: Object.fromEntries(review.files.map((file) => [file.identity.path, file.acknowledged ? "VIEWED" : "UNVIEWED" as FileViewedState])), syncErrors: review.files.filter((file) => file.error).map((file) => ({ path: file.identity.path, error: file.error! })) };
  }

  /** Save the classification needed for future retries without keeping the whole source in SQLite. */
  private async snapshot(scope: string, repo: string, number: string, review: GitHubReview) {
    const files = splitSemanticChanges(parsePatchFiles(review.patch, undefined, true).flatMap((entry) => entry.files));
    const blocks = await identifyChanges(files);
    const identities = await identifyFiles(files, blocks, review.pr.head.sha);
    const remote = await this.github.viewedFiles(repo, number);
    const result: SyncFile[] = [];
    for (const [index, file] of files.entries()) {
      const contents = importSourceMayHelp(file) ? await this.github.contents(repo, number, review.pr.head.sha, review.pr.base.sha, file.name, file.prevName ?? file.name, false) : undefined;
      const groups = importGroups(file, contents);
      const own = blocks.filter((block) => block.fileIndex === index);
      const acknowledged = remote.files[file.name] === "VIEWED";
      if (acknowledged) await this.progress.update(scope, identities[index], true, review.pr.head.sha, own);
      result.push({ identity: identities[index], blocks: own, reviewable: own.filter((block) => !isImportOnly(block, groups)), metadata: Boolean(file.prevName || file.prevMode || !file.hunks.length || ((file.type === "new" || file.type === "deleted") && file.mode && file.mode !== "100644")), acknowledged });
    }
    await this.progress.saveGitHubFileReview(scope, { repo, number, head: review.pr.head.sha, files: result });
  }

  /** Only acknowledged writes advance the remote snapshot; failures remain retryable in SQLite. */
  private async sync(scope: string) {
    let review = this.progress.githubFileReview(scope);
    if (!review) return;
    try {
      let records = await this.progress.get(scope);
      if (!review.files.some((file) => file.error || fileReviewed(file, records) !== file.acknowledged)) return;
      const pr = await this.github.pullRequest(review.repo, review.number);
      if (pr.head.sha !== review.head) {
        await this.snapshot(scope, review.repo, review.number, await this.github.review(review.repo, review.number, "all"));
        review = this.progress.githubFileReview(scope)!;
        records = await this.progress.get(scope);
      }
      for (const file of review.files) {
        // Re-read before each write so a reversal during a slow GitHub call wins on the next pass.
        records = await this.progress.get(scope);
        const viewed = fileReviewed(file, records);
        if (viewed === file.acknowledged) { delete file.error; continue; }
        try {
          await this.github.setFileViewed(review.repo, review.number, file.identity.path, viewed);
          file.acknowledged = viewed;
          delete file.error;
        } catch (cause) { file.error = cause instanceof Error ? cause.message : String(cause); }
        await this.progress.saveGitHubFileReview(scope, review);
      }
      await this.progress.saveGitHubFileReview(scope, review);
    } catch (cause) {
      for (const file of review.files) file.error = cause instanceof Error ? cause.message : String(cause);
      await this.progress.saveGitHubFileReview(scope, review);
    }
  }

  /** Coalesce polling while an existing reconciliation already owns this PR. */
  private serialize(scope: string, work: () => Promise<void>): Promise<void> {
    const pending = this.running.get(scope);
    if (pending) return pending.then(() => this.serialize(scope, work));
    const task = work().finally(() => this.running.delete(scope));
    this.running.set(scope, task);
    return task;
  }
}

/** File metadata requires explicit approval; text-only files can finish block by block. */
function fileReviewed(file: SyncFile, records: ReviewedChange[]): boolean {
  if (isAutoReviewedFile(file.identity.path) || records.some((record) => matchesChange(record, file.identity))) return true;
  return !file.metadata && file.reviewable.length > 0 && file.reviewable.every((block) => records.some((record) => matchesChange(record, block)));
}
