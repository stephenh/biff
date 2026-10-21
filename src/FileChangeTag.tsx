import type { FileDiffMetadata } from "@pierre/diffs";

/** Show file-level status rather than guessing from whether its patch only adds or removes lines. */
export function FileChangeTag(props: { type: FileDiffMetadata["type"] }) {
  const status = props.type === "new" ? { code: "A", label: "Added file" }
    : props.type === "deleted" ? { code: "D", label: "Deleted file" }
    : { code: "U", label: "Updated file" };
  return <span className="file-change-tag" data-change={status.code} role="img" aria-label={status.label} title={status.label}>{status.code}</span>;
}
