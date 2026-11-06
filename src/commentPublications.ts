import type { Conversation, DiscussionComment } from "../shared/types";
import type { BackgroundSave } from "./optimisticSave";

interface Publication {
  id: string;
  localId: number;
  draftId?: string;
  kind: "comments" | "inline";
  comment: DiscussionComment;
  acknowledged: boolean;
  observed?: boolean;
}

/** Keep submitted text visible across modal dismissal, navigation, and lagging cached reads. */
export class CommentPublications {
  private entries = new Map<string, Map<string, Publication>>();
  private listeners = new Set<() => void>();
  private version = 0;
  private nextId = -1_000_000;

  /** React needs a stable snapshot between publication changes. */
  getSnapshot() { return this.version; }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }

  /** Capture one immutable append; retrying the same submission must not append it twice. */
  add(endpoint: string, id: string, kind: Publication["kind"], comment: Omit<DiscussionComment, "id">, draftId?: string) {
    let entries = this.entries.get(endpoint);
    if (!entries) { entries = new Map(); this.entries.set(endpoint, entries); }
    if (entries.has(id)) return;

    const localId = this.nextId--;
    entries.set(id, { id, localId, draftId, kind, comment: { ...comment, id: localId }, acknowledged: false });
    this.notify();
  }

  /** Install GitHub's receipt before clearing the draft, without waiting for a cached refresh. */
  acknowledge(endpoint: string, id: string, comment: DiscussionComment) {
    const entry = this.entries.get(endpoint)?.get(id);
    if (!entry) return;
    entry.comment = { ...entry.comment, ...comment };
    entry.acknowledged = true;
    this.notify();
  }

  /** A successful deletion can precede the first cached read that contains the publication. */
  remove(endpoint: string, kind: Publication["kind"], id: number) {
    const entries = this.entries.get(endpoint);
    if (!entries) return;
    for (const entry of entries.values()) {
      if (entry.kind === kind && entry.acknowledged && entry.comment.id === id) entries.delete(entry.id);
    }
    this.notify();
  }

  /**
   * Prefer cached server values once present, but bridge reads that have not observed publication.
   *
   * Keep the local identity for the SPA lifetime, like background-save queues: an open thread
   * must not disappear when its temporary ID becomes a GitHub ID, even after remounting.
   */
  project(endpoint: string, conversation: Conversation | undefined, saves: BackgroundSave[]): Conversation | undefined {
    const entries = this.entries.get(endpoint);
    if (!entries?.size) return conversation;

    const result = { ...conversation, comments: [...(conversation?.comments ?? [])], inline: [...(conversation?.inline ?? [])], reviews: conversation?.reviews ?? [] };
    for (const entry of entries.values()) {
      const comments = result[entry.kind];
      const index = entry.acknowledged ? comments.findIndex((comment) => comment.id === entry.comment.id) : -1;
      // Once a cache has included this comment, a later absence can mean it was deleted.
      if (index >= 0) entry.observed = true;
      else if (entry.observed) continue;

      const receipt = saves.find((save) => save.id === `github-comments:${endpoint}:${entry.id}`);
      const publication = { localId: entry.localId, draftId: entry.draftId, status: entry.acknowledged ? "saved" as const : receipt?.status ?? "saving" };
      const comment = { ...(index < 0 ? entry.comment : comments[index]), publication };
      if (index < 0) comments.push(comment);
      else comments[index] = comment;
    }

    return result;
  }

  /** Notify every mounted reader of the same PR. */
  private notify() { this.version++; this.listeners.forEach((listener) => listener()); }
}

export const commentPublications = new CommentPublications();

/** The thread stays selected while GitHub replaces its temporary comment identity. */
export function publicationThreadId(comment: DiscussionComment, kind: "general" | "inline") {
  const id = comment.publication?.localId ?? comment.id;
  return kind === "general" ? `general:${id}` : `comment-${id}`;
}

/** Pending or failed submissions must not expose remote edit, reply, or resolution actions. */
export function publicationPending(comment: DiscussionComment) {
  return Boolean(comment.publication && comment.publication.status !== "saved");
}
