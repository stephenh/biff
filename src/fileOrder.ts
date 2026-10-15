export interface FileEntry<T> { file: T; child: boolean }

/**
 * Keep source files in patch order, placing their companions immediately afterward.
 *
 * Match the complete directory and basename so unrelated Foo files stay separate.
 * A companion without its source in the diff remains an ordinary top-level file.
 */
export function groupFiles<T extends { name: string }>(files: T[]): FileEntry<T>[] {
  const names = new Set(files.map((file) => file.name));
  const children = new Map<string, T[]>();
  const parents = new Map<T, string>();
  for (const file of files) {
    const stem = companionStem(file.name);
    if (!stem) continue;
    const parent = ["ts", "tsx", "js", "jsx"].map((extension) => `${stem}.${extension}`).find((name) => names.has(name) && !companionStem(name));
    if (!parent) continue;
    parents.set(file, parent);
    const siblings = children.get(parent) ?? [];
    siblings.push(file);
    children.set(parent, siblings);
  }

  const entries: FileEntry<T>[] = [];
  for (const file of files) {
    if (parents.has(file)) continue;
    entries.push({ file, child: false });
    const siblings = children.get(file.name) ?? [];
    siblings.sort((a, b) => companionRank(a.name) - companionRank(b.name) || a.name.localeCompare(b.name));
    entries.push(...siblings.map((child) => ({ file: child, child: true })));
  }
  return entries;
}

/** Strip only recognized companion suffixes, preserving the directory. */
function companionStem(name: string): string | undefined {
  const match = /^(.*)\.(?:(?:test|spec|stories)\.[cm]?[jt]sx?|graphql)$/.exec(name);
  return match?.[1];
}

/** Keep tests first, then stories, then the associated GraphQL document. */
function companionRank(name: string): number {
  return name.endsWith(".graphql") ? 2 : /\.stories\./.test(name) ? 1 : 0;
}
