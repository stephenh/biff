import { useFollowUps } from "./useFollowUps";
import { ActivityScope } from "./ActivityStatus";

/** Follow-up belongs to the thread; resolving it or editing a reply does not clear this choice. */
export function FollowUpButton(props: { endpoint: string; thread: string }) {
  const followUps = useFollowUps(props.endpoint);
  const flagged = followUps.hasThread(props.thread);
  return <>
    <button className={flagged ? "follow-up-active" : ""} aria-pressed={flagged} disabled={!followUps.ready || followUps.busy} onClick={() => void followUps.thread(props.thread, !flagged)}>{flagged ? "Clear follow-up" : "Follow up"}</button>
    <ActivityScope scope={followUps.scope} /><ActivityScope scope={followUps.activity} />
  </>;
}
