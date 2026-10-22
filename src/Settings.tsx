import { createContext, useEffect, useState } from "react";
import { DiffPerformance } from "./DiffPerformance";
import "@fontsource/jetbrains-mono/latin-400.css";
import "@fontsource/jetbrains-mono/latin-500.css";
import "@fontsource/monaspace-argon/latin-400.css";
import "@fontsource/monaspace-argon/latin-500.css";

const codeFonts = ["IBM Plex Mono", "JetBrains Mono", "Monaspace Argon"];
interface ReadingSettings { font: string; size: number; collapseDeleted: boolean }
type SettingsState = ReturnType<typeof useReadingSettings>;
export const CollapseDeletedContext = createContext(true);
export const ReadingTypographyContext = createContext({ font: "IBM Plex Mono", size: 22 });

/** Remember reading preferences across reviews and browser restarts. */
export function useReadingSettings() {
  const [settings, setSettings] = useState(readSettings);

  useEffect(() => {
    try {
      localStorage.setItem("biff:code-font", settings.font);
      localStorage.setItem("biff:code-size", String(settings.size));
      localStorage.setItem("biff:collapse-deleted", String(settings.collapseDeleted));
    } catch { /* Settings still apply when browser storage is unavailable. */ }
  }, [settings]);

  return { settings, setSettings };
}

/** Keep reading preferences in a dismissible top-navigation popover. */
export function Settings(props: SettingsState) {
  return <>
    <button className="settings-trigger" popoverTarget="reading-settings">Settings</button>
    <section id="reading-settings" className="settings-popover" popover="auto" role="dialog" aria-labelledby="settings-title">
      <h2 id="settings-title">Settings</h2>
      <label>Code font<select aria-label="Code font" value={props.settings.font} onChange={(event) => props.setSettings((current) => ({ ...current, font: event.target.value }))}>{codeFonts.map((font) => <option key={font} value={font}>{font}</option>)}</select></label>
      <label>Text size <output>{props.settings.size}px</output><input aria-label="Text size" type="range" min="16" max="34" value={props.settings.size} onChange={(event) => props.setSettings((current) => ({ ...current, size: Number(event.target.value) }))} /></label>
      <label className="settings-checkbox"><input type="checkbox" checked={props.settings.collapseDeleted} onChange={(event) => props.setSettings((current) => ({ ...current, collapseDeleted: event.target.checked }))} />Collapse deleted lines</label>
      <DiffPerformance />
    </section>
  </>;
}

/** Restore validated preferences, including the existing font selection. */
function readSettings(): ReadingSettings {
  let font = codeFonts[0];
  let size = 22;
  let collapseDeleted = true;
  try {
    const savedFont = localStorage.getItem("biff:code-font");
    const savedSize = Number(localStorage.getItem("biff:code-size"));
    if (savedFont && codeFonts.includes(savedFont)) font = savedFont;
    if (Number.isInteger(savedSize) && savedSize >= 16 && savedSize <= 34) size = savedSize;
    collapseDeleted = localStorage.getItem("biff:collapse-deleted") !== "false";
  } catch { /* Use defaults when browser storage is unavailable. */ }
  return { font, size, collapseDeleted };
}
