import { describe, expect, test } from "bun:test";
import { Storage } from "../server/storage";
import { Progress } from "../server/progress";
import { identifyChanges } from "../src/changeProgress";
import { parseInput } from "../src/patches";
import { createApi } from "../server/api";
import { GitHub } from "../server/github";
import { Workspaces } from "../server/workspaces";

const patch = "diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-before();\n+after();\n";

describe("followUps", () => {
  test("the API durably flags and completes a hunk together", async () => {
    // Given a PR hunk and the real persistence API
    const storage = new Storage();
    try {
      const progress = new Progress(storage);
      const api = createApi({ github: new GitHub(undefined, storage), workspaces: new Workspaces(storage), progress });
      const [block] = await identifyChanges(parseInput(patch));
      // When the user flags the hunk
      const response = await api(new Request("http://localhost/api/github/pr/example/project/12/follow-ups", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...block, type: "hunk", head: "a".repeat(40), enabled: true }) }));
      if (!response.ok) throw new Error(await response.text());
      // Then both personal state and reviewed progress are durable
      expect(new Progress(storage).followUps("example/project/12")).toMatchObject([{ type: "hunk", hash: block.hash }]);
      expect(await progress.get("example/project/12")).toMatchObject([{ hash: block.hash, head: "a".repeat(40) }]);
    } finally { await storage.close(); }
  });

  test("clearing a follow-up preserves hunk completion", async () => {
    // Given a flagged and reviewed hunk
    const storage = new Storage();
    try {
      const progress = new Progress(storage);
      const [block] = await identifyChanges(parseInput(patch));
      await progress.followUpHunk("example/project/12", block, "head", true);
      // When the flag is cleared
      await progress.followUpHunk("example/project/12", block, "head", false);
      // Then completion remains but the follow-up is gone
      expect(progress.followUps("example/project/12")).toEqual([]);
      expect(await progress.get("example/project/12")).toMatchObject([{ hash: block.hash }]);
    } finally { await storage.close(); }
  });

  test("reconciliation retains moved exact edits", async () => {
    // Given a flagged hunk
    const storage = new Storage();
    try {
      const progress = new Progress(storage);
      const [block] = await identifyChanges(parseInput(patch));
      await progress.followUpHunk("example/project/12", block, "old", true);
      // When unrelated edits shift its coordinates
      await progress.reconcileFollowUps("example/project/12", patch.replace("-1 +1", "-20 +20"), "new", "pr");
      // Then the flag follows its exact content
      expect(progress.followUps("example/project/12")).toMatchObject([{ hash: block.hash }]);
    } finally { await storage.close(); }
  });

  test("a complete new diff drops a changed hunk", async () => {
    // Given a flagged hunk
    const storage = new Storage();
    try {
      const progress = new Progress(storage);
      const [block] = await identifyChanges(parseInput(patch));
      await progress.followUpHunk("example/project/12", block, "old", true);
      // When the new complete diff replaces the edit
      await progress.reconcileFollowUps("example/project/12", patch.replace("after();", "different();"), "new", "pr");
      // Then the obsolete flag is gone
      expect(progress.followUps("example/project/12")).toEqual([]);
    } finally { await storage.close(); }
  });

  test("a remote diff preserves unpublished local hunks", async () => {
    // Given a local flag sharing a review lifetime
    const storage = new Storage();
    try {
      const progress = new Progress(storage);
      const identity = await progress.identity("example/project/12");
      storage.db.query("INSERT INTO review_aliases VALUES (?, ?)").run("jj/workspace/local", identity.id);
      const [block] = await identifyChanges(parseInput(patch));
      await progress.followUpHunk("jj/workspace/local", block, "unpublished", true);
      // When the older remote diff is reconciled
      await progress.reconcileFollowUps("example/project/12", "", "remote", "pr", ["remote"]);
      // Then unpublished work stays flagged
      expect(progress.followUps("example/project/12")).toMatchObject([{ hash: block.hash, source: "local" }]);
    } finally { await storage.close(); }
  });

  test("deleted GitHub threads lose their personal flags", async () => {
    // Given two flagged threads
    const storage = new Storage();
    try {
      const progress = new Progress(storage);
      const location = { path: "file.ts", line: 1, side: "RIGHT" as const };
      await progress.followUpThread("example/project/12", { type: "thread", id: "github:1", location, label: "first" }, true);
      await progress.followUpThread("example/project/12", { type: "thread", id: "github:2", location, label: "second" }, true);
      // When a complete conversation contains only the second thread
      await progress.reconcileFollowUpThreads("example/project/12", [2]);
      // Then only the surviving thread stays flagged
      expect(progress.followUps("example/project/12")).toMatchObject([{ id: "github:2" }]);
    } finally { await storage.close(); }
  });

  test("a flag added during a diff fetch survives its older snapshot", async () => {
    // Given the candidates captured before a remote fetch
    const storage = new Storage();
    try {
      const progress = new Progress(storage);
      const [block] = await identifyChanges(parseInput(patch));
      await progress.followUpHunk("example/project/12", block, "old", true);
      const candidates = progress.followUps("example/project/12");
      // And a reader flags a newer version while that fetch is pending
      await progress.followUpHunk("example/project/12", block, "newer", true);
      // When the older complete diff arrives
      await progress.reconcileFollowUps("example/project/12", "", "old", "pr", [], candidates);
      // Then the newer flag is retained
      expect(progress.followUps("example/project/12")).toMatchObject([{ head: "newer" }]);
    } finally { await storage.close(); }
  });
});
