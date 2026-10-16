import { diffArrays } from "diff";

interface PatchLine { text: string; comparison: string; noNewline: boolean }

/**
 * Hide whitespace-only edits without changing old/new file coordinates.
 *
 * Re-diff each replacement block with Git's ignore-all-space semantics. Equal
 * pairs become context, consuming one line on each side, so hunk headers and
 * GitHub comment line numbers remain valid. Keep metadata-only changes intact.
 */
export function hideWhitespace(patch: string): string {
  return patch.split(/(?=^diff --git )/m).map(filterFile).join("");
}

/** Preserve file headers verbatim, including renames, modes, and blob IDs. */
function filterFile(file: string): string {
  const sections = file.split(/(?=^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@)/m);
  if (sections.length === 1) return file;
  const header = sections.shift()!;
  const hunks = sections.map(filterHunk).filter(Boolean);
  if (!hunks.length && !/^(?:old mode |new mode |rename |copy |new file mode |deleted file mode )/m.test(header)) return "";
  return header + hunks.join("");
}

/** Replace whitespace-equivalent deleted/added pairs with new-side context. */
function filterHunk(hunk: string): string {
  const lines = hunk.split("\n");
  const result = [lines[0]];
  let changed = false;
  for (let index = 1; index < lines.length;) {
    if (!/^[+-]/.test(lines[index])) {
      result.push(lines[index++]);
      continue;
    }
    const oldLines: PatchLine[] = [];
    const newLines: PatchLine[] = [];
    while (index < lines.length && /^[+-]/.test(lines[index])) {
      const line = lines[index++];
      const noNewline = lines[index] === "\\ No newline at end of file";
      if (noNewline) index++;
      const text = line.slice(1);
      (line[0] === "-" ? oldLines : newLines).push({ text, comparison: text.replace(/[\t\v\f\r ]/g, ""), noNewline });
    }
    const edits = diffArrays(oldLines, newLines, { comparator: equivalent });
    for (const edit of edits) {
      const prefix = edit.added ? "+" : edit.removed ? "-" : " ";
      if (edit.added || edit.removed) changed = true;
      for (const line of edit.value) {
        result.push(prefix + line.text);
        if (line.noNewline) result.push("\\ No newline at end of file");
      }
    }
  }
  return changed ? result.join("\n") : "";
}

/** Ignore spacing within lines, but retain added/removed lines and EOF changes. */
function equivalent(a: PatchLine, b: PatchLine): boolean {
  return a.noNewline === b.noNewline && a.comparison === b.comparison;
}
