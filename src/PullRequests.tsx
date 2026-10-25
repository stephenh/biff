import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link, Redirect, useLocation, useSearch } from "wouter";
import { inboxMatches, type InboxAction, type InboxFilter, type InboxPR, type PersonalState, type PullActivity } from "../shared/inbox";
import { post } from "./api";
import { useInbox } from "./useInbox";
import { matchesShortcut, registerShortcuts } from "./shortcuts";
import { authorShortcuts, inboxShortcuts } from "./shortcutDefinitions";
import { UnreadThreadBadge } from "./UnreadThreadBadge";
import { InboxDiscussion } from "./InboxDiscussion";
import { useOptimisticSave } from "./useOptimisticSave";
import { BackgroundSaveStatus } from "./BackgroundSaveStatus";

const filters: InboxFilter[] = ["todo", "follow-ups", "unread", "snoozed", "archived", "all"];
const inboxSaveScope = "inbox-personal";

/**
 * Present a persistent personal inbox without acknowledging activity just by listing it.
 *
 * Keep the visible order stable during keyboard navigation, even as background refreshes update badges.
 */
export function PullRequests() {
  const [location] = useLocation();
  return <InboxView key={location} />;
}

/** Keep each queue's browser preferences separate when switching between inbox routes. */
function InboxView() {
  const [location, navigate] = useLocation();
  const params = new URLSearchParams(useSearch());
  const view = location === "/needs-review" ? "requested" : "authored";
  const [remembered] = useState(() => readInboxSelection(view));
  const requestedAuthor = view === "requested" ? params.get("author") ?? (params.size ? "" : remembered.author) : "";
  const selectedMode = params.get("filter") ?? (params.size ? "todo" : remembered.mode);
  const mode = filters.includes(selectedMode as InboxFilter) ? selectedMode as InboxFilter : "todo";
  const resource = useInbox(view, mode === "archived");
  const [filter, setFilter] = useState(remembered.search);
  const [repository, setRepository] = useState("");
  const preferencesView = useRef("");
  const [prUrl, setPrUrl] = useState("");
  const [error, setError] = useState("");
  const [discussion, setDiscussion] = useState<{ pr: InboxPR; view: "overview" | "comments"; unreadOnly: boolean }>();
  const [busy, setBusy] = useState<string>();
  const [undo, setUndo] = useState<{ id: string; token: string; label: string; previous: PersonalState }>();
  const list = useRef<HTMLDivElement>(null);
  const focus = useRef({ id: "", index: 0 });
  const order = useRef<{ key: string; ids: string[] }>({ key: "", ids: [] });
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/.*)?$/.exec(prUrl.trim());
  const path = match ? `/pr/${match[1]}/${match[2]}/${match[3]}` : undefined;
  const savedPersonal = useMemo(() => new Map(resource.data?.items.map((pr) => [pr.id, JSON.stringify(pr.personal)])), [resource.data]);
  const saves = useOptimisticSave(inboxSaveScope, savedPersonal);
  const items = (resource.data?.items ?? []).map((pr) => {
    const personal: PersonalState = JSON.parse(saves.value(pr.id, JSON.stringify(pr.personal)));
    return { ...pr, personal, archivedAt: personal.restoredUntil > Date.now() ? undefined : pr.archivedAt };
  });
  const repositories = [...new Set(items.map((pr) => pr.repository.nameWithOwner))].sort();
  const matching = items.filter((pr) => (!repository || pr.repository.nameWithOwner === repository) && `${pr.title} ${pr.repository.nameWithOwner} ${pr.number} ${pr.author.login}`.toLowerCase().includes(filter.trim().toLowerCase()));
  const oldestByAuthor = new Map<string, number>();
  for (const pr of matching.filter((pr) => inboxMatches(pr, mode))) {
    const created = Date.parse(pr.createdAt ?? pr.updatedAt);
    oldestByAuthor.set(pr.author.login, Math.min(oldestByAuthor.get(pr.author.login) ?? Infinity, created));
  }
  const authors = [...oldestByAuthor.keys()].sort((a, b) => {
    const botOrder = Number(/^dependabot(?:\[bot\])?$/i.test(a)) - Number(/^dependabot(?:\[bot\])?$/i.test(b));
    return botOrder || (oldestByAuthor.get(a) ?? Infinity) - (oldestByAuthor.get(b) ?? Infinity) || a.localeCompare(b);
  });
  const author = view === "requested" ? (authors.includes(requestedAuthor) ? requestedAuthor : authors[0] ?? "") : "";
  const filtered = matching.filter((pr) => inboxMatches(pr, mode) && (!author || pr.author.login === author));
  const orderKey = `${view}:${mode}:${repository}:${filter}:${author}`;
  const holdingFocus = Boolean(discussion) || list.current?.contains(document.activeElement);
  filtered.sort((a, b) => {
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
    try { localStorage.setItem(`biff:inbox-selection:${view}`, JSON.stringify({ mode, author: requestedAuthor, search: filter })); }
    catch { /* Storage may be disabled; the current selection still works in this tab. */ }
  }, [view, mode, requestedAuthor, filter]);

  useEffect(() => {
    if (!resource.data || preferencesView.current === view) return;
    preferencesView.current = view;
    setRepository(resource.data.preferences?.repository ?? "");
  }, [resource.data, view]);
  useEffect(() => { focus.current = { id: "", index: 0 }; }, [view, mode, author]);
  useEffect(() => {
    if (!undo) return;
    const timer = window.setTimeout(() => setUndo(undefined), 5_000);
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
  async function savePreferences(nextRepository: string) {
    preferencesView.current = view;
    setRepository(nextRepository);
    try { await post(`/api/inbox/preferences?view=${view}`, { repository: nextRepository }); }
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

  /** Apply the whole personal intent immediately, serializing rapid changes to this PR. */
  function act(pr: InboxPR, action: InboxAction) {
    const personal = { ...pr.personal };
    if (action.action === "archive") personal.archived = true;
    else if (action.action === "restore") { personal.archived = false; personal.restoredUntil = Date.now() + 7 * 86_400_000; }
    else if (action.action === "snooze") personal.snoozeUntil = Date.now() + 86_400_000;
    else if (action.action === "unsnooze") personal.snoozeUntil = 0;
    else return;
    list.current?.querySelectorAll("details[open]").forEach((menu) => menu.removeAttribute("open"));
    list.current?.querySelector<HTMLAnchorElement>(`[data-pr-id="${pr.id}"] .card-title`)?.focus({ preventScroll: true });
    saves.save(pr.id, JSON.stringify(personal), JSON.stringify(pr.personal), async (value) => {
      const result = await post<{ undo: string; previous: PersonalState }>(`/api/github/pr/${pr.id}/inbox`, { action: "set", personal: JSON.parse(value) });
      setUndo({ id: pr.id, token: result.undo, label: actionLabel(action), previous: result.previous });
      void resource.reload();
    }, `${actionLabel(action)} · ${pr.repository.nameWithOwner} #${pr.number}`);
  }

  /** Undo only the action recorded by this notification. */
  function undoAction() {
    if (!undo) return;
    const current = items.find((pr) => pr.id === undo.id);
    if (!current) return;
    saves.save(undo.id, JSON.stringify(undo.previous), JSON.stringify(current.personal), async () => {
      await post(`/api/github/pr/${undo.id}/inbox`, { action: "undo", token: undo.token });
      void resource.reload();
    }, `Undo ${undo.label}`);
    setUndo(undefined);
  }

  useEffect(() => {
    /** Keep horizontal author navigation separate from vertical triage and native link actions. */
    function onKeyDown(event: KeyboardEvent) {
      const key = event.key === "S" || event.key === "A" ? event.key.toLowerCase() : event.key;
      if (event.defaultPrevented || event.isComposing || !matchesShortcut(event, [...inboxShortcuts, ...(view === "requested" ? authorShortcuts : [])])) return;
      if (event.composedPath().some((target) => target instanceof HTMLElement && target.closest("input, textarea, select, [contenteditable]")) || document.querySelector('dialog[open], [role="dialog"]:not([popover]), [popover]:popover-open, details[open]')) return;
      if (event.key === "h" || event.key === "l") {
        if (view !== "requested") return;
        event.preventDefault();
        const tabs = authors;
        if (!tabs.length) return;
        const next = tabs[Math.max(0, Math.min(tabs.length - 1, tabs.indexOf(author) + (event.key === "h" ? -1 : 1)))]!;
        navigate(inboxLink(location, mode, next));
        return;
      }
      const links = Array.from(list.current?.querySelectorAll<HTMLAnchorElement>(".card-title") ?? []);
      if (!links.length) return;
      const index = links.findIndex((link) => link.closest(".pr-card")?.contains(document.activeElement));
      const pr = filtered[index];
      if (["s", "a"].includes(key)) {
        if (pr) {
          event.preventDefault();
          if (event.repeat) return;
          if (key === "s") void act(pr, { action: pr.personal.snoozeUntil > Date.now() ? "unsnooze" : "snooze" });
          else act(pr, { action: pr.personal.archived || pr.archivedAt ? "restore" : "archive" });
        }
        return;
      }
      const next = index < 0 ? 0 : Math.max(0, Math.min(links.length - 1, index + (event.key === "j" ? 1 : -1)));
      event.preventDefault();
      links[next]!.focus({ preventScroll: true });
      // The title can be visible while the row's status and actions are still below the viewport.
      links[next]!.closest(".pr-card")?.scrollIntoView({ block: "nearest" });
    }
    // Handle row navigation before native link actions; g sequences belong to the shell.
    return registerShortcuts([...inboxShortcuts, ...(view === "requested" ? authorShortcuts : []),
      { keys: "Enter", description: "Open focused PR" }, { keys: "⇧Enter", description: "Open focused PR in a new tab" },
    ], onKeyDown, true);
  });

  if (location === "/prs" && ["requested", "dependabot"].includes(params.get("view") ?? "")) return <Redirect to={inboxLink("/needs-review", mode, params.get("view") === "dependabot" ? "dependabot" : "")} />;

  return <main className="dashboard">
    <div className="page-heading"><h1>{view === "authored" ? "My PRs" : "Needs Review"}</h1><p className="muted inbox-sync" role="status">{resource.data?.updatedAt ? `Updated ${age(resource.data.updatedAt)}` : "Waiting for the first GitHub snapshot"}{resource.data?.refreshing ? " · Refreshing in background…" : ""}</p></div>
    <div className="dashboard-tools"><input aria-label="Filter PRs" placeholder="Filter by author, repository, title, or number" value={filter} onChange={(event) => setFilter(event.target.value)} onKeyDown={(event) => {
      if (event.key !== "Enter" || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || event.nativeEvent.isComposing) return;
      event.preventDefault();
      const first = list.current?.querySelector<HTMLAnchorElement>(".card-title");
      first?.focus({ preventScroll: true });
      first?.closest(".pr-card")?.scrollIntoView({ block: "nearest" });
    }} /></div>
    <div className="inbox-filters"><nav className="tabs" aria-label="Inbox filters">{filters.map((entry) => <Link key={entry} className={mode === entry ? "active" : ""} href={inboxLink(location, entry, author)}>{entry[0].toUpperCase() + entry.slice(1)} <span className="inbox-count">{matching.filter((pr) => inboxMatches(pr, entry)).length}</span></Link>)}</nav>
      <select aria-label="Repository filter" value={repository} onChange={(event) => void savePreferences(event.target.value)}><option value="">All repositories</option>{[...new Set([...repositories, ...(repository ? [repository] : [])])].map((repo) => <option key={repo}>{repo}</option>)}</select>
    </div>
    {view === "requested" && <nav className="tabs author-tabs" aria-label="Review authors">{authors.map((login) => <Link key={login} className={author === login ? "active" : ""} href={inboxLink(location, mode, login)} title="Number of PRs, youngest to oldest PR age">{login} ({authorStats(matching.filter((pr) => pr.author.login === login && inboxMatches(pr, mode)))}) <UnreadThreadBadge count={matching.filter((pr) => pr.author.login === login && inboxMatches(pr, mode)).reduce((sum, pr) => sum + (pr.unreadThreads ?? 0), 0)} /></Link>)}</nav>}
    <BackgroundSaveStatus scope={inboxSaveScope} />
    {undo && <div key={undo.token} className="inbox-notice" role="status">{undo.label} <button onClick={() => void undoAction()}>Undo</button><button aria-label="Dismiss notification" onClick={() => setUndo(undefined)}>×</button></div>}
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
        {(pr.unreadThreads ?? 0) > 0 && <button className="unread-thread-trigger" onClick={() => setDiscussion({ pr, view: "comments", unreadOnly: true })} aria-label={`${pr.unreadThreads} unread threads on PR ${pr.number}`}><UnreadThreadBadge count={pr.unreadThreads!} /></button>}
        {pr.activity?.checks === "Failing" && <span className="pr-ci-failing" role="img" aria-label="CI failing" title="One or more CI checks failed">×</span>}
      </div>
        <p className="muted">{pr.repository.nameWithOwner} #{pr.number} · {pr.author.login} · {pr.createdAt ? `Opened ${age(Date.parse(pr.createdAt))}` : "Opened date unknown"} · Updated {age(Date.parse(pr.updatedAt))}</p>
        <div className="inbox-badges">{(pr.personal.archived || pr.archivedAt) && <span>Archived</span>}
          {pr.activity && <><span>{reviewLabel(pr.activity)}</span>{pr.activity.checks !== "Failing" && <span>CI: {pr.activity.checks}</span>}</>}
          {pr.activityError && <span title={pr.activityError}>Activity refresh failed</span>}
          {pr.followUpCount > 0 && <Link className="follow-up-active" href={`/pr/${pr.repository.nameWithOwner}/${pr.number}?followUp=first`}>{pr.followUpCount} follow-ups</Link>}
          {pr.personal.snoozeUntil > Date.now() && <span>Snoozed until {new Date(pr.personal.snoozeUntil).toLocaleString()}</span>}
        </div>
      </div>
      <div className="inbox-row-actions"><a href={`/pr/${pr.repository.nameWithOwner}/${pr.number}`} target="_blank" rel="noreferrer" aria-label={`Open PR ${pr.number} in new tab`}>↗</a><details><summary aria-label={`Actions for PR ${pr.number}`}>•••</summary><div className="inbox-menu">
        <button onClick={(event) => { event.currentTarget.closest("details")!.open = false; setDiscussion({ pr, view: "overview", unreadOnly: false }); }}>PR overview</button>
        <button onClick={(event) => { event.currentTarget.closest("details")!.open = false; setDiscussion({ pr, view: "comments", unreadOnly: false }); }}>Review comments</button>
        {pr.personal.snoozeUntil > Date.now() ? <button onClick={() => act(pr, { action: "unsnooze" })}>Unsnooze</button> : <button onClick={() => act(pr, { action: "snooze" })}>Snooze for 1 day</button>}
        <button onClick={() => act(pr, { action: pr.personal.archived || pr.archivedAt ? "restore" : "archive" })}>{pr.personal.archived || pr.archivedAt ? "Restore to inbox" : "Archive"}</button>
      </div></details></div>
    </article>)}</div>
    {resource.data && filtered.length === 0 && <p className="empty-state">{resource.data.refreshing && !resource.data.updatedAt ? "Loading your PRs…" : "No PRs in this view."}</p>}
    {resource.data?.truncated && <p className="muted">GitHub searches return at most 100 PRs. Previously tracked reviews are retained separately.</p>}
    <form className="register-form" onSubmit={(event) => { event.preventDefault(); void openPR(); }}><input aria-label="GitHub PR URL" placeholder="Or paste any GitHub PR URL…" value={prUrl} onChange={(event) => setPrUrl(event.target.value)} />{path && <button type="submit" disabled={Boolean(busy)}>Open PR</button>}</form>
    {discussion && <InboxDiscussion key={discussion.pr.id} pr={discussion.pr} view={discussion.view} unreadOnly={discussion.unreadOnly} onClose={() => { setDiscussion(undefined); void resource.reload(); }} />}
  </main>;
}

/** Preserve the other tab selection when changing status or author. */
function inboxLink(path: string, mode: InboxFilter, author: string): string {
  const params = new URLSearchParams();
  // An explicit Todo selection must override a remembered filter on the next visit.
  params.set("filter", mode);
  if (author) params.set("author", author);
  return `${path}${params.size ? `?${params}` : ""}`;
}

/** Treat missing, disabled, or obsolete browser storage as the default inbox selection. */
function readInboxSelection(view: string): { mode: InboxFilter; author: string; search: string } {
  try {
    const value = JSON.parse(localStorage.getItem(`biff:inbox-selection:${view}`) ?? "null");
    return {
      mode: filters.includes(value?.mode) ? value.mode : "todo",
      author: typeof value?.author === "string" ? value.author : "",
      search: typeof value?.search === "string" ? value.search : "",
    };
  } catch { return { mode: "todo", author: "", search: "" }; }
}

/** Older snapshots use activity dates until GitHub supplies creation dates on refresh. */
function authorStats(items: InboxPR[]): string {
  if (!items.length) return "0";
  const dates = items.map((pr) => Date.parse(pr.createdAt ?? pr.updatedAt));
  return `${items.length} ${age(Math.max(...dates)).replace(" ago", "").replace("just now", "0m")} - ${age(Math.min(...dates)).replace(" ago", "").replace("just now", "0m")}`;
}

/** Describe the acknowledged personal action in the Undo notice. */
function actionLabel(action: InboxAction) {
  const labels: Record<string, string> = { archive: "PR archived", restore: "PR restored", snooze: "PR snoozed for 1 day", unsnooze: "PR unsnoozed" };
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
