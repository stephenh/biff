import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { matchesChange, type ChangeIdentity, type ReviewedChange } from "../shared/progress";

/** Durable PR progress with serialized per-change mutations and atomic replacement. */
export class Progress {
  private writes: Promise<unknown> = Promise.resolve();
  constructor(private directory: string) {}

  /** Read after prior writes, including writes from other tabs. */
  async get(scope: string): Promise<ReviewedChange[]> {
    await this.writes;
    return this.read(scope);
  }

  /** Merge one edit rather than overwriting a tab's potentially stale snapshot. */
  update(scope: string, identity: ChangeIdentity, reviewed: boolean, head: string): Promise<ReviewedChange[]> {
    const pending = this.writes.then(async () => {
      const records = (await this.read(scope)).filter((entry) => !matchesChange(entry, identity));
      if (reviewed) records.push({ ...identity, head, reviewedAt: new Date().toISOString() });
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const path = this.path(scope);
      await writeFile(`${path}.tmp`, JSON.stringify(records), { mode: 0o600 });
      await rename(`${path}.tmp`, path);
      return records;
    });
    this.writes = pending.catch(() => {});
    return pending;
  }

  /** Hash the PR scope so repository names cannot become filesystem paths. */
  private path(scope: string) { return join(this.directory, `${createHash("sha256").update(scope).digest("hex")}.json`); }

  /** Missing progress is normal; corrupt or unreadable progress must remain an error. */
  private async read(scope: string): Promise<ReviewedChange[]> {
    try { return JSON.parse(await readFile(this.path(scope), "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  }
}
