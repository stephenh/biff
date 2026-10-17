import type { FileDiffMetadata } from "@pierre/diffs";
import type { DiscussionComment, ReviewLine } from "../shared/types";
import { lineLocation } from "./navigation";

export interface LineThread {
  id: string;
  location: ReviewLine;
  comments: DiscussionComment[];
  draftIndex?: number;
}
export interface CommentSelection {
  line: ReviewLine;
  threadId?: string;
  anchor?: { top: number; bottom: number };
}

/**
 * Attach compact, out-of-flow comment controls to Pierre's rendered code rows.
 *
 * The renderer owns its shadow DOM. Reconcile controls after each render instead
 * of adding annotation rows, which would change line heights and scroll positions.
 */
export function syncLineComments(container: HTMLElement, file: FileDiffMetadata, threads: LineThread[], open?: (selection: CommentSelection) => void) {
  const root = container.shadowRoot;
  if (!root || !open) return;
  if (!root.querySelector("[data-biff-comment-style]")) {
    const style = document.createElement("style");
    style.dataset.biffCommentStyle = "";
    style.textContent = `
      [data-content] > [data-line] { position: relative; }
      [data-biff-comments] { position: absolute; right: 8px; top: 0; display: flex; gap: 4px; max-width: 45%; z-index: 2; font: 12px/22px Inter, system-ui, sans-serif; }
      [data-biff-comments] button { color: #b6c3d5; background: #202631f5; border: 1px solid #45516a; border-radius: 5px; padding: 0 7px; cursor: pointer; font: inherit; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      [data-biff-comments] button:hover { color: #c9f4ae; border-color: #789e60; }
      [data-biff-comments] button:focus-visible { outline: 2px solid #bce99e; }
      [data-biff-comments]:not([data-has-thread]) { opacity: 0; pointer-events: none; }
      [data-line]:hover [data-biff-comments], [data-biff-focused] [data-biff-comments], [data-biff-comments]:focus-within { opacity: 1; pointer-events: auto; }
    `;
    root.append(style);
  }

  for (const row of root.querySelectorAll<HTMLElement>("[data-content] > [data-line]")) {
    const index = Number(row.dataset.lineIndex!.split(",")[0]);
    const location = lineLocation(file, index);
    if (!location) continue;
    const oldLocation = lineLocation(file, index, "LEFT");
    const matches = threads.filter((thread) => sameLine(thread.location, location) || (oldLocation && sameLine(thread.location, oldLocation)));
    let controls = row.querySelector<HTMLSpanElement>("[data-biff-comments]");
    if (!controls) { controls = document.createElement("span"); controls.dataset.biffComments = ""; row.append(controls); }
    controls.toggleAttribute("data-has-thread", matches.length > 0);

    // Only replace buttons when the preview changes, so keyboard focus survives renders.
    const signature = JSON.stringify(matches.map((thread) => [thread.id, thread.comments.map((comment) => [comment.body, comment.user.login, comment.html_url])]));
    if (controls.dataset.signature !== signature) {
      controls.replaceChildren();
      if (matches.length) {
        const first = matches[0];
        const comment = first.comments[0];
        const words = comment.body.trim().split(/\s+/);
        const preview = document.createElement("button");
        preview.type = "button";
        preview.dataset.thread = first.id;
        preview.textContent = `${comment.user.login} · ${words.slice(0, 4).join(" ")}${words.length > 4 ? "…" : ""}${matches.length > 1 ? ` +${matches.length - 1}` : ""}`;
        preview.setAttribute("aria-label", `Open comment thread on line ${first.location.line}: ${comment.user.login}`);
        controls.append(preview);
      }
      const add = document.createElement("button");
      add.type = "button";
      add.textContent = "+";
      add.setAttribute("aria-label", `Add comment on line ${location.line} (${location.side === "LEFT" ? "old" : "new"})`);
      controls.append(add);
      controls.dataset.signature = signature;
    }
    for (const button of controls.querySelectorAll("button")) {
      button.onclick = (event) => {
        event.stopPropagation();
        const thread = matches.find((entry) => entry.id === button.dataset.thread);
        const bounds = row.getBoundingClientRect();
        open({ line: thread?.location ?? location, threadId: thread?.id, anchor: { top: bounds.top, bottom: bounds.bottom } });
      };
    }
  }
}

/** Compare GitHub file coordinates without confusing old and new sides. */
export function sameLine(left: ReviewLine, right: ReviewLine): boolean {
  return left.path === right.path && left.line === right.line && left.side === right.side;
}
