export const workspaceRoute = /^(?<base>\/workspaces\/(?<id>[^/]+))(?:\/f\/(?<file>[^/]+))?\/?$/;
export const pullRequestRoute = /^(?<base>\/pr\/(?<owner>[^/]+)\/(?<repo>[^/]+)\/(?<number>[^/]+))(?:\/f\/(?<file>[^/]+))?\/?$/;

/** Read a review URL without treating the file suffix as part of the review's identity. */
export function reviewFileRoute(pathname: string): { base: string; file?: string } | undefined {
  const groups = (workspaceRoute.exec(pathname) ?? pullRequestRoute.exec(pathname))?.groups;
  if (!groups) return undefined;
  try {
    return { base: groups.base, file: groups.file ? decodeURIComponent(groups.file) : undefined };
  } catch {
    return { base: groups.base, file: "" };
  }
}

/**
 * Assign short file names independently of the diff's display order.
 *
 * Duplicate basenames use full-path order. Reserve real basenames first so a
 * generated foo.ts-1 cannot shadow a file actually named foo.ts-1.
 */
export function fileRouteNames(files: readonly { name: string }[]): string[] {
  const groups = new Map<string, string[]>();
  for (const file of files) {
    const basename = file.name.slice(file.name.lastIndexOf("/") + 1);
    const paths = groups.get(basename) ?? [];
    paths.push(file.name);
    groups.set(basename, paths);
  }

  const reserved = new Set(groups.keys());
  const names = new Map<string, string>();
  for (const [basename, paths] of groups) {
    if (paths.length === 1) {
      names.set(paths[0], basename);
      continue;
    }
    let suffix = 1;
    for (const path of paths.sort()) {
      while (reserved.has(`${basename}-${suffix}`)) suffix++;
      const name = `${basename}-${suffix++}`;
      reserved.add(name);
      names.set(path, name);
    }
  }
  return files.map((file) => names.get(file.name)!);
}
