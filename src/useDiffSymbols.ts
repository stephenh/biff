import { createContext, useContext, useEffect, useRef } from "react";
import type { FileDiffMetadata, FileDiffOptions } from "@pierre/diffs";
import type { ReviewSymbol } from "../shared/symbols";
import { installDiffSymbols, type SymbolLookup } from "./diffSymbols";
import { useStableCallback } from "./useStableCallback";

export const SymbolNavigationContext = createContext<{
  lookup: SymbolLookup; navigate(candidates: ReviewSymbol[], origin: ReviewSymbol): void;
} | undefined>(undefined);

/**
 * Share symbol interactions across current and frozen panes.
 *
 * Track the last rendered root even before the index arrives; receiving symbols must
 * not require rebuilding Pierre's diff or waiting for another scroll/render event.
 */
export function useDiffSymbols() {
  const context = useContext(SymbolNavigationContext);
  const mounted = useRef<{ root: ShadowRoot; file: FileDiffMetadata; controller?: ReturnType<typeof installDiffSymbols> } | undefined>(undefined);
  const navigate = useStableCallback((candidates: ReviewSymbol[], origin: ReviewSymbol) => context?.navigate(candidates, origin));
  const sync = useStableCallback((root: ShadowRoot, file: FileDiffMetadata) => {
    let current = mounted.current;
    if (current?.root !== root || current.file.name !== file.name || current.file.prevName !== file.prevName) {
      current?.controller?.cleanup();
      current = { root, file };
      mounted.current = current;
    }
    current.file = file;
    if (!context?.lookup.size) {
      current.controller?.cleanup();
      current.controller = undefined;
    } else if (current.controller) current.controller.update(context.lookup);
    else {
      const target = current;
      current.controller = installDiffSymbols(root, () => target.file, context.lookup, navigate);
    }
  });
  const onRender = useStableCallback<Parameters<NonNullable<FileDiffOptions<undefined, undefined>["onPostRender"]>>, void>((node, instance, phase) => {
    if (phase === "unmount") { mounted.current?.controller?.cleanup(); mounted.current = undefined; return; }
    if (node.shadowRoot && instance.fileDiff) sync(node.shadowRoot, instance.fileDiff);
  });
  useEffect(() => {
    if (mounted.current) sync(mounted.current.root, mounted.current.file);
  }, [context]);
  useEffect(() => () => mounted.current?.controller?.cleanup(), []);
  return onRender;
}
