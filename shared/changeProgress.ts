import type { FileDiffMetadata } from "@pierre/diffs";
import type { ChangeIdentity } from "./progress";
import type { ImportGroup } from "./importGroups";
import { firstChangeLine } from "./changeFocus";

export interface ChangeBlock extends ChangeIdentity { fileIndex: number; hunkIndex: number; start: number; end: number; selected: number }

/** Mixed edits still count: every changed row must belong to an import region to exclude the block. */
export function isImportOnly(block: ChangeBlock, groups: ImportGroup[]): boolean {
  for (let row = block.start; row <= block.end; row++) {
    if (!groups.some((group) => row >= group.start && row <= group.end)) return false;
  }
  return true;
}

/** Hash exact changed text, excluding context and coordinates; duplicates retain both coordinates. */
export async function identifyChanges(files: FileDiffMetadata[]): Promise<ChangeBlock[]> {
  const pending: Promise<ChangeBlock>[] = [];
  files.forEach((file, fileIndex) => {
    let hunkIndex = 0;
    for (const hunk of file.hunks) {
      let oldLine = hunk.deletionStart;
      let newLine = hunk.additionStart;
      let start = hunk.unifiedLineStart;
      for (const content of hunk.hunkContent) {
        if (content.type === "context") { oldLine += content.lines; newLine += content.lines; start += content.lines; continue; }
        const deleted = file.deletionLines.slice(content.deletionLineIndex, content.deletionLineIndex + content.deletions);
        const added = file.additionLines.slice(content.additionLineIndex, content.additionLineIndex + content.additions);
        const block = { path: file.name, oldLine, newLine, fileIndex, hunkIndex: hunkIndex++, start, end: start + content.deletions + content.additions - 1, selected: firstChangeLine(file, content, start)!, duplicate: false };
        pending.push(crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([deleted, added]))).then((hash) => ({ ...block, hash: Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("") })));
        oldLine += content.deletions; newLine += content.additions; start += content.deletions + content.additions;
      }
    }
  });
  const blocks = await Promise.all(pending);
  const counts = new Map<string, number>();
  for (const block of blocks) counts.set(`${block.path}:${block.hash}`, (counts.get(`${block.path}:${block.hash}`) ?? 0) + 1);
  return blocks.map((block) => ({ ...block, duplicate: counts.get(`${block.path}:${block.hash}`)! > 1 }));
}

/** Fingerprint a file's edits and metadata without tying text approvals to unrelated line shifts. */
export async function identifyFiles(files: FileDiffMetadata[], blocks: ChangeBlock[], head?: string): Promise<ChangeIdentity[]> {
  return Promise.all(files.map(async (file, fileIndex) => {
    const edits = blocks.filter((block) => block.fileIndex === fileIndex).map((block) => [block.hash, ...(block.duplicate ? [block.oldLine, block.newLine] : [])]);
    // Binary/metadata-only patches need blob identity; missing IDs must not approve a later snapshot.
    const blobs = edits.length ? undefined : [file.prevObjectId, file.newObjectId, !file.prevObjectId && !file.newObjectId ? head : undefined];
    const mode = file.prevMode || file.type === "new" || file.type === "deleted" ? file.mode ?? "100644" : undefined;
    const value = [file.prevName, file.type, file.prevMode, mode, edits, blobs];
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
    return { path: file.name, kind: "file" as const, hash: Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join(""), oldLine: 0, newLine: 0, duplicate: false };
  }));
}

/** Non-text changes require their own approval, independent of the file's text hunks. */
export async function identifyMetadata(files: FileDiffMetadata[], head?: string): Promise<ChangeIdentity[]> {
  const selected = files.filter((file) => {
    return Boolean(file.prevName || file.prevMode || !file.hunks.length || ((file.type === "new" || file.type === "deleted") && file.mode && file.mode !== "100644"));
  });
  return Promise.all(selected.map(async (file) => {
    // Text changes must not invalidate approval of an unchanged rename or executable bit.
    const blobs = file.hunks.length ? undefined : [file.prevObjectId, file.newObjectId, !file.prevObjectId && !file.newObjectId ? head : undefined];
    const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([file.prevName, file.type, file.prevMode, file.mode, blobs])));
    return { path: file.name, kind: "metadata" as const, hash: Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join(""), oldLine: 0, newLine: 0, duplicate: false };
  }));
}
