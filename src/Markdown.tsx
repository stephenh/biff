import ReactMarkdown from "react-markdown";
import type { ComponentProps } from "react";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";

const components: Components = { img: Screenshot, a: MarkdownLink };
const previewComponents: Components = { ...components, a: PreviewLink };

/** Share GitHub-style rendering across descriptions and discussion, keeping raw HTML sanitized. */
export function Markdown(props: { body: string; preview?: boolean; className?: string }) {
  return <div className={`markdown-text markdown-body ${props.className ?? ""}`}>
    <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} rehypePlugins={[rehypeRaw, rehypeSanitize]} components={props.preview ? previewComponents : components}>{props.body}</ReactMarkdown>
  </div>;
}

/** Private attachments need gh authentication even when the reader is logged into GitHub in another tab. */
function Screenshot(props: ComponentProps<"img">) {
  const attachment = /^https:\/\/github\.com\/user-attachments\/assets\/([a-f0-9-]+)$/i.exec(props.src ?? "");
  return <img src={attachment ? `/api/github/attachment/${attachment[1]}` : props.src} alt={props.alt ?? "PR screenshot"} title={props.title} width={props.width} loading="lazy" />;
}

/** Keep navigation from a discussion separate from the current review. */
function MarkdownLink(props: ComponentProps<"a">) {
  return <a href={props.href} title={props.title} target="_blank" rel="noopener noreferrer">{props.children}</a>;
}

/** Thread previews are already buttons; their links become actionable inside the opened thread. */
function PreviewLink(props: ComponentProps<"a">) {
  return <span className="markdown-link">{props.children}</span>;
}
