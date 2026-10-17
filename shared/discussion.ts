import type { ReviewIdentity } from "./progress";
import type { ReviewThread } from "./localReview";

export interface Discussion { identity: ReviewIdentity; version: number; threads: ReviewThread[]; publicationError?: string }
