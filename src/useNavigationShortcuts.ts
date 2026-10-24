import { useEffect } from "react";
import { useLocation } from "wouter";
import { pullRequestRoute } from "./fileRoute";
import { registerShortcuts } from "./shortcuts";

/** Keep go-to sequences available on dashboards and reviews without intercepting typing. */
export function useNavigationShortcuts() {
  const [location, navigate] = useLocation();

  useEffect(() => {
    let prefixAt: number | undefined;

    /** Cancel unfinished sequences when focus changes or the browser loses focus. */
    function reset() {
      prefixAt = undefined;
    }

    /** Require two separate, unmodified key presses within one second. */
    function onKeyDown(event: KeyboardEvent) {
      const editing = event.composedPath().some((target) => target instanceof HTMLElement && target.closest("input, textarea, select, [contenteditable]"));
      if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || editing ||
        document.querySelector('dialog[open], [role="dialog"]:not([popover]), [popover]:popover-open, [data-comment-overlay]')) {
        reset();
        return;
      }
      if (event.repeat) return;

      const pending = prefixAt !== undefined && performance.now() - prefixAt < 1000;
      reset();
      if (pending) {
        if (["w", "m", "n", "r"].includes(event.key)) {
          event.preventDefault();
          navigate(event.key === "w" ? "/workspaces" : event.key === "n" ? "/needs-review" : "/prs");
          return;
        }
        if (event.key === "g") {
          const pr = pullRequestRoute.exec(location)?.groups;
          if (pr) {
            event.preventDefault();
            window.open(`https://github.com/${pr.owner}/${pr.repo}/pull/${pr.number}`, "_blank", "noopener,noreferrer");
          } else {
            const card = document.activeElement?.closest<HTMLElement>("[data-pr-id]");
            if (card) {
              event.preventDefault();
              window.open(`https://github.com/${card.dataset.prId!.replace(/\/(\d+)$/, "/pull/$1")}`, "_blank", "noopener,noreferrer");
            }
          }
          return;
        }
      }
      if (event.key === "g") {
        event.preventDefault();
        prefixAt = performance.now();
      }
    }

    const unregister = registerShortcuts([
      { keys: "g w", description: "Go to Working Copies" },
      { keys: "g m", aliases: ["g r"], description: "Go to My PRs" },
      { keys: "g n", description: "Go to Needs Review" },
      ...(/^\/(?:pr\/|prs$|needs-review$)/.test(location) ? [{ keys: "g g", description: "Open current or focused PR on GitHub" }] : []),
    ], onKeyDown);
    window.addEventListener("blur", reset);
    window.addEventListener("focusin", reset);
    return () => {
      unregister();
      window.removeEventListener("blur", reset);
      window.removeEventListener("focusin", reset);
    };
  }, [location, navigate]);
}
