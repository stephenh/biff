import { useEffect } from "react";
import { useLocation } from "wouter";
import { pullRequestRoute } from "./fileRoute";
import { isTyping, matchesShortcut, registerShortcuts } from "./shortcuts";
import { historyShortcuts } from "./shortcutDefinitions";

/** Share browser history and go-to sequences across dashboards and reviews without intercepting typing. */
export function useNavigationShortcuts() {
  const [location, navigate] = useLocation();

  useEffect(() => {
    let prefixAt: number | undefined;

    /** Cancel unfinished sequences when focus changes or the browser loses focus. */
    function reset() {
      prefixAt = undefined;
    }

    /** Handle history keys directly; go-to sequences need two separate presses within one second. */
    function onKeyDown(event: KeyboardEvent) {
      const editing = isTyping(event);
      const modal = document.querySelector('dialog[open], [role="dialog"]:not([popover]), [popover]:popover-open, [data-comment-overlay]');
      const panel = event.target instanceof Element && event.target.closest("[data-modal-scope]");
      // History works on dashboards too, including Forward after leaving a review.
      // Inputs, native controls, and focused reference panels keep their arrow keys.
      if (!event.defaultPrevented && !event.isComposing && !event.shiftKey && !modal && !panel && matchesShortcut(event, historyShortcuts)) {
        event.preventDefault();
        reset();
        if (!event.repeat) window.history.go(event.key === "ArrowRight" ? 1 : -1);
        return;
      }
      if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || editing ||
        modal) {
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
      ...historyShortcuts,
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
