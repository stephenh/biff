import type { LocalReview, ReviewLine } from "./types";

export interface ReviewMessage {
  id: string;
  author: "user" | "agent";
  body: string;
  createdAt: string;
  sequence: number;
  published?: { pr: string; id: number; url: string; publishedAt: string };
  publicationPending?: boolean;
}

export interface ReviewThread {
  id: string;
  anchor: ReviewLine & { endLine: number; commitId: string; baseCommitId?: string; excerpt: string; fileHash?: string; oldPath?: string };
  resolved: boolean;
  humanSequence: number;
  messages: ReviewMessage[];
}

export interface ReviewSession {
  version: 1;
  id: string;
  agentSession: string;
  snapshot: LocalReview;
  sequence: number;
  humanSequence: number;
  acknowledged: number;
  updatedAt: string;
  finished: boolean;
  threads: ReviewThread[];
  discussionScope?: string;
}
