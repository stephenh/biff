/** Keep the review shortcut guide available without using space above the code. */
export function KeyboardHelp() {
  return <>
    <button className="settings-trigger keyboard-help-trigger" popoverTarget="keyboard-help" aria-label="Keyboard shortcuts">?</button>
    <section id="keyboard-help" className="settings-popover keyboard-help" popover="auto" role="dialog" aria-labelledby="keyboard-help-title">
      <h2 id="keyboard-help-title">Keyboard shortcuts</h2>
      <dl>
        <div><dt><kbd>g</kbd> <kbd>g</kbd></dt><dd>Open current PR on GitHub in a new tab</dd></div>
        <div><dt><kbd>g</kbd> <kbd>w</kbd></dt><dd>Go to Working Copies</dd></div>
        <div><dt><kbd>g</kbd> <kbd>r</kbd></dt><dd>Go to PRs</dd></div>
        <div><dt><kbd>Ctrl/Cmd+P</kbd></dt><dd>Go to file</dd></div>
        <div><dt><kbd>Ctrl/Cmd+F</kbd></dt><dd>Find files and symbols across the review</dd></div>
        <div><dt><kbd>/</kbd></dt><dd>Find in the current file; yellow highlights, Enter / Shift+Enter for next / previous, Esc to clear</dd></div>
        <div><dt><kbd>j</kbd> / <kbd>k</kbd></dt><dd>Next / previous line or PR in the queue</dd></div>
        <div><dt><kbd>Enter</kbd></dt><dd>Open focused PR in the queue</dd></div>
        <div><dt><kbd>⇧Enter</kbd></dt><dd>Open focused PR in a new Biff tab</dd></div>
        <div><dt><kbd>g</kbd></dt><dd>Open focused PR on GitHub (in the PR queue)</dd></div>
        <div><dt><kbd>h</kbd> / <kbd>l</kbd></dt><dd>Previous / next PR queue, including Dependabot</dd></div>
        <div><dt><kbd>s</kbd> / <kbd>S</kbd></dt><dd>Toggle focused PR snoozed for 1 day</dd></div>
        <div><dt><kbd>i</kbd> / <kbd>I</kbd></dt><dd>Toggle focused PR ignored / restored</dd></div>
        <div><dt><kbd>u</kbd></dt><dd>Mark focused PR read / unread (in the PR queue)</dd></div>
        <div><dt><kbd>n</kbd> / <kbd>p</kbd></dt><dd>Next / previous change (skips reviewed changes)</dd></div>
        <div><dt><kbd>f</kbd></dt><dd>Freeze current line in a scrollable right pane; press again to replace the reference</dd></div>
        <div><dt><kbd>Esc</kbd></dt><dd>Close the frozen reference after closing any active search or overlay</dd></div>
        <div><dt><kbd>Space</kbd></dt><dd>Mark change reviewed and advance (PRs and workspaces)</dd></div>
        <div><dt><kbd>!</kbd></dt><dd>Mark reviewed, flag for follow-up, and advance; clear an existing flag</dd></div>
        <div><dt><kbd>N</kbd> / <kbd>P</kbd></dt><dd>Next / previous follow-up across files (wraps)</dd></div>
        <div><dt><kbd>h</kbd> / <kbd>l</kbd></dt><dd>Previous / next file (also ← / →)</dd></div>
        <div><dt><kbd>⇧H</kbd> / <kbd>⇧L</kbd></dt><dd>Mark file reviewed and open previous / next file</dd></div>
        <div><dt><kbd>d</kbd></dt><dd>Toggle nearby deleted lines</dd></div>
        <div><dt><kbd>⇧D</kbd> (hold)</dt><dd>Peek at nearby deleted lines</dd></div>
        <div><dt><kbd>u</kbd></dt><dd>Toggle unmodified lines</dd></div>
        <div><dt><kbd>⇧U</kbd> (hold)</dt><dd>Peek at unmodified lines</dd></div>
        <div><dt><kbd>c</kbd></dt><dd>Open comments on the focused line (PRs)</dd></div>
        <div><dt><kbd>g</kbd> <kbd>c</kbd></dt><dd>Open this file's comments, including orphaned threads; toggle Entire review for all files</dd></div>
        <div><dt><kbd>j</kbd> / <kbd>k</kbd></dt><dd>Next / previous thread in file comments</dd></div>
        <div><dt><kbd>h</kbd> / <kbd>l</kbd></dt><dd>This file / entire review in file comments (also ← / →)</dd></div>
        <div><dt><kbd>Enter</kbd></dt><dd>Open the focused thread and focus its reply box (including resolved threads)</dd></div>
        <div><dt><kbd>r</kbd> / <kbd>u</kbd></dt><dd>Resolve / unresolve a thread in file comments (outside text fields)</dd></div>
        <div><dt><kbd>Esc</kbd></dt><dd>Return from a thread to all file comments</dd></div>
        <div><dt><kbd>Enter</kbd> / <kbd>Space</kbd></dt><dd>Expand / collapse the focused Imports section</dd></div>
        <div><dt><kbd>Esc</kbd></dt><dd>Close a menu or comment overlay</dd></div>
      </dl>
    </section>
  </>;
}
