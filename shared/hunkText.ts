import type { FileDiffMetadata } from "@pierre/diffs";
import type { ChangeBlock } from "./changeProgress";
import type { ChangeIdentity } from "./progress";

export interface HunkText { diffText: string; oldLine: number; newLine: number }

/** Extract stable change bodies once; positional headers belong to individual observations. */
export function captureHunkTexts(files: FileDiffMetadata[], blocks: ChangeBlock[], metadata: ChangeIdentity[] = []): Map<ChangeIdentity, HunkText> {
  const result = new Map<ChangeIdentity, HunkText>();
  const byRow = new Map(blocks.map((block) => [`${block.fileIndex}:${block.start}`, block]));
  for (const [index, file] of files.entries()) {
    for (const hunk of file.hunks) {
      let row = hunk.unifiedLineStart;
      for (const content of hunk.hunkContent) {
        if (content.type === "context") { row += content.lines; continue; }
        const block = byRow.get(`${index}:${row}`);
        if (block) result.set(block, {
          diffText: [...file.deletionLines.slice(content.deletionLineIndex, content.deletionLineIndex + content.deletions).map((line) => patchLine("-", line)),
            ...file.additionLines.slice(content.additionLineIndex, content.additionLineIndex + content.additions).map((line) => patchLine("+", line))].join(""),
          oldLine: content.deletions || hunk.deletionCount === 0 ? block.oldLine : Math.max(0, block.oldLine - 1),
          newLine: content.additions || hunk.additionCount === 0 ? block.newLine : Math.max(0, block.newLine - 1),
        });
        row += content.deletions + content.additions;
      }
    }
    for (const unit of metadata.filter((entry) => entry.path === file.name)) {
      const lines: string[] = [];
      if (file.prevName) lines.push(`rename from ${file.prevName}`, `rename to ${file.name}`);
      if (file.prevMode) lines.push(`old mode ${file.prevMode}`, `new mode ${file.mode}`);
      else if (file.type === "new") lines.push(`new file mode ${file.mode ?? "100644"}`);
      else if (file.type === "deleted") lines.push(`deleted file mode ${file.mode ?? "100644"}`);
      if (file.prevObjectId && file.newObjectId) lines.push(`index ${file.prevObjectId}..${file.newObjectId}`);
      result.set(unit, { diffText: lines.join("\n") + (lines.length ? "\n" : ""), oldLine: 0, newLine: 0 });
    }
  }
  return result;
}

/** Counts are derived from the stored body, never persisted separately. */
export function hunkLineCounts(text: string): { old: number; new: number } {
  const lines = text.split("\n");
  return { old: lines.filter((line) => line.startsWith("-")).length, new: lines.filter((line) => line.startsWith("+")).length };
}

/** Build the small standalone patch needed by the reference renderer. */
export function renderHunkText(path: string, text: HunkText, kind: string = ""): string {
  return renderHunkTexts(path, [{ ...text, kind }]);
}

/** Several logical hunks from one comparison share a single file header. */
export function renderHunkTexts(path: string, texts: (HunkText & { kind?: string })[]): string {
  const oldPath = JSON.stringify(`a/${path}`);
  const newPath = JSON.stringify(`b/${path}`);
  let patch = `diff --git ${oldPath} ${newPath}\n` + texts.filter((text) => text.kind === "metadata").map((text) => text.diffText).join("");
  const changes = texts.filter((text) => text.kind !== "metadata");
  if (changes.length) patch += `--- ${oldPath}\n+++ ${newPath}\n`;
  for (const text of changes) {
    const counts = hunkLineCounts(text.diffText);
    patch += `@@ -${text.oldLine},${counts.old} +${text.newLine},${counts.new} @@\n${text.diffText}`;
  }
  return patch;
}

/** Preserve absent final newlines in both the stored content and reconstructed patches. */
function patchLine(prefix: string, line: string): string {
  return prefix + line + (line.endsWith("\n") ? "" : "\n\\ No newline at end of file\n");
}
