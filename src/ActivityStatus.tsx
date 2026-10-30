import { useLayoutEffect, useRef } from "react";
import { activities, useActivity, type ActivityState } from "./activity";

/** Declare feedback at its source while presenting it only in the owning header. */
export function ActivityStatus(props: ActivityState) {
  const scope = useActivity(props);
  return <ActivityScope scope={scope} />;
}

/** Bind an existing resource or background-save scope to its nearest modal, if any. */
export function ActivityScope(props: { scope?: string }) {
  const marker = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    if (props.scope && marker.current) return activities.bind(props.scope, marker.current);
  }, [props.scope]);
  return <span ref={marker} hidden aria-hidden="true" />;
}
