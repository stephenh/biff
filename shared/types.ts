import type { ChangeIdentity, ReviewIdentity } from "./progress";

export interface WorkingCopy { id: string; name: string; path: string; vcs?: "git" | "jj" }
export interface Revision {
  /** Live Git selections use a worktree: freshness token, not a Git object ID. */
  commit_id: string;
  /** JJ change ID, Git commit ID, or the working-tree progress key. */
  change_id: string;
  description: string;
  author: { name: string; email: string; timestamp: string };
}
export interface GitFileStamp { mtimeMs: number; size: number }
/** Freshness stamps for live Git reads, not retained versions of working-tree files. */
export interface GitWorkingTree {
  head?: string;
  branch: string;
  index: GitFileStamp | null;
  base?: string;
  files: Record<string, { stamp: GitFileStamp | null; oldPath: string; added: boolean; deleted: boolean }>;
}
export interface LocalReview { reconciliation?: boolean; snapshotId?: string; workspace: WorkingCopy; revisions: Revision[]; selected: Revision; patch: string; bookmark?: string; bookmarks?: string[]; base?: Revision; baseLabel?: string; tip?: Revision; bookmarkTip?: Revision; changes?: string; baseOverride?: string; progressScope?: string; identity?: ReviewIdentity; followWorkingCopy?: boolean; workingTree?: GitWorkingTree }
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
export interface GitHubReview { reconciliation?: boolean; pr: PullRequest; commits: Commit[]; patch: string; commit: string }
export interface PullRequestStatus {
  reviewDecision: string;
  /** Older saved snapshots do not include current approvers until their next refresh. */
  approvers?: string[];
  changeRequesters?: string[];
  checks: string;
  reviewRequested?: boolean;
  viewerHasApproved?: boolean;
  viewerRequestedChanges?: boolean;
  viewerReReviewRequested?: boolean;
  viewerNewChanges?: boolean;
  newChangesVersion?: number;
  previousReviewState?: string;
}
export interface FailedCheck { name: string; url: string }
export interface StackPosition {
  position: number;
  total: number;
  pulls: { number: number; title: string; progress?: { reviewed: number; total: number } }[];
}
export type FileViewedState = "VIEWED" | "UNVIEWED" | "DISMISSED";
export interface MentionUser { login: string; name: string | null }
export interface ViewedFiles { files: Record<string, FileViewedState>; syncing?: boolean; syncError?: string; syncErrors?: { path: string; error: string }[] }
export interface DiscussionComment {
  id: number;
  body: string;
  user: { login: string; type?: string };
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
  /** Personal Biff state for top-level PR comments; never written to GitHub. */
  biffResolved?: boolean;
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
export interface ReviewSubmission { event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES"; body: string; commitId: string; baseCommitId?: string; comments: DraftComment[] }
