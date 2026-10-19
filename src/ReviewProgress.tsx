import { createContext } from "react";

/** Both review headers host the viewer's progress without duplicating its saved state. */
export const ReviewProgressTarget = createContext<HTMLElement | null>(null);

/** Show completion across all reviewable hunks in the displayed diff. */
export function ReviewProgress(props: { reviewed: number; total: number; ready: boolean }) {
  const label = props.ready ? `${props.reviewed} of ${props.total} hunks reviewed` : "Loading review progress";
  const fraction = props.ready ? (props.total ? props.reviewed / props.total : 1) : 0;
  return <div className="review-progress" role="progressbar" aria-label="Overall review progress" aria-valuemin={0} aria-valuemax={Math.max(1, props.total)} aria-valuenow={props.ready ? props.reviewed : undefined} aria-valuetext={label} title={label}>
    <div className="review-progress-label" aria-hidden="true"><span>Hunks reviewed</span><span>{props.ready ? `${props.reviewed} / ${props.total}` : "…"}</span></div>
    <div className="review-progress-track" aria-hidden="true"><div className="review-progress-fill" style={{ transform: `scaleX(${fraction})` }} /></div>
  </div>;
}
