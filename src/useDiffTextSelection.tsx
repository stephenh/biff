import { useEffect, useRef, useState } from "react";
import type { FileDiffMetadata, FileDiffOptions } from "@pierre/diffs";
import { ActivityStatus } from "./ActivityStatus";
import { installDiffTextSelection } from "./diffTextSelection";
import { useStableCallback } from "./useStableCallback";

/**
 * Share selection lifecycle and truthful clipboard feedback across reading panes.
 *
 * Keep one controller per shadow root and update its metadata after hydration.
 */
export function useDiffTextSelection() {
  const mounted = useRef<{ root: ShadowRoot; file: FileDiffMetadata; cleanup: () => void } | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const request = useRef(0);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const retry = useRef("");
  const fail = useStableCallback((message: string) => {
    request.current++;
    clearTimeout(timer.current);
    retry.current = "";
    setCopied(false);
    setError(message);
  });
  const copy = useStableCallback(async (text: string) => {
    const current = ++request.current;
    retry.current = text;
    clearTimeout(timer.current);
    setCopied(false);
    setError("");
    try {
      await navigator.clipboard.writeText(text);
      if (current !== request.current) return;
      setCopied(true);
      timer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      if (current === request.current) setError("Could not copy selected code. Retry or press Ctrl/Cmd+C.");
    }
  });
  const onRender = useStableCallback<Parameters<NonNullable<FileDiffOptions<undefined, undefined>["onPostRender"]>>, void>((node, instance, phase) => {
    if (phase === "unmount") { mounted.current?.cleanup(); mounted.current = undefined; return; }
    const root = node.shadowRoot;
    const file = instance.fileDiff;
    if (!root || !file) return;
    if (mounted.current?.root === root && mounted.current.file.name === file.name && mounted.current.file.prevName === file.prevName) { mounted.current.file = file; return; }
    mounted.current?.cleanup();
    const current = { root, file, cleanup: () => {} };
    current.cleanup = installDiffTextSelection(root, () => current.file, copy, fail);
    mounted.current = current;
  });

  useEffect(() => () => { mounted.current?.cleanup(); clearTimeout(timer.current); request.current++; }, []);
  return { onRender, status: <>
    {copied && <div className="clipboard-notice" role="status">Copied</div>}
    <ActivityStatus label="Copy selected code" error={error || undefined} retry={retry.current ? () => void copy(retry.current) : undefined} />
  </> };
}
