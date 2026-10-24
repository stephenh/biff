import { describe, expect, test } from "bun:test";
import { githubAttachment } from "../server/githubAttachment";

const id = "e056a94d-514e-4fe6-af87-25c2d09a1ca0";

describe("githubAttachment", () => {
  test("private screenshots use gh authentication only at GitHub and return image bytes", async () => {
    // Given GitHub redirects an authenticated request to a signed asset URL
    const requests: { url: string; authorization: string | null }[] = [];
    async function request(url: string | URL | Request, options?: RequestInit) {
      requests.push({ url: String(url), authorization: new Headers(options?.headers).get("Authorization") });
      return requests.length === 1
        ? new Response(null, { status: 302, headers: { location: "https://github-production-user-asset.s3.amazonaws.com/screenshot.png?signature=fixture" } })
        : new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "content-type": "image/png" } });
    }

    // When Biff loads the attachment
    const response = await githubAttachment(id, async () => "fixture-token\n", request);

    // Then image bytes reach the browser without exposing credentials to the asset host
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([137, 80, 78, 71]));
    expect(response.headers.get("content-type")).toEqual("image/png");
    expect(requests).toEqual([
      { url: `https://github.com/user-attachments/assets/${id}`, authorization: "Bearer fixture-token" },
      { url: "https://github-production-user-asset.s3.amazonaws.com/screenshot.png?signature=fixture", authorization: null },
    ]);
  });

  test("attachment paths cannot select arbitrary authenticated URLs", async () => {
    // Given an untrusted URL in place of an attachment ID
    // When it reaches the attachment loader
    const result = githubAttachment("https://example.com", async () => { throw new Error("Must not request credentials"); });

    // Then validation rejects it before credential lookup
    await expect(result).rejects.toThrow("Invalid GitHub attachment");
  });

  test("HTML responses are not served from Biff's origin", async () => {
    // Given GitHub returns a non-image response
    async function request() { return new Response("<html>Sign in</html>", { headers: { "content-type": "text/html" } }); }

    // When Biff loads it as a screenshot
    const result = githubAttachment(id, async () => "fixture-token", request);

    // Then the response is rejected
    await expect(result).rejects.toThrow("Unsupported screenshot format");
  });
});
