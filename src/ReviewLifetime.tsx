import { useEffect, useRef, type ReactNode } from "react";
import type { ReviewIdentity } from "../shared/progress";
import type { LocalReview } from "../shared/types";
import { post, useResource } from "./api";
import { ActivityScope } from "./ActivityStatus";
import { useSaveFeedback } from "./useSaveFeedback";

/**
 * Show the discovered GitHub PR beside the review lifetime options.
 *
 * Opening either review discovers associations from recorded immutable commit IDs.
 */
export function ReviewLifetime(props: { snapshot: LocalReview; endpoint: string }) {
  const resource = useReviewIdentity(props.endpoint);
  const scope = `new-review:${props.endpoint}`;
  const { busy, setBusy, setError } = useSaveFeedback(scope, "Start new review", () => void startNew());
  const identity = resource.data ?? props.snapshot.identity;
  const [owner, repo, number] = identity?.pr?.split("/") ?? [];

  /** A reused bookmark can start fresh even before its previous PR closes. */
  async function startNew() {
    setBusy(true); setError("");
    try {
      await post(`/api/workspaces/${props.snapshot.workspace.id}/review`, { bookmark: props.snapshot.bookmark || "" });
      setBusy(false);
      window.location.reload();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }

  return <>
    {identity?.pr && <a className="pr-github-link" href={`https://github.com/${owner}/${repo}/pull/${number}`} target="_blank" rel="noreferrer">GitHub ↗</a>}
    <ReviewOptions>
      {identity?.pr && <a href={`/pr/${identity.pr}`} target="_blank" rel="noreferrer">Open linked PR ↗</a>}
      <button disabled={busy} onClick={() => void startNew()}>Start new review</button>
      <ActivityScope scope={scope} />
    </ReviewOptions>
  </>;
}

/** Show the discovered local association without inferring it from branch names. */
export function LinkedLocalReview(props: { endpoint: string }) {
  const resource = useReviewIdentity(props.endpoint);
  const identity = resource.data;
  if (!identity?.local || identity.closed) return null;
  // The server derives the comparison base from the durable PR association.
  return <ReviewOptions><a href={`/workspaces/${identity.local.workspace}?${new URLSearchParams({ bookmark: identity.local.bookmark, changes: "all" })}`} target="_blank" rel="noreferrer">Open linked bookmark ↗</a></ReviewOptions>;
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
