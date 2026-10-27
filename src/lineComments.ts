import type { FileDiffMetadata } from "@pierre/diffs";
import type { DiscussionComment, ReviewLine } from "../shared/types";
import { lineLocation } from "./navigation";
import { prepareCommentAnchor } from "./commentOverlayStyle";
import { captureLineAnchor } from "./lineAnchor";

export interface LineThread {
  id: string;
  /** Non-inline conversations have no source coordinate or GitHub resolution control. */
  kind?: "general" | "review";
  location: ReviewLine;
  comments: (DiscussionComment & { readKey?: string; own?: boolean })[];
  draftIndex?: number;
  readKeys?: string[];
  unreadCount?: number;
  unreadKeys?: string[];
  outdated?: boolean;
  needsReanchoring?: boolean;
  resolved?: boolean;
  canResolve?: boolean;
  canReopen?: boolean;
}
export interface CommentSelection {
  line: ReviewLine;
  threadId?: string;
  /** A gutter shared by several roots asks the viewer to choose before opening a thread. */
  threadIds?: string[];
  anchor?: { top: number; bottom: number; row?: HTMLElement; viewport?: HTMLElement; above?: boolean };
  /** File comments owns the dialog when navigating into a thread from its list. */
  embedded?: boolean;
  reviewWide?: boolean;
  /** A submitted GitHub comment returns to the owning review or inbox. */
  onSubmitted?: () => void;
}

/**
 * Place comment counts beside line numbers and a short preview strip below their code.
 *
 * Pierre owns separate code and gutter subgrids. Shared row coordinates keep counts attached
 * to the same file line after context expansion and renderer updates.
 */
export function syncLineComments(container: HTMLElement, file: FileDiffMetadata, threads: LineThread[], open?: (selection: CommentSelection) => void) {
  const root = container.shadowRoot;
  if (!root || !open) return;
  const restoreAnchor = captureLineAnchor(root);
  if (!root.querySelector("[data-biff-comment-style]")) {
    const style = document.createElement("style");
    style.dataset.biffCommentStyle = "";
    style.textContent = `
      [data-gutter] > [data-line-index] { position: relative; }
      [data-biff-comments] { position: absolute; left: 3px; top: 50%; transform: translateY(-50%); z-index: 3; display: grid; place-items: center; min-width: 22px; height: 22px; padding: 0 3px; border: 1px solid #42454e; border-radius: 6px; color: #9a9da7; background: #202125; font: 500 11px/1 Inter, system-ui, sans-serif; font-variant-numeric: tabular-nums; cursor: pointer; }
      [data-biff-comments][data-unread] { color: #f0c77a; border-color: #75603b; background: #352c1c; }
      [data-biff-comments]:hover { color: #e8e9ed; border-color: #777be0; background: #292b43; }
      [data-biff-comments]:focus-visible { outline: 2px solid #b4b8ff; outline-offset: 2px; }
      [data-biff-comment-row] { --biff-comment-height: 12px; padding-bottom: var(--biff-comment-height); }
      [data-biff-comment-row] > [data-biff-comments] { top: calc(50% - var(--biff-comment-height) / 2); }
      [data-biff-comment-preview] { position: absolute; inset: auto 0 0; height: var(--biff-comment-height); margin: 0; padding: 0 1ch; border: 0; border-radius: 0; text-align: left; font: 9px/var(--biff-comment-height) system-ui, sans-serif; color: #d4d6dc; background: #3b3d43; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; user-select: none; }
      [data-biff-comment-preview]::after { content: "↳ " attr(data-biff-comment-preview); }
      [data-biff-comment-preview][data-unread] { color: #f0f1f4; }
      [data-biff-comment-preview]:hover { color: #fff; background: #4b4e56; }
      [data-biff-comment-preview]:focus-visible { outline: 1px solid #e8e9ed; outline-offset: -1px; }
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
    let preview = row.querySelector<HTMLButtonElement>("[data-biff-comment-preview]");
    row.toggleAttribute("data-biff-comment-row", matches.length > 0);
    gutter.toggleAttribute("data-biff-comment-row", matches.length > 0);
    if (!matches.length) { button?.remove(); preview?.remove(); continue; }

    // Reuse the button so refreshes and read acknowledgements preserve keyboard focus.
    if (!button) {
      button = document.createElement("button");
      button.type = "button";
      button.dataset.biffComments = "";
      gutter.append(button);
    }
    if (!preview) {
      preview = document.createElement("button");
      preview.type = "button";
      row.append(preview);
    }
    const unread = matches.reduce((count, thread) => count + (thread.unreadCount ?? 0), 0);
    const total = matches.reduce((count, thread) => count + thread.comments.length, 0);
    const count = unread || total;
    button.textContent = matches.length > 1 ? `${matches.length}▾` : count > 99 ? "99+" : String(count);
    button.toggleAttribute("data-unread", unread > 0);
    button.title = `${matches.length > 1 ? `Choose from ${matches.length} threads · ` : ""}${unread ? `${unread} unread · ` : ""}${total} ${total === 1 ? "comment" : "comments"}`;
    button.setAttribute("aria-label", matches.length > 1 ? `${matches.length} threads on line ${location.line}` : `${count} ${unread ? "unread " : ""}${count === 1 ? "comment" : "comments"} on line ${location.line}`);
    button.onclick = (event) => {
      event.stopPropagation();
      if (matches.length > 1) {
        const bounds = row.getBoundingClientRect();
        open({ line: matches[0].location, threadIds: matches.map((thread) => thread.id), anchor: { top: bounds.top, bottom: bounds.bottom, row, viewport: container.closest<HTMLElement>(".viewport") ?? undefined } });
        return;
      }
      const thread = matches.find((entry) => (entry.unreadCount ?? 0) > 0) ?? matches[0];
      open({ line: thread.location, threadId: thread.id, anchor: prepareCommentAnchor(row) });
    };
    // Generated text keeps the preview out of source copying and search highlights.
    const excerpt = commentExcerpt(matches[0].comments[0]?.body ?? "");
    preview.dataset.biffCommentPreview = excerpt;
    preview.toggleAttribute("data-unread", unread > 0);
    preview.title = button.title;
    preview.setAttribute("aria-label", `Open comments on line ${location.line}: ${excerpt}`);
    preview.onclick = button.onclick;
  }
  restoreAnchor?.();
}

/** Compare GitHub file coordinates without confusing old and new sides. */
export function sameLine(left: ReviewLine, right: ReviewLine): boolean {
  return left.path === right.path && left.line === right.line && left.side === right.side;
}

/** Keep the opening sentence recognizable without turning a comment strip into another code row. */
function commentExcerpt(body: string): string {
  const text = body.trim().replace(/\s+/g, " ");
  const sentence = new Intl.Segmenter("en", { granularity: "sentence" }).segment(text)[Symbol.iterator]().next().value?.segment ?? "";
  const words = sentence.trim().split(/\s+/);
  return words.slice(0, 4).join(" ") + (words.length > 4 ? "…" : "") || "Comment";
}
