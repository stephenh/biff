/** Ignore indentation only; preserve internal/trailing whitespace, line boundaries, and EOF evidence. */
export function normalizeIndentation(text: string): string {
  return text.replace(/^[\t ]+/gm, "");
}

/** Share the exact fingerprint input between live comparisons and stored-text migrations. */
export function changeHashInput(deleted: string[], added: string[]): string {
  return JSON.stringify([deleted.map(normalizeIndentation), added.map(normalizeIndentation)]);
}
