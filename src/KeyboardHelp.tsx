/** Keep the review shortcut guide available without using space above the code. */
export function KeyboardHelp() {
  return <>
    <button className="settings-trigger keyboard-help-trigger" popoverTarget="keyboard-help" aria-label="Keyboard shortcuts">?</button>
    <section id="keyboard-help" className="settings-popover keyboard-help" popover="auto" role="dialog" aria-labelledby="keyboard-help-title">
      <h2 id="keyboard-help-title">Keyboard shortcuts</h2>
      <dl>
        <div><dt><kbd>Ctrl/Cmd+P</kbd></dt><dd>Go to file</dd></div>
        <div><dt><kbd>Ctrl/Cmd+F</kbd></dt><dd>Find files and symbols across the review</dd></div>
        <div><dt><kbd>j</kbd> / <kbd>k</kbd></dt><dd>Next / previous line</dd></div>
        <div><dt><kbd>n</kbd> / <kbd>p</kbd></dt><dd>Next / previous change (skips reviewed changes)</dd></div>
        <div><dt><kbd>Space</kbd></dt><dd>Mark change reviewed and advance (PRs and workspaces)</dd></div>
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
