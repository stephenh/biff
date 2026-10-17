import type { StackPosition } from "../shared/types";

interface Branch { ref: string; repo: { full_name: string } | null }
export interface StackPullRequest { number: number; title: string; base: Branch; head: Branch }

/** Number a linear open-PR chain from its base; fork branches must match repository too. */
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

  const position = ancestors.length + 1;
  current = ancestors.at(-1) ?? selected;
  const chain = new Set([current.number]);
  const ordered = [current];
  while (true) {
    const children = pulls.filter((pr) => sameBranch(pr.base, current.head));
    if (!children.length) break;
    // A branching dependency graph has no single truthful “1 / n” ordering.
    if (children.length !== 1 || chain.has(children[0].number)) return null;
    current = children[0];
    chain.add(current.number);
    ordered.push(current);
  }
  return chain.size > 1 ? { position, total: chain.size, pulls: ordered.map((pr) => ({ number: pr.number, title: pr.title })) } : null;
}

/** Deleted fork repositories cannot establish a reliable branch relationship. */
function sameBranch(left: Branch, right: Branch): boolean {
  return Boolean(left.repo && right.repo && left.repo.full_name.toLowerCase() === right.repo.full_name.toLowerCase() && left.ref === right.ref);
}
