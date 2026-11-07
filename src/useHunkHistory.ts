import { useEffect, useMemo } from "react";
import { changeKey, matchesChange, type ChangeIdentity } from "../shared/progress";
import type { SeenHunks } from "../shared/hunkHistory";
import { post, useResource } from "./api";
import { useOptimisticSave } from "./useOptimisticSave";

/**
 * Retain encountered identities without coupling cursor movement to saves or review completion.
 *
 * The shared queue keeps encounter saves and retries alive after the viewer unmounts.
 */
export function useHunkHistory(endpoint: string | undefined, head: string | undefined, base: string, complete: boolean) {
  const query = new URLSearchParams({ head: head ?? "", base }).toString();
  const resource = useResource<SeenHunks>(endpoint && head && complete ? `${endpoint}/history?${query}` : null);
  const scope = `seen:${endpoint}`;
  const saved = useMemo(() => new Map((resource.data?.hunks ?? []).map((unit) => [changeKey(unit), true])), [resource.data]);
  const queue = useOptimisticSave(scope, saved);

  useEffect(() => {
    if (!endpoint) return;
    /** Publication retains the submitted inventory without moving the reading cursor. */
    function refreshHistory(event: Event) {
      if ((event as CustomEvent<string>).detail === endpoint) resource.refresh();
    }
    window.addEventListener("biff-review-submitted", refreshHistory);
    const timer = window.setInterval(resource.refreshQuiet, 5000);
    return () => { window.clearInterval(timer); window.removeEventListener("biff-review-submitted", refreshHistory); };
  }, [endpoint, resource.refresh, resource.refreshQuiet]);

  /** Failed encounters keep their retry receipt instead of retrying on every renderer callback. */
  function see(identity: ChangeIdentity) {
    if (!endpoint || !head) return;
    const key = changeKey(identity);
    const confirmed = (resource.data?.hunks ?? []).some((unit) => matchesChange(unit, identity));
    if (queue.intent(key, confirmed)) return;
    queue.save(key, true, confirmed, async () => {
      // The queue retains this acknowledgement until polling catches up. A focus save
      // must not replace an in-flight summary containing other historical hunks.
      await post(`${endpoint}/seen`, { identity, head, base });
    }, `Keep history · ${identity.path}:${identity.newLine || identity.oldLine}`);
  }

  return { ...resource, scope, see, query };
}
