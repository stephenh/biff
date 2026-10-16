import { Component, type CSSProperties, type ErrorInfo, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { Link, Redirect, Route, Switch } from "wouter";
import { WorkingCopies, PullRequests } from "./Dashboards";
import { WorkingCopyReview, PullRequestReview } from "./Reviews";
import { CollapseDeletedContext, Settings, useReadingSettings } from "./Settings";
import { KeyboardHelp } from "./KeyboardHelp";
import { AgentReview } from "./AgentReview";
import "./style.css";

/** A plain SPA shell: every review has a normal URL and browser history. */
function App() {
  const reading = useReadingSettings();
  const style = { "--biff-code-font": `'${reading.settings.font}', monospace`, "--biff-code-size": `${reading.settings.size}px`, "--biff-code-line-height": `${Math.round(reading.settings.size * 1.6)}px` } as CSSProperties;

  return <div className="shell" style={style}>
    <header className="shell-header"><Link className="brand" href="/workspaces">biff<span>big diff. easy eyes.</span></Link><nav className="shell-nav"><Link href="/workspaces">Working Copies</Link><Link href="/prs">PRs</Link><Settings {...reading} /><KeyboardHelp /></nav></header>
    <CollapseDeletedContext value={reading.settings.collapseDeleted}><ErrorBoundary><Switch>
      <Route path="/"><Redirect to="/workspaces" /></Route>
      <Route path="/workspaces"><WorkingCopies /></Route>
      <Route path="/reviews/:id">{(params) => <AgentReview key={params.id} id={params.id} />}</Route>
      <Route path="/workspaces/:id">{(params) => <WorkingCopyReview key={params.id} id={params.id} />}</Route>
      <Route path="/prs"><PullRequests /></Route>
      <Route path="/pr/:owner/:repo/:number">{(params) => <PullRequestReview key={`${params.owner}/${params.repo}/${params.number}`} owner={params.owner} repo={params.repo} number={params.number} />}</Route>
      <Route><div className="empty-state"><h1>Page not found</h1><Link href="/workspaces">Working Copies</Link></div></Route>
    </Switch></ErrorBoundary></CollapseDeletedContext>
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

createRoot(document.getElementById("root")!).render(<App />);
