import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ReviewIdentity } from "../shared/progress";
import type { LocalReview } from "../shared/types";
import { post, useResource } from "./api";

/**
 * Keep the discovered PR association and lifetime actions in the review options menu.
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

  return <ReviewOptions>
    {identity?.pr && <a href={`/pr/${identity.pr}`} target="_blank" rel="noreferrer">Open linked PR ↗</a>}
    <button disabled={busy} onClick={() => void startNew()}>Start new review</button>
    {(error || resource.error) && <span role="alert">{error || resource.error}</span>}
  </ReviewOptions>;
}

/** Show the discovered local association without inferring it from branch names. */
export function LinkedLocalReview(props: { endpoint: string; base: string }) {
  const resource = useReviewIdentity(props.endpoint);
  const identity = resource.data;
  if (!identity?.local || identity.closed) return null;
  // The nearest local bookmark can be the PR's own branch, yielding an empty diff.
  // Entering from a PR must preserve its comparison base instead of using local auto-detection.
  return <ReviewOptions><a href={`/workspaces/${identity.local.workspace}?${new URLSearchParams({ bookmark: identity.local.bookmark, changes: "all", base: props.base })}`} target="_blank" rel="noreferrer">Open linked bookmark ↗</a></ReviewOptions>;
}

/** Keep secondary review actions out of the toolbar until requested. */
function ReviewOptions(props: { children: ReactNode }) {
  const menu = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    /** Dismiss the popup when the reader returns to the diff. */
    function outside(event: PointerEvent) {
      if (event.target instanceof Node && !menu.current?.contains(event.target)) menu.current?.removeAttribute("open");
    }
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, []);

  return <details ref={menu} className="review-options" onKeyDown={(event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      menu.current?.removeAttribute("open");
      menu.current?.querySelector("summary")?.focus();
    }
  }}>
    <summary aria-label="Review options" title="Review options">⋯</summary>
    <div className="review-options-menu">{props.children}</div>
  </details>;
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
