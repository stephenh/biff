import { Component, type CSSProperties, type ErrorInfo, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { Link, Redirect, Route, Switch, useLocation, useSearch } from "wouter";
import { WorkingCopies, PullRequests } from "./Dashboards";
import { WorkingCopyReview, PullRequestReview } from "./Reviews";
import { CollapseDeletedContext, ReadingTypographyContext, Settings, useReadingSettings } from "./Settings";
import { PageShortcuts } from "./shortcuts";
import { WorkspaceCollaboration } from "./WorkspaceCollaboration";
import { useNavigationShortcuts } from "./useNavigationShortcuts";
import { ActivityIndicator } from "./ActivityIndicator";
import { pullRequestRoute, workspaceRoute } from "./fileRoute";
import "./style.css";

/** A plain SPA shell: every review has a normal URL and browser history. */
function App() {
  useNavigationShortcuts();
  const reading = useReadingSettings();
  const [location] = useLocation();
  const style = { "--biff-code-font": `'${reading.settings.font}', monospace`, "--biff-code-size": `${reading.settings.size}px`, "--biff-code-line-height": `${Math.round(reading.settings.size * 1.6)}px` } as CSSProperties;

  return <div className="shell" style={style}>
    <header className="shell-header"><Link className="brand" href="/workspaces">biff<span>big diff. easy eyes.</span></Link><nav className="shell-nav" aria-label="Main navigation"><PageShortcuts /><Link href="/prs" aria-current={location === "/prs" ? "page" : undefined}>My PRs</Link><Link href="/needs-review" aria-current={location === "/needs-review" ? "page" : undefined}>Needs Review</Link><Link href="/workspaces" aria-current={location.startsWith("/workspaces") ? "page" : undefined}>Working Copies</Link><Settings {...reading} /><ActivityIndicator global /></nav></header>
    <ReadingTypographyContext value={reading.settings}><CollapseDeletedContext value={reading.settings.collapseDeleted}><ErrorBoundary><Switch>
      <Route path="/"><Redirect to="/workspaces" /></Route>
      <Route path="/workspaces"><WorkingCopies /></Route>
      <Route path={workspaceRoute}>{(params) => <WorkspaceRoute key={params.id} id={params.id!} />}</Route>
      <Route path="/prs"><PullRequests /></Route>
      <Route path="/needs-review"><PullRequests /></Route>
      <Route path={pullRequestRoute}>{(params) => <PullRequestReview key={`${params.owner}/${params.repo}/${params.number}`} owner={params.owner!} repo={params.repo!} number={params.number!} />}</Route>
      <Route><div className="empty-state"><h1>Page not found</h1><Link href="/workspaces">Working Copies</Link></div></Route>
    </Switch></ErrorBoundary></CollapseDeletedContext></ReadingTypographyContext>
  </div>;
}

/** Keep malformed upstream patches from taking down navigation to other reviews. */
class ErrorBoundary extends Component<{ children: ReactNode }, { error?: string }> {
  state: { error?: string } = {};
  static getDerivedStateFromError(error: Error) { return { error: error.message }; }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error(error, info.componentStack); }
  render() {
    return this.state.error ? <div className="empty-state" role="alert"><h2>Could not render this review</h2><p>{this.state.error}</p><a href="/workspaces">Return to working copies</a></div> : this.props.children;
  }
}

/** Collaboration attaches to the workspace URL rather than owning a separate viewing mode. */
function WorkspaceRoute(props: { id: string }) {
  const review = new URLSearchParams(useSearch()).get("review");
  return review ? <WorkspaceCollaboration key={review} id={review} workspaceId={props.id} /> : <WorkingCopyReview id={props.id} />;
}

createRoot(document.getElementById("root")!).render(<App />);
