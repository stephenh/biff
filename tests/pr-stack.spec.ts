import { chromium, expect, test, type Browser, type Page } from "@playwright/test";
import { stackPosition, type StackPullRequest } from "../server/prStack";

const pulls = [
  { number: 11, title: "Add the storage layer" },
  { number: 22, title: "Expose the review API" },
  { number: 33, title: "Build the review interface" },
];
const linearPulls = [stackPull(pulls[0], "main", "first"), stackPull(pulls[1], "first", "second"), stackPull(pulls[2], "second", "third")];
const forkedPulls = [...linearPulls, stackPull({ number: 44, title: "Add a second interface" }, "second", "fourth")];

test.describe("PR stack navigation", () => {
  let browser: Browser;
  let page: Page;
  let forked: boolean;
  test.beforeAll(async () => { browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium" }); });
  test.afterAll(async () => { await browser.close(); });
  test.afterEach(async () => { await page.close(); });
  test.beforeEach(async () => {
    forked = false;
    page = await browser.newPage({ baseURL: "http://127.0.0.1:5173" });
    await page.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      const number = Number(path.split("/")[6]);
      const entries = forked ? forkedPulls : linearPulls;
      if (path.endsWith("/stack")) return route.fulfill({ json: stackPosition(entries, number) });
      if (path.endsWith("/review")) return route.fulfill({ json: {
        pr: { ...entries.find((pr) => pr.number === number), user: { login: "me" }, head: { sha: "a".repeat(40), ref: "feature" }, base: { sha: "b".repeat(40), ref: "main" } },
        commit: "all", commits: [], patch: "",
      } });
      if (path.endsWith("/conversation")) return route.fulfill({ json: { viewer: "me", comments: [], reviews: [], inline: [] } });
      if (path.endsWith("/review-draft")) return route.fulfill({ json: { commitId: "a".repeat(40), body: "", comments: [], version: 0 } });
      if (path.endsWith("/discussion")) return route.fulfill({ json: { threads: [], version: 0 } });
      if (path.endsWith("/identity")) return route.fulfill({ json: null });
      return route.fulfill({ json: [] });
    });
  });

  test("one click reveals every PR title", async () => {
    // Given the middle PR in a three-PR stack
    await page.goto("/pr/example/repo/22");

    // When the stack control is clicked once
    await page.getByRole("button", { name: "Stack: PR 2 of 3", exact: true }).click();

    // Then the entire stack is readable without opening a second control
    await expect(page.locator(".pr-stack-list .pr-stack-title")).toHaveText(pulls.map((pr) => pr.title));
  });

  test("the current PR is identified and focused", async () => {
    // Given the middle PR
    await page.goto("/pr/example/repo/22");

    // When its stack is opened
    await page.getByRole("button", { name: "Stack: PR 2 of 3", exact: true }).click();

    // Then focus starts on the highlighted current PR
    await expect(page.locator('.pr-stack-list a[aria-current="page"]')).toBeFocused();
  });

  test("a PR in the list opens directly", async () => {
    // Given the stack list
    await page.goto("/pr/example/repo/22");
    await page.getByRole("button", { name: "Stack: PR 2 of 3", exact: true }).click();

    // When another PR title is clicked
    await page.getByRole("link", { name: "1 Add the storage layer #11", exact: true }).click();

    // Then that PR is opened
    await expect(page).toHaveURL("/pr/example/repo/11");
  });

  test("next navigates without opening the list", async () => {
    // Given the middle PR
    await page.goto("/pr/example/repo/22");

    // When the next arrow is clicked
    await page.getByRole("link", { name: "Next PR in stack", exact: true }).click();

    // Then the next PR is opened
    await expect(page).toHaveURL("/pr/example/repo/33");
  });

  test("previous navigates without opening the list", async () => {
    // Given the middle PR
    await page.goto("/pr/example/repo/22");

    // When the previous arrow is clicked
    await page.getByRole("link", { name: "Previous PR in stack", exact: true }).click();

    // Then the preceding PR is opened
    await expect(page).toHaveURL("/pr/example/repo/11");
  });

  test("the base PR has no previous action", async () => {
    // Given the base of the stack
    await page.goto("/pr/example/repo/11");

    // When its stack navigation loads
    await page.getByRole("navigation", { name: "PR stack", exact: true }).waitFor();

    // Then the previous arrow is disabled
    await expect(page.getByRole("button", { name: "Previous PR in stack", exact: true })).toBeDisabled();
  });

  test("the top PR has no next action", async () => {
    // Given the top of the stack
    await page.goto("/pr/example/repo/33");

    // When its stack navigation loads
    await page.getByRole("navigation", { name: "PR stack", exact: true }).waitFor();

    // Then the next arrow is disabled
    await expect(page.getByRole("button", { name: "Next PR in stack", exact: true })).toBeDisabled();
  });

  test("Escape returns focus to the stack control", async () => {
    // Given the open stack list
    await page.goto("/pr/example/repo/22");
    const trigger = page.getByRole("button", { name: "Stack: PR 2 of 3", exact: true });
    await trigger.click();
    await expect(page.locator('.pr-stack-list a[aria-current="page"]')).toBeFocused();

    // When the list is dismissed
    await page.keyboard.press("Escape");

    // Then keyboard navigation resumes at its trigger
    await expect(trigger).toBeFocused();
  });

  test("arrow keys and Enter open a neighboring PR", async () => {
    // Given keyboard focus on the current PR in the list
    await page.goto("/pr/example/repo/22");
    await page.getByRole("button", { name: "Stack: PR 2 of 3", exact: true }).click();
    await expect(page.locator('.pr-stack-list a[aria-current="page"]')).toBeFocused();

    // When the reader moves down and activates the next link
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");

    // Then the next PR opens
    await expect(page).toHaveURL("/pr/example/repo/33");
  });

  test("an outside click dismisses the list", async () => {
    // Given an open stack list
    await page.goto("/pr/example/repo/22");
    await page.getByRole("button", { name: "Stack: PR 2 of 3", exact: true }).click();

    // When the reader clicks outside
    await page.getByRole("heading", { name: "No changes", exact: true }).click();

    // Then the popover is dismissed
    await expect(page.getByRole("dialog", { name: "PR stack · 3 PRs", exact: true })).toBeHidden();
  });

  test("the stack list fits a narrow viewport", async () => {
    // Given a PR viewed on a narrow screen
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/pr/example/repo/22");

    // When the stack list opens beside its trigger
    await page.getByRole("button", { name: "Stack: PR 2 of 3", exact: true }).click();

    // Then the complete chooser remains inside the viewport
    await expect(page.getByRole("dialog", { name: "PR stack · 3 PRs", exact: true })).toBeInViewport({ ratio: 1 });
  });

  test("a pre-fork file deep link shows only the shared linear chain", async () => {
    // Given a stack that splits above the current PR
    forked = true;
    await page.goto("/pr/example/repo/11/f/graphql-codegen-joist.mjs");

    // When its stack selector is opened
    await page.getByRole("button", { name: "Stack: PR 1 of 2", exact: true }).click();

    // Then child stacks are not shown in the pre-fork PR
    await expect(page.locator(".pr-stack-list .pr-stack-title")).toHaveText(["Add the storage layer", "Expose the review API"]);
  });

  test("the shared chain ends where child stacks split", async () => {
    // Given the PR where the stack splits
    forked = true;
    await page.goto("/pr/example/repo/22");

    // When its stack navigation loads
    await page.getByRole("button", { name: "Stack: PR 2 of 2", exact: true }).waitFor();

    // Then neither child stack is offered as the next PR
    await expect(page.getByRole("button", { name: "Next PR in stack", exact: true })).toBeDisabled();
  });

  test("previous from a branch tip opens its parent, not a sibling", async () => {
    // Given the second tip of a branching stack
    forked = true;
    await page.goto("/pr/example/repo/44");

    // When the previous arrow is clicked
    await page.getByRole("link", { name: "Previous PR in stack", exact: true }).click();

    // Then navigation follows the dependency instead of a sibling stack
    await expect(page).toHaveURL("/pr/example/repo/22");
  });

  test("a branch tip does not offer its sibling as the next PR", async () => {
    // Given the first tip of a branching stack
    forked = true;
    await page.goto("/pr/example/repo/33");

    // When its stack navigation loads
    await page.getByRole("navigation", { name: "PR stack", exact: true }).waitFor();

    // Then a sibling is not presented as a descendant
    await expect(page.getByRole("button", { name: "Next PR in stack", exact: true })).toBeDisabled();
  });

  test("an unambiguous next PR remains one click away in a branching stack", async () => {
    // Given a PR below the fork
    forked = true;
    await page.goto("/pr/example/repo/11");

    // When its next arrow is clicked
    await page.getByRole("link", { name: "Next PR in stack", exact: true }).click();

    // Then the unique child opens directly
    await expect(page).toHaveURL("/pr/example/repo/22");
  });

  test("a child stack includes shared ancestors but not its sibling", async () => {
    // Given the second child stack after a split
    forked = true;
    await page.goto("/pr/example/repo/44");

    // When its linear stack is opened
    await page.getByRole("button", { name: "Stack: PR 3 of 3", exact: true }).click();

    // Then the path includes only this child and the shared ancestors
    await expect(page.locator(".pr-stack-list .pr-stack-title")).toHaveText(["Add the storage layer", "Expose the review API", "Add a second interface"]);
  });

  test("child stack rows remain flat", async () => {
    // Given a PR after a split
    forked = true;
    await page.goto("/pr/example/repo/44");

    // When its stack is opened
    await page.getByRole("button", { name: "Stack: PR 3 of 3", exact: true }).click();

    // Then the child has the same standard row padding as a linear stack
    await expect(page.locator('.pr-stack-list a[aria-current="page"]')).toHaveCSS("padding-inline-start", "10px");
  });
});

/** Model base/head links so forked-stack browser tests use the actual inference rules. */
function stackPull(pr: { number: number; title: string }, base: string, head: string): StackPullRequest {
  return { ...pr, base: { ref: base, repo: { full_name: "example/repo" } }, head: { ref: head, repo: { full_name: "example/repo" } } };
}
