import { describe, expect, test } from "bun:test";
import { GitHub } from "../server/github";
import { createApi } from "../server/api";
import { Storage } from "../server/storage";
import { Workspaces } from "../server/workspaces";

describe("failedChecks", () => {
  test("failed check runs retain provider job links and omit passing or pending runs", async () => {
    // Given a head with failed, timed-out, passing, and pending jobs
    const github = checksFixture([checksPage([
      { __typename: "CheckRun", name: "CircleCI / tests", conclusion: "FAILURE", detailsUrl: "https://app.circleci.com/pipelines/github/example/repo/42/workflows/workflow/jobs/123", url: "https://github.com/example/repo/runs/123" },
      { __typename: "CheckRun", name: "Lint", conclusion: "SUCCESS", detailsUrl: "https://ci.example/lint" },
      { __typename: "CheckRun", name: "Deploy", conclusion: null, detailsUrl: "https://ci.example/deploy" },
      { __typename: "CheckRun", name: "Integration", conclusion: "TIMED_OUT", detailsUrl: "https://ci.example/integration" },
      null,
    ])]);

    // When the failed checks are requested
    const checks = await github.failedChecks("example/repo", "12");

    // Then only failed jobs are linked directly to their provider's details
    expect(checks).toEqual([
      { name: "CircleCI / tests", url: "https://app.circleci.com/pipelines/github/example/repo/42/workflows/workflow/jobs/123" },
      { name: "Integration", url: "https://ci.example/integration" },
    ]);
  });

  test("legacy failures on later pages are included", async () => {
    // Given legacy commit statuses on multiple GitHub pages
    const github = checksFixture([
      checksPage([{ __typename: "StatusContext", context: "ci/build", state: "SUCCESS", targetUrl: "https://ci.example/build" }]),
      checksPage([
        { __typename: "StatusContext", context: "ci/tests", state: "FAILURE", targetUrl: "https://ci.example/tests/failed-step" },
        { __typename: "StatusContext", context: "ci/lint", state: "ERROR", targetUrl: "https://ci.example/lint" },
      ]),
    ]);

    // When the failures are requested
    const checks = await github.failedChecks("example/repo", "12");

    // Then every failed legacy status keeps its details link
    expect(checks).toEqual([{ name: "ci/tests", url: "https://ci.example/tests/failed-step" }, { name: "ci/lint", url: "https://ci.example/lint" }]);
  });

  test("a check without a provider URL links to its GitHub result", async () => {
    // Given a failed GitHub check without an external details URL
    const github = checksFixture([checksPage([{ __typename: "CheckRun", name: "Tests", conclusion: "FAILURE", detailsUrl: null, url: "https://github.com/example/repo/runs/123" }])]);

    // When failures are requested
    const checks = await github.failedChecks("example/repo", "12");

    // Then the check remains actionable through GitHub
    expect(checks).toEqual([{ name: "Tests", url: "https://github.com/example/repo/runs/123" }]);
  });

  test("unsafe provider links fall back to the PR checks page", async () => {
    // Given an untrusted status URL supplied by an external provider
    const github = checksFixture([checksPage([{ __typename: "StatusContext", context: "ci/tests", state: "FAILURE", targetUrl: "javascript:alert(1)" }])]);

    // When failures are requested
    const checks = await github.failedChecks("example/repo", "12");

    // Then the browser receives a safe check destination
    expect(checks).toEqual([{ name: "ci/tests", url: "https://github.com/example/repo/pull/12/checks" }]);
  });

  test("partial GitHub errors do not present an incomplete failure list", async () => {
    // Given a later page failed to load
    const github = checksFixture([checksPage([]), { errors: [{ message: "Checks unavailable" }] }]);

    // When failures are requested
    const result = github.failedChecks("example/repo", "12");

    // Then the UI can offer retry instead of claiming there are no failures
    await expect(result).rejects.toThrow("Checks unavailable");
  });

  test("the API exposes failure links without reading the diff", async () => {
    // Given only a CI lookup fixture
    const github = checksFixture([checksPage([{ __typename: "StatusContext", context: "ci/tests", state: "FAILURE", targetUrl: "https://ci.example/tests" }])]);
    const storage = new Storage();
    const api = createApi({ github, workspaces: new Workspaces(storage) });

    // When the failure chooser opens
    const response = await api(new Request("http://localhost/api/github/pr/example/repo/12/failed-checks"));
    await storage.close();

    // Then it receives actionable check details
    expect(await response.json()).toEqual([{ name: "ci/tests", url: "https://ci.example/tests" }]);
  });
});

/** Model paginated GraphQL responses at the gh boundary without live CI reads. */
function checksFixture(pages: unknown[]) {
  return new GitHub(async (args) => {
    if (args[2] !== "graphql" || !args.includes("--paginate") || !args.includes("--slurp")) throw new Error("Expected a paginated check lookup");
    return JSON.stringify(pages);
  });
}

/** Wrap one page of GitHub check-run and legacy status contexts. */
function checksPage(contexts: unknown[]) {
  return { data: { repository: { pullRequest: { commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: contexts } } } }] } } } } };
}
