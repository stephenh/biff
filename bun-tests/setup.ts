import { preloadHighlighter } from "@pierre/diffs";
import { diffHighlightOptions } from "../src/diffHighlights";

// Pierre's first highlighter wins process-wide, even for later explicit preferences.
// Renderer tests must exercise the backend the browser uses, regardless of file order.
await preloadHighlighter({ preferredHighlighter: diffHighlightOptions.preferredHighlighter, themes: [diffHighlightOptions.theme], langs: [] });
