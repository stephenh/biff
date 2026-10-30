import { ActivityScope } from "./ActivityStatus";

/** Existing save scopes declare ownership here; feedback lives in the shared header indicator. */
export function BackgroundSaveStatus(props: { scope?: string }) {
  return <ActivityScope scope={props.scope} />;
}
