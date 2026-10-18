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
        <div><dt><kbd>j</kbd> / <kbd>k</kbd></dt><dd>Next / previous line or PR in the queue</dd></div>
        <div><dt><kbd>Enter</kbd></dt><dd>Open focused PR in the queue</dd></div>
        <div><dt><kbd>⇧Enter</kbd></dt><dd>Open focused PR in a new Biff tab</dd></div>
        <div><dt><kbd>g</kbd></dt><dd>Open focused PR on GitHub (in the PR queue)</dd></div>
        <div><dt><kbd>h</kbd> / <kbd>l</kbd></dt><dd>My open PRs / Needs my review (in the PR queue)</dd></div>
        <div><dt><kbd>s</kbd></dt><dd>Snooze focused PR for 1 day (new activity wakes it)</dd></div>
        <div><dt><kbd>u</kbd></dt><dd>Mark focused PR read / unread (in the PR queue)</dd></div>
        <div><dt><kbd>n</kbd> / <kbd>p</kbd></dt><dd>Next / previous change (skips reviewed changes)</dd></div>
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
        <div><dt><kbd>Enter</kbd> / <kbd>Space</kbd></dt><dd>Expand / collapse the focused Imports section</dd></div>
        <div><dt><kbd>Esc</kbd></dt><dd>Close a menu or comment overlay</dd></div>
      </dl>
    </section>
  </>;
}
