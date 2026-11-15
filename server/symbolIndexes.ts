import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import type { FileDiffLoadedFiles } from "@pierre/diffs";
import type { ReviewSymbol, SymbolFile, SymbolIndex } from "../shared/symbols";
import { runCommand, type RunCommand } from "./commands";
import { findReview, reviewIdentity } from "./reviewStore";
import type { Storage } from "./storage";

export interface SymbolSource {
  scope: string;
  /** An explicit comparison tuple, not a digest or a mutable branch name. */
  revision: string;
  files: SymbolFile[];
  load(file: SymbolFile): Promise<FileDiffLoadedFiles>;
}

interface IndexJob { source: SymbolSource; result: SymbolIndex; pending: boolean }
interface CachedIndex { symbols_json: string }
interface OutlineEntry {
  name: string; symbolType: string; range: { start: { line: number } }; members?: OutlineEntry[];
}
const astGrep = fileURLToPath(new URL(process.platform === "win32" ? "ast-grep.exe" : "ast-grep", import.meta.resolve("@ast-grep/cli/package.json")));

/**
 * Admit indexing separately from review reads and serialize the speculative work.
 *
 * Jobs yield between files; a large PR must not launch a subprocess or source request
 * per file at once. Completed file indexes survive restarts, while failures remain retryable.
 */
export class SymbolIndexes {
  private jobs = new Map<string, IndexJob>();
  private queue: IndexJob[] = [];
  private work?: Promise<void>;
  private version?: Promise<string>;

  constructor(private storage: Storage, private run: RunCommand = runCommand) {}

  /** Return immediately; neither source loading nor parsing belongs in this response's critical path. */
  read(source: SymbolSource, retry = false): SymbolIndex {
    const key = JSON.stringify([source.scope, source.revision, source.files]);
    let job = this.jobs.get(key);
    if (!job || (retry && job.result.state === "failed")) {
      job = { source, result: { symbols: [], completed: 0, total: source.files.length, state: "indexing", errors: [] }, pending: true };
      this.jobs.set(key, job);
      this.queue.push(job);
      void this.drain();
    }
    return job.result;
  }

  /**
   * Register background work with Storage so shutdown waits before closing SQLite.
   *
   * Retain a bounded number of completed jobs, but never evict admitted queued work.
   */
  drain(): Promise<void> {
    if (this.work) return this.work;
    this.work = this.storage.serialize("symbol-indexes", async () => {
      // Defer even the executable/version probe until after the admission response.
      await Bun.sleep(0);
      while (this.queue.length) {
        const job = this.queue.shift()!;
        try { await this.index(job); }
        catch (error) { job.result.errors.push(errorMessage(error)); }
        job.result.state = job.result.errors.length ? "failed" : "complete";
        job.pending = false;
        for (const [key, entry] of this.jobs) {
          if (this.jobs.size <= 16) break;
          if (!entry.pending) this.jobs.delete(key);
        }
      }
    }).finally(() => {
      this.work = undefined;
      if (this.queue.length) void this.drain();
    });
    return this.work;
  }

  /**
   * Reuse completed file indexes and persist new declarations one file at a time.
   *
   * Resolve the review again after awaits: local/PR linking can replace its original owner.
   */
  private async index(job: IndexJob): Promise<void> {
    const source = job.source;
    const version = await (this.version ??= this.executableVersion().catch((error) => { this.version = undefined; throw error; }));
    await reviewIdentity(this.storage, source.scope);
    for (const file of source.files) {
      try {
        let review = findReview(this.storage.db, source.scope)!;
        const cached = this.storage.db.query<CachedIndex, [string, string, string, string, string]>(`SELECT symbols_json FROM symbol_indexes
          WHERE review_id=? AND revision=? AND path=? AND old_path=? AND indexer_version=?`)
          .get(review.id, source.revision, file.path, file.oldPath, version);
        let symbols: ReviewSymbol[];
        if (cached) symbols = JSON.parse(cached.symbols_json);
        else {
          const contents = await source.load(file);
          symbols = await outlineSymbols(file, contents, this.run);
          review = findReview(this.storage.db, source.scope)!;
          this.storage.db.query(`INSERT INTO symbol_indexes (review_id,revision,path,old_path,indexer_version,symbols_json)
            VALUES (?,?,?,?,?,?) ON CONFLICT(review_id,revision,path,old_path,indexer_version)
            DO UPDATE SET symbols_json=excluded.symbols_json`)
            .run(review.id, source.revision, file.path, file.oldPath, version, JSON.stringify(symbols));
        }
        for (const symbol of symbols) job.result.symbols.push(symbol);
      } catch (error) { job.result.errors.push(`${file.path}: ${errorMessage(error)}`); }
      job.result.completed++;
      // Let interactive requests run between cache reads, parsing and writes too.
      await Bun.sleep(10);
    }
  }

  /** Include both the pinned binary and our mapping rules in cache identity. */
  private async executableVersion(): Promise<string> {
    try {
      const version = await this.run([astGrep, "--version"]);
      if (!version.startsWith("ast-grep ")) throw new Error("Unexpected ast-grep version output");
      return `biff-symbols-1:${version.trim()}`;
    } catch (error) {
      throw new Error(`Could not start the bundled ast-grep. Run bun install with optional dependencies and its trusted postinstall, then Retry. ${errorMessage(error)}`);
    }
  }
}

/**
 * Parse both complete source sides in an isolated directory, preserving filename-based language detection.
 *
 * Never point ast-grep at the working copy or load repository configuration.
 * Source limits keep one generated file from dominating speculative CPU and memory.
 */
export async function outlineSymbols(file: SymbolFile, contents: FileDiffLoadedFiles, run: RunCommand = runCommand): Promise<ReviewSymbol[]> {
  const sources = [
    { side: "LEFT" as const, name: file.oldPath, contents: contents.oldFile?.contents ?? "", folder: "old" },
    { side: "RIGHT" as const, name: file.path, contents: contents.newFile?.contents ?? "", folder: "new" },
  ];
  if (sources.some((source) => Buffer.byteLength(source.contents) > 2_000_000)) throw new Error("File exceeds the 2 MB symbol-indexing limit");
  if (sources.some((source) => source.contents.includes("\0"))) return [];
  const directory = await mkdtemp(join(tmpdir(), "biff-symbols-"));
  try {
    // Explicit configuration prevents discovery of a parent sgconfig.yml or custom native grammars.
    const config = join(directory, "sgconfig.yml");
    await writeFile(config, "ruleDirs: []\n");
    for (const source of sources) {
      await mkdir(join(directory, source.folder));
      await writeFile(join(directory, source.folder, basename(source.name)), source.contents);
    }
    const output = await run([astGrep, "outline", "--config", config, "--custom-languages", "ignore", "--threads", "1",
      "--items", "structure", "--view", "expanded", "--json=compact",
      ...sources.map((source) => join(directory, source.folder, basename(source.name)))], { cwd: directory });
    const symbols: ReviewSymbol[] = [];
    const outlines = JSON.parse(output) as { path: string; items: OutlineEntry[] }[];
    if (!Array.isArray(outlines)) throw new Error("Invalid ast-grep outline output");
    for (const outline of outlines) {
      const source = sources.find((entry) => outline.path === join(directory, entry.folder, basename(entry.name)));
      if (!source) throw new Error("ast-grep returned an unexpected source path");
      for (const item of outline.items) appendSymbol(symbols, item, file.path, source.side);
    }
    return symbols;
  } finally { await rm(directory, { recursive: true, force: true }); }
}

/** Flatten the outline while retaining each member's class/module context and one-based source line. */
function appendSymbol(symbols: ReviewSymbol[], item: OutlineEntry, path: string, side: ReviewSymbol["side"], scope?: string): void {
  if (typeof item.name !== "string" || !Number.isSafeInteger(item.range?.start?.line) || item.range.start.line < 0) throw new Error("Invalid ast-grep declaration");
  symbols.push({ name: item.name, kind: item.symbolType, path, side, line: item.range.start.line + 1, ...(scope ? { scope } : {}) });
  for (const member of item.members ?? []) appendSymbol(symbols, member, path, side, scope ? `${scope}.${item.name}` : item.name);
}

/** Preserve actionable dependency/source failures without turning an empty index into apparent success. */
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
