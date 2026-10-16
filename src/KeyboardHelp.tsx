/** Keep the review shortcut guide available without using space above the code. */
export function KeyboardHelp() {
  return <>
    <button className="settings-trigger keyboard-help-trigger" popoverTarget="keyboard-help" aria-label="Keyboard shortcuts">?</button>
    <section id="keyboard-help" className="settings-popover keyboard-help" popover="auto" role="dialog" aria-labelledby="keyboard-help-title">
      <h2 id="keyboard-help-title">Keyboard shortcuts</h2>
      <dl>
        <div><dt><kbd>j</kbd> / <kbd>k</kbd></dt><dd>Next / previous line</dd></div>
        <div><dt><kbd>⇧J</kbd> / <kbd>⇧K</kbd></dt><dd>Next / previous change</dd></div>
        <div><dt><kbd>n</kbd> / <kbd>p</kbd></dt><dd>Next / previous file (also → / ←)</dd></div>
        <div><dt><kbd>⇧N</kbd></dt><dd>Mark viewed and open next file (PRs)</dd></div>
        <div><dt><kbd>d</kbd></dt><dd>Toggle nearby deleted lines</dd></div>
        <div><dt><kbd>⇧D</kbd> (hold)</dt><dd>Peek at nearby deleted lines</dd></div>
        <div><dt><kbd>u</kbd></dt><dd>Toggle unmodified lines</dd></div>
        <div><dt><kbd>⇧U</kbd> (hold)</dt><dd>Peek at unmodified lines</dd></div>
        <div><dt><kbd>c</kbd></dt><dd>Open comments on the focused line (PRs)</dd></div>
        <div><dt><kbd>Esc</kbd></dt><dd>Close a menu or comment overlay</dd></div>
      </dl>
    </section>
  </>;
}
