import type { ChangeIdentity, ReviewIdentity } from "./progress";

export interface WorkingCopy { id: string; name: string; path: string }
export interface Revision {
  commit_id: string;
  change_id: string;
  description: string;
  author: { name: string; email: string; timestamp: string };
}
export interface LocalReview { snapshotId?: string; workspace: WorkingCopy; revisions: Revision[]; selected: Revision; patch: string; bookmark?: string; bookmarks?: string[]; base?: Revision; baseLabel?: string; tip?: Revision; bookmarkTip?: Revision; changes?: string; baseOverride?: string; progressScope?: string; identity?: ReviewIdentity; followWorkingCopy?: boolean }
export interface PullRequestSummary {
  number: number;
  title: string;
  url: string;
  repository: { nameWithOwner: string };
  author: { login: string };
  isDraft: boolean;
  updatedAt: string;
  createdAt?: string;
}
export interface PullRequest {
  changed_files?: number;
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
export interface PullRequestStatus {
  reviewDecision: string;
  /** Older saved snapshots do not include current approvers until their next refresh. */
  approvers?: string[];
  checks: string;
  reviewRequested?: boolean;
  viewerHasApproved?: boolean;
  viewerReReviewRequested?: boolean;
}
export interface FailedCheck { name: string; url: string }
export interface StackPosition {
  position: number;
  total: number;
  pulls: { number: number; title: string }[];
}
export type FileViewedState = "VIEWED" | "UNVIEWED" | "DISMISSED";
export interface MentionUser { login: string; name: string | null }
export interface ViewedFiles { files: Record<string, FileViewedState>; syncErrors?: { path: string; error: string }[] }
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
  commit_id?: string;
  original_commit_id?: string;
  pull_request_review_id?: number;
  diff_hunk?: string;
  biffAttachment?: CommentAttachment;
  reviewThread?: { id: string; resolved: boolean; canResolve: boolean; canReopen: boolean };
}
export interface Conversation {
  commentReads?: string[];
  viewer?: string;
  comments: DiscussionComment[];
  inline: DiscussionComment[];
  reviews: DiscussionComment[];
}
export interface ReviewLine { path: string; line: number; side: "LEFT" | "RIGHT" }
export interface CommentAttachment extends ReviewLine { commitId: string; baseCommitId: string; matched: boolean }
export interface CommentHunkAnchor { change: ChangeIdentity; offset: number; text: string; lineCount?: number }
export interface DraftComment extends ReviewLine { body: string; id?: string; anchor?: CommentHunkAnchor; commitId?: string; baseCommitId?: string; needsReanchoring?: boolean; reanchor?: boolean; supersedes?: string }
export interface ReviewDraft { commitId: string; body: string; comments: DraftComment[]; version?: number; currentHead?: string; currentBase?: string }
export interface ReviewSubmission { event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES"; body: string; commitId: string; comments: DraftComment[] }
