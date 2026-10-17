import { useEffect, useState } from "react";
import type { ReviewIdentity } from "../shared/progress";
import type { LocalReview } from "../shared/types";
import { post, useResource } from "./api";

/**
 * Show the discovered PR association and let a reused bookmark start fresh.
 *
 * Opening either review discovers associations from recorded immutable commit IDs.
 */
export function ReviewLifetime(props: { snapshot: LocalReview; endpoint: string }) {
  const resource = useReviewIdentity(props.endpoint);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const identity = resource.data ?? props.snapshot.identity;

  /** A reused bookmark can start fresh even before its previous PR closes. */
  async function startNew() {
    setBusy(true); setError("");
    try {
      await post(`/api/workspaces/${props.snapshot.workspace.id}/review`, { bookmark: props.snapshot.bookmark || "", base: props.snapshot.baseOverride });
      window.location.reload();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }

  return <details>
    <summary>{identity?.pr ? `Linked to ${identity.pr}` : "Review lifetime"}</summary>
    {identity?.pr && <a href={`/pr/${identity.pr}`} target="_blank" rel="noreferrer">Open linked PR ↗</a>}
    <button disabled={busy} onClick={() => void startNew()}>Start new review</button>
    {(error || resource.error) && <span role="alert">{error || resource.error}</span>}
  </details>;
}

/** Show the discovered local association without inferring it from branch names. */
export function LinkedLocalReview(props: { endpoint: string }) {
  const resource = useReviewIdentity(props.endpoint);
  const identity = resource.data;
  if (!identity?.local || identity.closed) return null;
  return <a href={`/workspaces/${identity.local.workspace}?${new URLSearchParams({ bookmark: identity.local.bookmark })}`} target="_blank" rel="noreferrer">Linked local review ↗</a>;
}

/** Returning from the other view should reveal an association discovered in that tab. */
function useReviewIdentity(endpoint: string) {
  const resource = useResource<ReviewIdentity>(`${endpoint}/identity`);
  useEffect(() => {
    window.addEventListener("focus", resource.refresh);
    return () => window.removeEventListener("focus", resource.refresh);
  }, [endpoint]);
  return resource;
}
