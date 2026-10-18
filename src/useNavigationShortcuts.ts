import { useEffect } from "react";
import { useLocation } from "wouter";

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
        if (event.key === "w" || event.key === "r") {
          event.preventDefault();
          navigate(event.key === "w" ? "/workspaces" : "/prs");
          return;
        }
        if (event.key === "g") {
          const pr = /^\/pr\/([^/]+)\/([^/]+)\/(\d+)\/?$/.exec(location);
          if (pr) {
            event.preventDefault();
            window.open(`https://github.com/${pr[1]}/${pr[2]}/pull/${pr[3]}`, "_blank", "noopener,noreferrer");
          }
          return;
        }
      }
      if (event.key === "g") {
        event.preventDefault();
        prefixAt = performance.now();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("blur", reset);
    window.addEventListener("focusin", reset);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("blur", reset);
      window.removeEventListener("focusin", reset);
    };
  }, [location, navigate]);
}
