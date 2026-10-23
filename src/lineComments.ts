import type { FileDiffMetadata } from "@pierre/diffs";
import type { DiscussionComment, ReviewLine } from "../shared/types";
import { lineLocation } from "./navigation";
import { prepareCommentAnchor } from "./commentOverlayStyle";

export interface LineThread {
  id: string;
  /** Non-inline conversations have no source coordinate or GitHub resolution control. */
  kind?: "general" | "review";
  location: ReviewLine;
  comments: DiscussionComment[];
  draftIndex?: number;
  readKeys?: string[];
  unreadCount?: number;
  unreadKeys?: string[];
  outdated?: boolean;
  resolved?: boolean;
  canResolve?: boolean;
  canReopen?: boolean;
}
export interface CommentSelection {
  line: ReviewLine;
  threadId?: string;
  anchor?: { top: number; bottom: number; row?: HTMLElement; viewport?: HTMLElement; above?: boolean };
  /** File comments owns the dialog when navigating into a thread from its list. */
  embedded?: boolean;
  reviewWide?: boolean;
  /** A submitted GitHub comment returns to the owning review or inbox. */
  onSubmitted?: () => void;
}

/**
 * Place compact comment counts beside line numbers without covering code or changing row heights.
 *
 * Pierre owns separate code and gutter subgrids. Shared row coordinates keep counts attached
 * to the same file line after context expansion and renderer updates.
 */
export function syncLineComments(container: HTMLElement, file: FileDiffMetadata, threads: LineThread[], open?: (selection: CommentSelection) => void) {
  const root = container.shadowRoot;
  if (!root || !open) return;
  if (!root.querySelector("[data-biff-comment-style]")) {
    const style = document.createElement("style");
    style.dataset.biffCommentStyle = "";
    style.textContent = `
      [data-gutter] > [data-line-index] { position: relative; }
      [data-biff-comments] { position: absolute; left: 3px; top: 50%; transform: translateY(-50%); z-index: 3; display: grid; place-items: center; min-width: 22px; height: 22px; padding: 0 3px; border: 1px solid #42454e; border-radius: 6px; color: #9a9da7; background: #202125; font: 500 11px/1 Inter, system-ui, sans-serif; font-variant-numeric: tabular-nums; cursor: pointer; }
      [data-biff-comments][data-unread] { color: #f0c77a; border-color: #75603b; background: #352c1c; }
      [data-biff-comments]:hover { color: #e8e9ed; border-color: #777be0; background: #292b43; }
      [data-biff-comments]:focus-visible { outline: 2px solid #b4b8ff; outline-offset: 2px; }
    `;
    root.append(style);
  }

  const gutters = new Map(Array.from(root.querySelectorAll<HTMLElement>("[data-gutter] > [data-line-index]")).map((gutter) => [gutter.dataset.lineIndex, gutter]));
  for (const row of root.querySelectorAll<HTMLElement>("[data-content] > [data-line]")) {
    const index = Number(row.dataset.lineIndex!.split(",")[0]);
    const location = lineLocation(file, index);
    const gutter = gutters.get(row.dataset.lineIndex);
    if (!location || !gutter) continue;
    const oldLocation = lineLocation(file, index, "LEFT");
    const matches = threads.filter((thread) => sameLine(thread.location, location) || (oldLocation && sameLine(thread.location, oldLocation)));
    let button = gutter.querySelector<HTMLButtonElement>("[data-biff-comments]");
    if (!matches.length) { button?.remove(); continue; }

    // Reuse the button so refreshes and read acknowledgements preserve keyboard focus.
    if (!button) {
      button = document.createElement("button");
      button.type = "button";
      button.dataset.biffComments = "";
      gutter.append(button);
    }
    const unread = matches.reduce((count, thread) => count + (thread.unreadCount ?? 0), 0);
    const total = matches.reduce((count, thread) => count + thread.comments.length, 0);
    const count = unread || total;
    button.textContent = count > 99 ? "99+" : String(count);
    button.toggleAttribute("data-unread", unread > 0);
    button.title = `${unread ? `${unread} unread · ` : ""}${total} ${total === 1 ? "comment" : "comments"}`;
    button.setAttribute("aria-label", `${count} ${unread ? "unread " : ""}${count === 1 ? "comment" : "comments"} on line ${location.line}`);
    button.onclick = (event) => {
      event.stopPropagation();
      const thread = matches.find((entry) => (entry.unreadCount ?? 0) > 0) ?? matches[0];
      open({ line: thread.location, threadId: thread.id, anchor: prepareCommentAnchor(row) });
    };
  }
}

/** Compare GitHub file coordinates without confusing old and new sides. */
export function sameLine(left: ReviewLine, right: ReviewLine): boolean {
  return left.path === right.path && left.line === right.line && left.side === right.side;
}
