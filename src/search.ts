import type { FileDiffLoadedFiles, FileDiffMetadata } from "@pierre/diffs";
import type { ReviewLine } from "../shared/types";

export interface SearchLine extends ReviewLine { text: string; hidden: boolean }

/** Search new/context lines once and retain removed symbols on the old side. */
export function searchLines(file: FileDiffMetadata, contents?: FileDiffLoadedFiles): SearchLine[] {
  const rows: SearchLine[] = [];
  const visible = new Set<number>();
  for (const hunk of file.hunks) {
    let oldLine = hunk.deletionStart;
    let newLine = hunk.additionStart;
    for (const content of hunk.hunkContent) {
      if (content.type === "context") {
        for (let offset = 0; offset < content.lines; offset++) {
          visible.add(newLine);
          rows.push({ path: file.name, side: "RIGHT", line: newLine++, text: file.additionLines[content.additionLineIndex + offset], hidden: false });
          oldLine++;
        }
      } else {
        for (let offset = 0; offset < content.deletions; offset++) rows.push({ path: file.name, side: "LEFT", line: oldLine++, text: file.deletionLines[content.deletionLineIndex + offset], hidden: false });
        for (let offset = 0; offset < content.additions; offset++) {
          visible.add(newLine);
          rows.push({ path: file.name, side: "RIGHT", line: newLine++, text: file.additionLines[content.additionLineIndex + offset], hidden: false });
        }
      }
    }
  }
  // Full new source includes omitted context without duplicating unchanged old lines.
  const source = contents?.newFile?.contents;
  if (source !== undefined) {
    const lines = source.split("\n");
    if (lines.at(-1) === "") lines.pop();
    lines.forEach((text, index) => {
      if (!visible.has(index + 1)) rows.push({ path: file.name, side: "RIGHT", line: index + 1, text, hidden: true });
    });
  }
  return rows.sort((a, b) => a.line - b.line || a.side.localeCompare(b.side));
}
