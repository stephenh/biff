import type { StackPosition } from "../shared/types";

interface Branch { ref: string; repo: { full_name: string } | null }
export interface StackPullRequest { number: number; title: string; base: Branch; head: Branch }

/**
 * Find the selected PR's linear stack; fork repositories must match too.
 *
 * Keep its shared ancestors, but stop at the next split instead of choosing a branch.
 * Each child after that split has its own stack and never includes its siblings.
 */
export function stackPosition(pulls: StackPullRequest[], number: number): StackPosition | null {
  const selected = pulls.find((pr) => pr.number === number);
  if (!selected) return null;
  const ancestors: StackPullRequest[] = [];
  const seen = new Set([number]);
  let current = selected;

  // I.e. C targets B's branch and B targets A's branch: C is position 3 in A → B → C.
  while (true) {
    const parents = pulls.filter((pr) => sameBranch(pr.head, current.base));
    if (!parents.length) break;
    if (parents.length !== 1 || seen.has(parents[0].number)) return null;
    current = parents[0];
    ancestors.push(current);
    seen.add(current.number);
  }

  const ordered = [...ancestors.reverse(), selected];
  const position = ordered.length;
  current = selected;

  // I.e. A → B with B → C and B → D: A/B see A → B; C sees A → B → C.
  while (true) {
    const children = pulls.filter((pr) => sameBranch(pr.base, current.head));
    if (children.length !== 1) break;
    if (seen.has(children[0].number)) return null;
    current = children[0];
    seen.add(current.number);
    ordered.push(current);
  }

  return ordered.length > 1 ? { position, total: ordered.length, pulls: ordered.map((pr) => ({ number: pr.number, title: pr.title })) } : null;
}

/** Deleted fork repositories cannot establish a reliable branch relationship. */
function sameBranch(left: Branch, right: Branch): boolean {
  return Boolean(left.repo && right.repo && left.repo.full_name.toLowerCase() === right.repo.full_name.toLowerCase() && left.ref === right.ref);
}
