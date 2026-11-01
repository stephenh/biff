/** Draw the same review-completion ring in file and PR lists. */
export function ProgressRing(props: { label: string; fraction: number }) {
  return <svg className="file-progress" width="16" height="16" viewBox="0 0 20 20" role="img" aria-label={props.label}>
    <title>{props.label}</title>
    <circle className="progress-track" cx="10" cy="10" r="7" />
    <circle className="progress-fill" cx="10" cy="10" r="7" pathLength="100" strokeDasharray="100" strokeDashoffset={100 - props.fraction * 100} transform="rotate(-90 10 10)" />
  </svg>;
}
