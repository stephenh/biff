import { useState } from "react";
import type { DiscussionComment } from "../shared/types";
import { post } from "./api";

/** Change the GitHub thread itself, retaining the previous state if GitHub rejects the write. */
export function ThreadResolution(props: { endpoint: string; thread: DiscussionComment["reviewThread"]; onChanged(): void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const thread = props.thread;
  if (!thread) return null;

  /** Reload authoritative permissions and resolution state after the mutation succeeds. */
  async function toggle() {
    if (!thread) return;
    setBusy(true); setError("");
    try {
      await post(`${props.endpoint}/thread`, { id: thread.id, resolved: !thread.resolved });
      props.onChanged();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }

  return <div className="thread-resolution">
    <button disabled={busy || !(thread.resolved ? thread.canReopen : thread.canResolve)} onClick={() => void toggle()}>{thread.resolved ? "Reopen thread" : "Resolve thread"}</button>
    {error && <p className="error" role="alert">{error}</p>}
  </div>;
}
