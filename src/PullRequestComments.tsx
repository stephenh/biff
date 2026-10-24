import { useMemo, useState } from "react";
import type { PullRequest } from "../shared/types";
import type { CommentSelection } from "./lineComments";
import type { useConversation } from "./useConversation";
import type { useLocalDiscussion } from "./LocalDiscussion";
import { buildDiscussionThreads, buildThreads, generalDiscussionThread, saveThreadResolution } from "./githubCommentThreads";
import { useCommentReads } from "./useCommentReads";
import { useThreadResolutions } from "./useThreadResolutions";
import { FileComments } from "./FileComments";
import { GitHubCommentThread } from "./GitHubCommentThread";

/** Feed PR discussions into the same list, keyboard navigation, and thread detail as file comments. */
export function PullRequestComments(props: {
  endpoint: string; pr: PullRequest; conversation: ReturnType<typeof useConversation>;
  local?: ReturnType<typeof useLocalDiscussion>; unreadOnly?: boolean; onClose(): void;
}) {
  const [active, setActive] = useState<CommentSelection>();
  const threads = useMemo(() => buildDiscussionThreads(props.conversation.data, buildThreads(props.conversation.data, []), props.pr.user.login), [props.conversation.data, props.pr.user.login]);
  const reads = useCommentReads(props.endpoint, threads);
  const allThreads = useMemo(() => [...reads.threads, ...(props.local?.allThreads ?? [])], [reads.threads, props.local?.allThreads]);
  const saveScope = `thread-resolution:${props.endpoint}`;
  const resolutions = useThreadResolutions(saveScope, allThreads, resolve);
  const files = useMemo(() => [...new Set(allThreads.filter((thread) => !thread.kind).map((thread) => thread.location.path))].map((name) => ({ name })), [allThreads]);
  const thread = resolutions.threads.find((thread) => thread.id === active?.threadId) ?? (active?.threadId === "general" ? generalDiscussionThread() : undefined);

  /** Local and GitHub threads retain their own permission and persistence contracts. */
  async function resolve(id: string, resolved: boolean) {
    if (id.startsWith("local:") && props.local) await props.local.resolveThread(id, resolved);
    else await saveThreadResolution(props.endpoint, props.conversation, id, resolved);
  }

  /** Opening a conversation does not acknowledge its unread messages. */
  function open(selection: CommentSelection) {
    if (selection.threadId?.startsWith("local:") && props.local) props.local.open(selection);
    else setActive(selection);
  }

  const content = active && thread ? <GitHubCommentThread key={thread.id} endpoint={props.endpoint} thread={thread} selection={active} reads={reads} onClose={() => setActive(undefined)} onChanged={props.conversation.refresh} /> : props.local?.commentContent;

  return <FileComments files={files} path="" threads={resolutions.threads} saveScope={saveScope} reviewOnly unreadOnly={props.unreadOnly} threadContent={content} activeThreadId={active?.threadId ?? props.local?.activeThreadId}
    loading={!props.conversation.data && props.conversation.loading} error={props.conversation.error || reads.error} onRetry={props.conversation.refresh}
    context={<><strong>{props.pr.title}</strong>{props.local?.content}</>}
    onRead={(thread) => { if (thread.id.startsWith("local:") && props.local) props.local.markRead(thread); else reads.markRead(thread); }} onReply={open} onResolve={resolutions.resolve} onClose={props.onClose} onNewComment={() => open({ threadId: "general", line: generalDiscussionThread().location, embedded: true, reviewWide: true, onSubmitted: props.onClose })} />;
}
