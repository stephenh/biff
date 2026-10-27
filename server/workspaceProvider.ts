import type { LocalReview, WorkingCopy } from "../shared/types";

export interface SnapshotContents {
  oldFile: { name: string; contents: string };
  newFile: { name: string; contents: string };
}

/** Source operations use registered workspaces; review state always belongs to the server. */
export interface WorkspaceProvider {
  review(workspace: WorkingCopy, revision: string): Promise<LocalReview>;
  bookmarkReview(workspace: WorkingCopy, bookmark?: string, changes?: string, baseOverride?: string, followWorkingCopy?: boolean): Promise<LocalReview>;
  contents(workspace: WorkingCopy, commit: string, path: string, base?: string): Promise<SnapshotContents>;
}
