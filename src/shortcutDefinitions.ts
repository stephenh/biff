import type { Shortcut } from "./shortcuts";

export const inboxShortcuts: Shortcut[] = [
  { keys: "j", description: "Next PR" }, { keys: "k", description: "Previous PR" },
  { keys: "s", aliases: ["S"], description: "Snooze / unsnooze focused PR" },
  { keys: "a", aliases: ["A"], description: "Archive / restore focused PR" },
];
export const authorShortcuts: Shortcut[] = [
  { keys: "h", description: "Previous author" }, { keys: "l", description: "Next author" },
];
export const viewerShortcuts: Shortcut[] = [
  { keys: "j", description: "Next line" }, { keys: "k", description: "Previous line" },
  { keys: "n", description: "Next unreviewed change" }, { keys: "p", description: "Previous unreviewed change" },
  { keys: "h", aliases: ["ArrowLeft"], description: "Previous file" }, { keys: "l", aliases: ["ArrowRight"], description: "Next file" },
  { keys: "d", description: "Toggle nearby deleted lines" }, { keys: "D", description: "Hold to peek at deleted lines" },
  { keys: "u", description: "Toggle unmodified lines" }, { keys: "U", description: "Hold to peek at unmodified lines" },
  { keys: "f", description: "Freeze current line in a reference pane" }, { keys: "/", description: "Find in current file" },
  { keys: "Mod+p", description: "Go to file" }, { keys: "Mod+f", description: "Find files and symbols" },
];
export const progressShortcuts: Shortcut[] = [
  { keys: " ", description: "Mark change reviewed and advance" },
  { keys: "!", description: "Toggle follow-up; mark reviewed and advance" },
  { keys: "N", description: "Next follow-up" }, { keys: "P", description: "Previous follow-up" },
  { keys: "H", description: "Mark file reviewed and open previous file" }, { keys: "L", description: "Mark file reviewed and open next file" },
];
export const pickerShortcuts: Shortcut[] = [
  { keys: "ArrowDown", description: "Next result" }, { keys: "ArrowUp", description: "Previous result" },
  { keys: "Enter", description: "Open selected result" }, { keys: "Escape", description: "Close" },
];
export const commentShortcuts: Shortcut[] = [
  { keys: "j", aliases: ["ArrowDown"], description: "Next thread" }, { keys: "k", aliases: ["ArrowUp"], description: "Previous thread" },
  { keys: "h", aliases: ["ArrowLeft"], description: "This file" }, { keys: "l", aliases: ["ArrowRight"], description: "Entire review" },
  { keys: "Enter", description: "Open focused thread and reply" },
];
