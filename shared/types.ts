export interface WorkingCopy { id: string; name: string; path: string }
export interface Revision {
  commit_id: string;
  change_id: string;
  description: string;
  author: { name: string; email: string; timestamp: string };
}
export interface LocalReview { workspace: WorkingCopy; revisions: Revision[]; selected: Revision; patch: string }
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
}
export interface Conversation {
  comments: DiscussionComment[];
  inline: DiscussionComment[];
  reviews: DiscussionComment[];
}
export interface ReviewLine { path: string; line: number; side: "LEFT" | "RIGHT" }
export interface DraftComment extends ReviewLine { body: string }
export interface ReviewSubmission { event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES"; body: string; commitId: string; comments: DraftComment[] }
