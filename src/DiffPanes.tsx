import { useRef, useState, type ReactNode } from "react";

interface DiffPanesProps {
  children: ReactNode;
  reference?: ReactNode;
}

/**
 * Resize the comparison without coupling either pane's scroll or navigation state.
 *
 * Divider arrow keys must not reach the main review's file-navigation shortcuts.
 */
export function DiffPanes(props: DiffPanesProps) {
  const container = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(50);

  return <div ref={container} className={`diff-panes${props.reference ? " has-frozen-diff" : ""}`} style={props.reference ? { gridTemplateColumns: `minmax(0, ${width}fr) 7px minmax(0, ${100 - width}fr)` } : undefined}>
    {props.children}
    {props.reference && <>
      <div className="diff-pane-divider" role="separator" aria-label="Resize frozen diff" aria-orientation="vertical" aria-valuemin={25} aria-valuemax={75} aria-valuenow={Math.round(width)} tabIndex={0} onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
      }} onPointerMove={(event) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
        const bounds = container.current!.getBoundingClientRect();
        setWidth(clampWidth((event.clientX - bounds.left) / bounds.width * 100));
      }} onPointerUp={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      }} onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home") return;
        event.preventDefault();
        event.stopPropagation();
        setWidth(event.key === "Home" ? 50 : clampWidth(width + (event.key === "ArrowLeft" ? -5 : 5)));
      }} onDoubleClick={() => setWidth(50)} />
      {props.reference}
    </>}
  </div>;
}

/** Leave enough room to read both diffs even during a fast drag. */
function clampWidth(width: number): number { return Math.max(25, Math.min(75, width)); }
