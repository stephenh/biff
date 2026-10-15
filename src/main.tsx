import { Component, type ErrorInfo, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { Link, Redirect, Route, Switch } from "wouter";
import { WorkingCopies, PullRequests } from "./Dashboards";
import { WorkingCopyReview, PullRequestReview } from "./Reviews";
import { Viewer } from "./Viewer";
import patch2 from "../fixtures/graphql-service-9658.diff?raw";
import "./style.css";

/** A plain SPA shell: every review has a normal URL and browser history. */
function App() {
  return <div className="shell">
    <header className="shell-header"><Link className="brand" href="/workspaces">biff<span>big diff. easy eyes.</span></Link><nav className="shell-nav"><Link href="/workspaces">Working Copies</Link><Link href="/prs">PRs</Link><Link href="/examples/patch1">patch1</Link><Link href="/examples/patch2">patch2</Link></nav></header>
    <ErrorBoundary><Switch>
      <Route path="/"><Redirect to="/workspaces" /></Route>
      <Route path="/workspaces"><WorkingCopies /></Route>
      <Route path="/workspaces/:id">{(params) => <WorkingCopyReview key={params.id} id={params.id} />}</Route>
      <Route path="/prs"><PullRequests /></Route>
      <Route path="/pr/:owner/:repo/:number">{(params) => <PullRequestReview key={`${params.owner}/${params.repo}/${params.number}`} owner={params.owner} repo={params.repo} number={params.number} />}</Route>
      <Route path="/examples/patch1"><Viewer key="patch1" /></Route>
      <Route path="/examples/patch2"><Viewer key="patch2" patch={patch2} source="patch2 · graphql-service #9658" /></Route>
      <Route><div className="empty-state"><h1>Page not found</h1><Link href="/workspaces">Working Copies</Link></div></Route>
    </Switch></ErrorBoundary>
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
