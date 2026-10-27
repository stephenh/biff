import type { Storage } from "./storage";
import type { GitHub } from "./github";
import type { Workspaces } from "./workspaces";
import type { LocalReview } from "../shared/types";
import { localReview, closeReview } from "./reviewStore";
import { beginHunkReconciliation, reconcileFollowUps } from "./logicalHunks";
import { acceptSnapshot } from "./reviewSnapshots";

/** Attach the shared durable review lifetime and PR comparison to a local or agent snapshot. */
export async function prepareLocalReview(storage: Storage, snapshot: LocalReview, github: GitHub, workspaces?: Workspaces): Promise<LocalReview> {
  if (snapshot.changes !== "all") return snapshot;
  let identity = await localReview(storage, snapshot);
  const reconciliation = beginHunkReconciliation(storage, identity.id, "local");
  if (identity.pr) {
    const [owner, repo, number] = identity.pr.split("/");
    const pr = await github.pullRequest(`${owner}/${repo}`, number);
    if (pr.state === "closed") {
      await closeReview(storage, identity.pr);
      identity = await localReview(storage, snapshot);
    } else if (workspaces && snapshot.tip) {
      // The target tip may not exist locally; use the GitHub fork rather than a stale local bookmark.
      const base = await github.mergeBase(`${owner}/${repo}`, pr.base.sha, pr.head.sha);
      snapshot = await workspaces.bookmarkReview(snapshot.workspace.id, snapshot.bookmark, snapshot.changes, base, snapshot.followWorkingCopy);
      snapshot.baseLabel = pr.base.ref;
      snapshot.baseOverride = undefined;
    }
  }
  if (snapshot.tip && !snapshot.baseOverride) await reconcileFollowUps(storage, identity.id, snapshot.patch, snapshot.selected.commit_id, "local", reconciliation);
  return acceptSnapshot(storage.db, { ...snapshot, identity, progressScope: identity.id });
}
