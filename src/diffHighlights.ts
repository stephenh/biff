import { diffDisplay } from "./config";

/** Main and frozen panes use Pierre's native renderer cache with the same syntax backend. */
export const diffHighlightOptions = { ...diffDisplay, preferredHighlighter: "highlights" } as const;
