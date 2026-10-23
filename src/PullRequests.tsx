import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, Redirect, useLocation, useSearch } from "wouter";
import { inboxMatches, type InboxAction, type InboxFilter, type InboxPR, type PullActivity } from "../shared/inbox";
import { post } from "./api";
import { useInbox } from "./useInbox";

const filters: InboxFilter[] = ["all", "unread", "follow-ups", "snoozed", "ignored", "archived"];

/**
 * Present a persistent personal inbox without acknowledging activity just by listing it.
 *
 * Keep the visible order stable during keyboard navigation, even as background refreshes update badges.
 */
export function PullRequests() {
  const [location, navigate] = useLocation();
  const params = new URLSearchParams(useSearch());
  const view = location === "/needs-review" ? "requested" : "authored";
  const author = view === "requested" ? params.get("author") ?? "" : "";
  const resource = useInbox(view, params.get("filter") === "archived");
  const [filter, setFilter] = useState("");
  const [repository, setRepository] = useState("");
  const [sort, setSort] = useState<"attention" | "recent">("attention");
  const preferencesView = useRef("");
  const mode = filters.includes(params.get("filter") as InboxFilter) ? params.get("filter") as InboxFilter : "all";
  const [prUrl, setPrUrl] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string>();
  const [undo, setUndo] = useState<{ id: string; token: string; label: string }>();
  const list = useRef<HTMLDivElement>(null);
  const focus = useRef({ id: "", index: 0 });
  const order = useRef<{ key: string; ids: string[] }>({ key: "", ids: [] });
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/.*)?$/.exec(prUrl.trim());
  const path = match ? `/pr/${match[1]}/${match[2]}/${match[3]}` : undefined;
  const items = resource.data?.items ?? [];
  const repositories = [...new Set(items.map((pr) => pr.repository.nameWithOwner))].sort();
  const matching = items.filter((pr) => (!repository || pr.repository.nameWithOwner === repository) && `${pr.title} ${pr.repository.nameWithOwner} ${pr.number} ${pr.author.login}`.toLowerCase().includes(filter.trim().toLowerCase()));
  const authors = [...new Set([...matching.filter((pr) => inboxMatches(pr, mode)).map((pr) => pr.author.login), ...(author ? [author] : [])])].sort((a, b) => a.localeCompare(b));
  const filtered = matching.filter((pr) => inboxMatches(pr, mode) && (!author || pr.author.login === author));
  const orderKey = `${view}:${mode}:${sort}:${repository}:${filter}:${author}`;
  const holdingFocus = list.current?.contains(document.activeElement);
  filtered.sort((a, b) => {
    if (sort === "attention") {
      const rank = Number(b.personal.pinned) - Number(a.personal.pinned) || Number(b.followUpCount > 0) - Number(a.followUpCount > 0) || Number(b.unread) - Number(a.unread);
      if (rank) return rank;
    }
    return b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id);
  });
  if (order.current.key === orderKey && holdingFocus) {
    const positions = new Map(order.current.ids.map((id, index) => [id, index]));
    filtered.sort((a, b) => (positions.get(a.id) ?? Infinity) - (positions.get(b.id) ?? Infinity));
  }

  useLayoutEffect(() => {
    order.current = { key: orderKey, ids: filtered.map((pr) => pr.id) };
    const retained = filtered.findIndex((pr) => pr.id === focus.current.id);
    if (retained >= 0) focus.current.index = retained;
    // Never steal focus from a filter or menu while an asynchronous refresh completes.
    if (document.activeElement !== document.body && document.activeElement !== null) return;
    const links = list.current?.querySelectorAll<HTMLAnchorElement>(".card-title");
    const next = links?.[Math.min(focus.current.index, links.length - 1)];
    next?.focus({ preventScroll: true });
  });

  useEffect(() => {
    if (!resource.data || preferencesView.current === view) return;
    preferencesView.current = view;
    setSort(resource.data.preferences?.sort ?? "attention");
    setRepository(resource.data.preferences?.repository ?? "");
  }, [resource.data, view]);
  useEffect(() => { focus.current = { id: "", index: 0 }; }, [view, mode, author]);
  useEffect(() => {
    if (!undo) return;
    const timer = window.setTimeout(() => setUndo(undefined), 60_000);
    return () => window.clearTimeout(timer);
  }, [undo]);

  useEffect(() => {
    /** Dismiss row menus with the same outside-click and Escape behavior as other menus. */
    function closeMenus(event: Event) {
      const escape = event instanceof KeyboardEvent && event.key === "Escape";
      if (event instanceof KeyboardEvent && !escape) return;
      list.current?.querySelectorAll<HTMLDetailsElement>("details[open]").forEach((menu) => {
        if (!escape && event.target instanceof Node && menu.contains(event.target)) return;
        menu.open = false;
        if (escape) menu.querySelector("summary")?.focus();
      });
    }
    window.addEventListener("pointerdown", closeMenus);
    window.addEventListener("keydown", closeMenus);
    return () => {
      window.removeEventListener("pointerdown", closeMenus);
      window.removeEventListener("keydown", closeMenus);
    };
  }, []);

  /** Persist preferences without waiting to apply the reader's selection. */
  async function savePreferences(nextSort: "attention" | "recent", nextRepository: string) {
    preferencesView.current = view;
    setSort(nextSort);
    setRepository(nextRepository);
    try { await post(`/api/inbox/preferences?view=${view}`, { sort: nextSort, repository: nextRepository }); }
    catch (cause) { setError(`Could not save preferences: ${(cause as Error).message}`); }
  }

  /** Remember URL-opened reviews before navigating so they survive the next queue refresh. */
  async function openPR() {
    if (!match || !path || busy) return;
    setBusy("open");
    setError("");
    try {
      await post(`/api/github/pr/${match[1]}/${match[2]}/${match[3]}/track`, {});
      navigate(path);
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(undefined); }
  }

  /** Save personal choices before removing rows, preserving a one-minute undo receipt. */
  async function act(pr: InboxPR, action: InboxAction) {
    if (busy) return;
    setBusy(pr.id);
    setError("");
    try {
      const result = await post<{ undo?: string }>(`/api/github/pr/${pr.id}/inbox`, action);
      if (result.undo) setUndo({ id: pr.id, token: result.undo, label: actionLabel(action) });
      list.current?.querySelectorAll("details[open]").forEach((menu) => menu.removeAttribute("open"));
      // Focus the selected title first; if it disappears, the layout effect chooses its neighbor.
      list.current?.querySelector<HTMLAnchorElement>(`[data-pr-id="${pr.id}"] .card-title`)?.focus({ preventScroll: true });
      await resource.reload();
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(undefined); }
  }

  /** Undo only the action recorded by this notification. */
  async function undoAction() {
    if (!undo) return;
    try {
      await post(`/api/github/pr/${undo.id}/inbox`, { action: "undo", token: undo.token });
      setUndo(undefined);
      await resource.reload();
    } catch (cause) { setError((cause as Error).message); }
  }

  useEffect(() => {
    /** Keep horizontal author navigation separate from vertical triage and native link actions. */
    function onKeyDown(event: KeyboardEvent) {
      const key = event.key === "S" || event.key === "I" ? event.key.toLowerCase() : event.key;
      if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey || (event.shiftKey && key !== "s" && key !== "i") || !["j", "k", "h", "l", "s", "i", "u"].includes(key)) return;
      if (event.composedPath().some((target) => target instanceof HTMLElement && target.closest("input, textarea, select, [contenteditable]")) || document.querySelector('dialog[open], [role="dialog"]:not([popover]), [popover]:popover-open, details[open]')) return;
      if (event.key === "h" || event.key === "l") {
        if (view !== "requested") return;
        event.preventDefault();
        const tabs = ["", ...authors];
        const next = tabs[Math.max(0, Math.min(tabs.length - 1, tabs.indexOf(author) + (event.key === "h" ? -1 : 1)))]!;
        navigate(inboxLink(location, mode, next));
        return;
      }
      const links = Array.from(list.current?.querySelectorAll<HTMLAnchorElement>(".card-title") ?? []);
      if (!links.length) return;
      const index = links.findIndex((link) => link.closest(".pr-card")?.contains(document.activeElement));
      const pr = filtered[index];
      if (["s", "i", "u"].includes(key)) {
        if (pr) {
          event.preventDefault();
          if (event.repeat) return;
          if (key === "s") void act(pr, { action: pr.personal.snoozeUntil > Date.now() ? "unsnooze" : "snooze" });
          else if (key === "i") void act(pr, { action: pr.personal.ignored ? "restore" : "ignore" });
          else void act(pr, readAction(pr));
        }
        return;
      }
      const next = index < 0 ? 0 : Math.max(0, Math.min(links.length - 1, index + (event.key === "j" ? 1 : -1)));
      event.preventDefault();
      links[next]!.focus({ preventScroll: true });
      links[next]!.scrollIntoView({ block: "nearest" });
    }
    // Handle row navigation before native link actions; g sequences belong to the shell.
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  });

  if (location === "/prs" && ["requested", "dependabot"].includes(params.get("view") ?? "")) return <Redirect to={inboxLink("/needs-review", mode, params.get("view") === "dependabot" ? "dependabot" : "")} />;

  return <main className="dashboard">
    <div className="page-heading"><div><h1>{view === "authored" ? "My PRs" : "Needs Review"}</h1><p>Your personal inbox. Pick up what changed.</p></div><button disabled={resource.data?.refreshing} onClick={() => void resource.refresh()}>Refresh</button></div>
    <div className="dashboard-tools"><input aria-label="Filter PRs" placeholder="Filter by author, repository, title, or number" value={filter} onChange={(event) => setFilter(event.target.value)} onKeyDown={(event) => {
      if (event.key !== "Enter" || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || event.nativeEvent.isComposing) return;
      event.preventDefault();
      const first = list.current?.querySelector<HTMLAnchorElement>(".card-title");
      first?.focus({ preventScroll: true });
      first?.scrollIntoView({ block: "nearest" });
    }} /></div>
    <div className="inbox-filters"><nav className="tabs" aria-label="Inbox filters">{filters.map((entry) => <Link key={entry} className={mode === entry ? "active" : ""} href={inboxLink(location, entry, author)}>{entry[0].toUpperCase() + entry.slice(1)} <span className="inbox-count">{matching.filter((pr) => inboxMatches(pr, entry) && (!author || pr.author.login === author)).length}</span></Link>)}</nav>
      <select aria-label="Repository filter" value={repository} onChange={(event) => void savePreferences(sort, event.target.value)}><option value="">All repositories</option>{[...new Set([...repositories, ...(repository ? [repository] : [])])].map((repo) => <option key={repo}>{repo}</option>)}</select>
      <select aria-label="Sort PRs" value={sort} onChange={(event) => void savePreferences(event.target.value === "recent" ? "recent" : "attention", repository)}><option value="attention">Needs attention</option><option value="recent">Recent activity</option></select>
    </div>
    {view === "requested" && <nav className="tabs author-tabs" aria-label="Review authors"><Link className={!author ? "active" : ""} href={inboxLink(location, mode, "")}>All</Link>{authors.map((login) => <Link key={login} className={author === login ? "active" : ""} href={inboxLink(location, mode, login)} title="Number of PRs, oldest PR age, newest PR age">{login} ({authorStats(matching.filter((pr) => pr.author.login === login && inboxMatches(pr, mode)))})</Link>)}</nav>}
    <p className="muted inbox-sync" role="status">{resource.data?.updatedAt ? `Updated ${age(resource.data.updatedAt)}` : "Waiting for the first GitHub snapshot"}{resource.data?.refreshing ? " · Refreshing in background…" : ""}</p>
    {mode === "ignored" && <p className="muted">Ignored PRs stay hidden from active inbox filters, even when new activity arrives. Restore one to return it to your inbox.</p>}
    {mode === "archived" && <p className="muted">Archived reviews stay searchable without background GitHub polling. Open one to restore it for seven days, or Refresh to update this history.</p>}
    {undo && <div className="inbox-notice" role="status">{undo.label} <button onClick={() => void undoAction()}>Undo</button><button aria-label="Dismiss notification" onClick={() => setUndo(undefined)}>×</button></div>}
    {(error || resource.error || resource.data?.error) && <p role="alert" className="error">{error || resource.error || resource.data?.error} · Saved PRs remain available.</p>}
    <div className="pr-list" ref={list} onFocusCapture={(event) => {
      const card = (event.target as HTMLElement).closest<HTMLElement>("[data-pr-id]");
      const index = filtered.findIndex((pr) => pr.id === card?.dataset.prId);
      if (index >= 0) focus.current = { id: filtered[index]!.id, index };
    }} onKeyDown={(event) => {
      if (event.key !== "Enter" || !event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || event.nativeEvent.isComposing) return;
      const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a.card-title") : null;
      if (!link) return;
      event.preventDefault();
      if (!event.repeat) {
        // Leave the key event before opening: Chromium otherwise carries Shift into the new-window policy.
        const tab = document.createElement("a");
        tab.href = link.href;
        tab.target = "_blank";
        tab.rel = "noopener noreferrer";
        window.setTimeout(() => tab.click(), 0);
      }
    }}>{filtered.map((pr) => <article className={`pr-card ${pr.unread ? "pr-unread" : ""}`} key={pr.id} data-pr-id={pr.id}>
      <div className="pr-summary"><div>
        <span className={`badge ${pr.state === "MERGED" ? "merged" : pr.state === "CLOSED" ? "closed" : pr.isDraft ? "draft" : "open"}`}>{pr.state === "MERGED" ? "Merged" : pr.state === "CLOSED" ? "Closed" : pr.isDraft ? "Draft" : "Open"}</span>
        <Link className="card-title" href={`/pr/${pr.repository.nameWithOwner}/${pr.number}`}>{pr.title}</Link>
        {pr.activity?.reviewDecision === "APPROVED" && <span className="pr-approved-check" role="img" aria-label="Approved" title={reviewLabel(pr.activity)}>✓</span>}
        {pr.activity?.checks === "Failing" && <span className="pr-ci-failing" role="img" aria-label="CI failing" title="One or more CI checks failed">×</span>}
      </div>
        <p className="muted">{pr.repository.nameWithOwner} #{pr.number} · {pr.author.login} · {age(Date.parse(pr.updatedAt))}</p>
        <div className="inbox-badges">{pr.personal.pinned && <span>Pinned</span>}{pr.personal.isNew && <span className="activity-badge">New to queue</span>}{pr.personal.unread && <span className="activity-badge">Unread</span>}{pr.newCommits && <span className="activity-badge">New commits</span>}{pr.newReplies > 0 && <span className="activity-badge">{pr.newReplies} new {pr.newReplies === 1 ? "reply" : "replies"}</span>}{pr.newReviews > 0 && <span className="activity-badge">{pr.newReviews} new {pr.newReviews === 1 ? "review" : "reviews"}</span>}
          {pr.activity && <><span>{reviewLabel(pr.activity)}</span>{pr.activity.checks !== "Failing" && <span>CI: {pr.activity.checks}</span>}</>}
          {pr.activityError && <span title={pr.activityError}>Activity refresh failed</span>}
          {pr.followUpCount > 0 && <Link className="follow-up-active" href={`/pr/${pr.repository.nameWithOwner}/${pr.number}?followUp=first`}>{pr.followUpCount} follow-ups</Link>}
          {pr.personal.snoozeUntil > Date.now() && <span>Snoozed until {new Date(pr.personal.snoozeUntil).toLocaleString()}</span>}
        </div>
      </div>
      <div className="inbox-row-actions"><a href={`/pr/${pr.repository.nameWithOwner}/${pr.number}`} target="_blank" rel="noreferrer" aria-label={`Open PR ${pr.number} in new tab`}>↗</a><details><summary aria-label={`Actions for PR ${pr.number}`}>•••</summary><div className="inbox-menu">
        <button disabled={Boolean(busy)} onClick={() => void act(pr, readAction(pr))}>{pr.unread ? "Mark read" : "Mark unread"}</button>
        <button disabled={Boolean(busy)} onClick={() => void act(pr, { action: pr.personal.pinned ? "unpin" : "pin" })}>{pr.personal.pinned ? "Unpin" : "Pin"}</button>
        {pr.personal.snoozeUntil > Date.now() ? <button disabled={Boolean(busy)} onClick={() => void act(pr, { action: "unsnooze" })}>Unsnooze</button> : <button disabled={Boolean(busy)} onClick={() => void act(pr, { action: "snooze" })}>Snooze for 1 day</button>}
        <button disabled={Boolean(busy)} onClick={() => void act(pr, { action: pr.personal.ignored ? "restore" : "ignore" })}>{pr.personal.ignored ? "Restore to inbox" : "Ignore permanently"}</button>
      </div></details></div>
    </article>)}</div>
    {resource.data && filtered.length === 0 && <p className="empty-state">{resource.data.refreshing && !resource.data.updatedAt ? "Loading your PRs…" : "No PRs in this view."}</p>}
    {resource.data?.truncated && <p className="muted">GitHub searches return at most 100 PRs. Previously tracked reviews are retained separately.</p>}
    <form className="register-form" onSubmit={(event) => { event.preventDefault(); void openPR(); }}><input aria-label="GitHub PR URL" placeholder="Or paste any GitHub PR URL…" value={prUrl} onChange={(event) => setPrUrl(event.target.value)} />{path && <button type="submit" disabled={Boolean(busy)}>Open PR</button>}</form>
  </main>;
}

/** Preserve the other tab selection when changing status or author. */
function inboxLink(path: string, mode: InboxFilter, author: string): string {
  const params = new URLSearchParams();
  if (mode !== "all") params.set("filter", mode);
  if (author) params.set("author", author);
  return `${path}${params.size ? `?${params}` : ""}`;
}

/** Older snapshots use activity dates until GitHub supplies creation dates on refresh. */
function authorStats(items: InboxPR[]): string {
  if (!items.length) return "0";
  const dates = items.map((pr) => Date.parse(pr.createdAt ?? pr.updatedAt));
  return `${items.length}, ${age(Math.min(...dates)).replace(" ago", "").replace("just now", "0m")}, ${age(Math.max(...dates)).replace(" ago", "").replace("just now", "0m")}`;
}

/** Acknowledge only the snapshot displayed, never activity arriving during the save. */
function readAction(pr: InboxPR): InboxAction { return pr.unread ? { action: "read", head: pr.activity?.head, events: pr.activity?.events.map((event) => event.key) } : { action: "unread" }; }
function actionLabel(action: InboxAction) {
  const labels: Record<string, string> = { ignore: "PR ignored", restore: "PR restored", snooze: "PR snoozed for 1 day", unsnooze: "PR unsnoozed", pin: "PR pinned", unpin: "PR unpinned", read: "PR marked read", unread: "PR marked unread" };
  return labels[action.action] || "PR updated";
}
/** Name current approvers, including personal approval when other required reviews are still pending. */
function reviewLabel(activity: PullActivity): string {
  const status = activity.reviewDecision === "APPROVED" ? "Approved" : activity.reviewDecision === "CHANGES_REQUESTED" ? "Changes requested" : "Awaiting review";
  if (!activity.approvers?.length) return status;
  const names = activity.approvers.map((login) => `@${login}`);
  const approvals = `Approved by ${names.join(", ")}`;
  return activity.reviewDecision === "APPROVED" ? approvals : `${status} · ${approvals}`;
}
/** Relative times update as local snapshots are polled, even when GitHub is offline. */
function age(timestamp: number) {
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60_000));
  return minutes < 1 ? "just now" : minutes < 60 ? `${minutes}m ago` : minutes < 1440 ? `${Math.floor(minutes / 60)}h ago` : `${Math.floor(minutes / 1440)}d ago`;
}
