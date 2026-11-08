import { createContext, useContext, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link, useLocation } from "wouter";
import { ActivityIndicator } from "./ActivityIndicator";
import { ModalHeader } from "./ModalHeader";
import { Settings, type useReadingSettings } from "./Settings";
import { PageShortcuts } from "./shortcuts";

export const NavigationTarget = createContext<((target: HTMLDivElement | null) => void) | undefined>(undefined);

/** Keep the brand's size and position identical on dashboards and reviews. */
export function BiffBrand(props: { tagline?: boolean }) {
  return <Link className="brand" href="/workspaces">biff{props.tagline && <span>big diff. easy eyes.</span>}</Link>;
}

/** Reserve space in the review toolbar instead of spending a row on global navigation. */
export function ReviewNavigation() {
  return <div className="review-navigation" ref={useContext(NavigationTarget)} />;
}

/** Keep the shell controls available on dashboards and in the active review toolbar. */
export function ShellNavigation(props: { target: HTMLDivElement | null; reading: ReturnType<typeof useReadingSettings> }) {
  if (props.target) return createPortal(<>
    <BiffMenu />
    <Settings {...props.reading} trigger={false} />
    <PageShortcuts />
    <ActivityIndicator global />
  </>, props.target);

  return <header className="shell-header">
    <BiffBrand tagline />
    <nav className="shell-nav" aria-label="Main navigation">
      <NavigationLinks />
      <Settings {...props.reading} />
      <PageShortcuts />
      <ActivityIndicator global />
    </nav>
  </header>;
}

/** Native popover dismissal and tab navigation keep this a small navigation panel, not an application menu. */
function BiffMenu() {
  const panel = useRef<HTMLElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);

  return <>
    <button type="button" ref={trigger} className="biff-menu-trigger" popoverTarget="biff-menu" aria-label="Biff menu" aria-expanded={open}>
      <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><circle cx="4" cy="10" r="1.5" /><circle cx="10" cy="10" r="1.5" /><circle cx="16" cy="10" r="1.5" /></svg>
    </button>
    <section id="biff-menu" ref={panel} className="biff-menu" popover="auto" role="dialog" aria-labelledby="biff-menu-title" onToggle={(event) => {
      setOpen(event.newState === "open");
      if (event.newState === "open") event.currentTarget.querySelector<HTMLAnchorElement>("nav a")?.focus();
    }}>
      <ModalHeader title="Biff" titleId="biff-menu-title" closeLabel="Close Biff menu" popoverTarget="biff-menu" activity={false} />
      <nav aria-label="Main navigation" onClick={(event) => { if (event.target instanceof Element && event.target.closest("a")) panel.current?.hidePopover(); }}>
        <NavigationLinks />
        <button type="button" className="settings-trigger" onClick={() => {
          // A native invoker inside this panel would keep it open beneath Settings.
          panel.current?.hidePopover();
          trigger.current?.focus({ preventScroll: true });
          document.getElementById("reading-settings")?.showPopover();
        }}>Settings</button>
      </nav>
    </section>
  </>;
}

/** Share destinations and current-page semantics between full and compact navigation. */
function NavigationLinks() {
  const [location] = useLocation();
  return <>
    <Link href="/prs" aria-current={location === "/prs" ? "page" : undefined}>My PRs</Link>
    <Link href="/needs-review" aria-current={location === "/needs-review" ? "page" : undefined}>Needs Review</Link>
    <Link href="/workspaces" aria-current={location.startsWith("/workspaces") ? "page" : undefined}>Working Copies</Link>
  </>;
}
