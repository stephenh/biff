import type { InboxPR } from "../shared/inbox";
import type { PullRequest, PullRequestStatus } from "../shared/types";
import { useResource } from "./api";
import { OverviewDialog } from "./OverviewDialog";
import { PullRequestOverview } from "./PullRequestOverview";
import { PullRequestComments } from "./PullRequestComments";
import { useReviewDraft } from "./reviewDraft";
import { useConversation } from "./useConversation";
import { useLocalDiscussion } from "./LocalDiscussion";
import { FileComments } from "./FileComments";
import { useLocation } from "wouter";

/** Load PR metadata without fetching or mounting the diff viewer behind the inbox. */
export function InboxDiscussion(props: { pr: InboxPR; view: "overview" | "comments"; unreadOnly: boolean; onClose(): void }) {
  const endpoint = `/api/github/pr/${props.pr.repository.nameWithOwner}/${props.pr.number}`;
  const metadata = useResource<PullRequest>(`${endpoint}/metadata`);

  if (!metadata.data) {
    if (props.view === "comments") return <FileComments files={[]} path="" threads={[]} saveScope={`thread-resolution:${endpoint}`} reviewOnly loading={metadata.loading} error={metadata.error} onRetry={metadata.refresh} context={<strong>{props.pr.title}</strong>} onReply={() => {}} onClose={props.onClose} />;
    return <OverviewDialog title={props.pr.title} onClose={props.onClose}>{metadata.error ? <p role="alert" className="error">{metadata.error} <button onClick={metadata.refresh}>Retry</button></p> : <p role="status">Loading PR overview…</p>}</OverviewDialog>;
  }

  return props.view === "overview" ? <InboxOverview endpoint={endpoint} pr={metadata.data} status={props.pr.activity} onClose={props.onClose} /> : <InboxComments endpoint={endpoint} pr={metadata.data} unreadOnly={props.unreadOnly} onClose={props.onClose} />;
}

/** Overview does not need to fetch comment threads or change their read state. */
function InboxOverview(props: { endpoint: string; pr: PullRequest; status?: PullRequestStatus; onClose(): void }) {
  const draftState = useReviewDraft(props.endpoint, props.pr.head.sha, props.pr.base.sha);
  return <PullRequestOverview endpoint={props.endpoint} pr={props.pr} status={props.status} draftState={draftState} onClose={props.onClose} />;
}

/** Both the inbox and diff viewer supply the same review-wide comment browser. */
function InboxComments(props: { endpoint: string; pr: PullRequest; unreadOnly: boolean; onClose(): void }) {
  const [, navigate] = useLocation();
  const conversation = useConversation(props.endpoint);
  const local = useLocalDiscussion(props.endpoint, { commitId: props.pr.head.sha, baseCommitId: props.pr.base.sha }, conversation.refresh);
  return <PullRequestComments {...props} conversation={conversation} local={local} onGoToCode={(line) => {
    const query = new URLSearchParams({ path: line.path, line: String(line.line), side: line.side });
    if (line.approximate) query.set("approximate", "1");
    props.onClose();
    navigate(`${props.endpoint.replace("/api/github/pr/", "/pr/")}?${query}`);
  }} />;
}
