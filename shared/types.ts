import type { ReviewIdentity } from "./progress";

export interface WorkingCopy { id: string; name: string; path: string }
export interface Revision {
  commit_id: string;
  change_id: string;
  description: string;
  author: { name: string; email: string; timestamp: string };
}
export interface LocalReview { workspace: WorkingCopy; revisions: Revision[]; selected: Revision; patch: string; bookmark?: string; bookmarks?: string[]; base?: Revision; baseLabel?: string; tip?: Revision; changes?: string; baseOverride?: string; progressScope?: string; identity?: ReviewIdentity }
export interface PullRequestSummary {
  number: number;
  title: string;
  url: string;
  repository: { nameWithOwner: string };
  author: { login: string };
  isDraft: boolean;
  updatedAt: string;
}
export interface PullRequest {
  number: number;
  title: string;
  body: string;
  html_url: string;
  state: string;
  draft: boolean;
  user: { login: string };
  head: { sha: string; ref: string };
  base: { sha: string; ref: string };
}
export interface Commit { sha: string; commit: { message: string; author: { name: string; date: string } } }
export interface GitHubReview { pr: PullRequest; commits: Commit[]; patch: string; commit: string }
export interface StackPosition { position: number; total: number; pulls: { number: number; title: string }[] }
export type FileViewedState = "VIEWED" | "UNVIEWED" | "DISMISSED";
export interface MentionUser { login: string; name: string | null }
export interface ViewedFiles { files: Record<string, FileViewedState> }
export interface DiscussionComment {
  id: number;
  body: string;
  user: { login: string };
  html_url: string;
  created_at?: string;
  submitted_at?: string;
  state?: string;
  path?: string;
  line?: number | null;
  original_line?: number;
  side?: "LEFT" | "RIGHT";
  in_reply_to_id?: number;
  reviewThread?: { id: string; resolved: boolean; canResolve: boolean; canReopen: boolean };
}
export interface Conversation {
  comments: DiscussionComment[];
  inline: DiscussionComment[];
  reviews: DiscussionComment[];
}
export interface ReviewLine { path: string; line: number; side: "LEFT" | "RIGHT" }
export interface DraftComment extends ReviewLine { body: string }
export interface ReviewSubmission { event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES"; body: string; commitId: string; comments: DraftComment[] }
