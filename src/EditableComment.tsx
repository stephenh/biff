import { useState, type ReactNode } from "react";
import { Markdown } from "./Markdown";
import { ActivityScope } from "./ActivityStatus";
import { useSaveFeedback } from "./useSaveFeedback";

/** Keep failed edits in the composer; remove a comment only after its save succeeds. */
export function EditableComment(props: { scope: string; header: ReactNode; body: string; own: boolean; onOpen?(): void; onEdit(body: string): Promise<void>; onDelete(): Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(props.body);
  const [removing, setRemoving] = useState(false);
  const scope = `comment-edit:${props.scope}`;
  const { busy, setBusy, setError } = useSaveFeedback(scope, removing ? "Delete comment" : "Edit comment", () => void save(removing));

  /** Server errors leave the original comment and unsaved text available. */
  async function save(remove = false) {
    setBusy(true); setError("");
    setRemoving(remove);
    try {
      if (remove) await props.onDelete();
      else await props.onEdit(body);
      setEditing(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }

  return <>
    <div className="comment-author"><div className="comment-author-info">{props.header}</div><div className="card-actions comment-edit-actions">
      {editing ? <>
        <button disabled={busy || !body.trim()} onClick={() => void save()}>Save changes</button>
        <button disabled={busy} onClick={() => setEditing(false)}>Cancel</button>
      </> : props.own && <>
        <button disabled={busy} onClick={() => { setBody(props.body); setError(""); setEditing(true); }}>Edit</button>
        <button disabled={busy} onClick={() => void save(true)}>Delete</button>
      </>}
    </div></div>
    {editing ? <textarea autoFocus aria-label="Edit comment" value={body} disabled={busy} onChange={(event) => setBody(event.target.value)} /> : props.onOpen ? <button className="comment-preview" onClick={props.onOpen}><Markdown body={props.body} preview /></button> : <Markdown body={props.body} />}
    <ActivityScope scope={scope} />
  </>;
}
