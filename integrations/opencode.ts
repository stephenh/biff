import { Plugin } from "@opencode/plugin";
import { resolve } from "node:path";
import { runCommand } from "../server/commands";
import type { ReviewSession } from "../shared/localReview";
import { forwardReview } from "./feedback";

/** Route posted comments to the originating conversation, including while it is busy. */
export default Plugin.define({
  id: "biff",
  async setup(ctx) {
    const origin = `http://127.0.0.1:${process.env.BIFF_PORT || 4567}`;
    const stop = new AbortController();
    const watching = new Set<string>();
    const cli = resolve(import.meta.dir, "../bin/biff.ts");
    let workspace: string | undefined;

    await ctx.command.transform((editor) => {
      editor.add({
        name: "biff",
        description: "Open a live Biff review and receive inline feedback",
        async execute(input) {
          const session = await ctx.session.get({ sessionID: input.sessionID });
          const output = await runCommand(["bun", cli, "review", "start", "--session", `opencode:${input.sessionID}`], { cwd: session.location.directory });
          const review: ReviewSession = JSON.parse(output);
          await ctx.session.prompt({ ...input.prompt, sessionID: input.sessionID, delivery: input.delivery, text: `Biff review ${review.id} is open at ${origin}/workspaces/${review.snapshot.workspace.id}?review=${review.id}. Load the biff skill. Push delivery is active: do not run a wait loop or acknowledge feedback yourself. Posted feedback will arrive here automatically. Use biff review reply/refresh to respond in the UI.\n\n${input.prompt.text}` });
          watch(review);
        },
      });
    });

    // The review JSON holds both the association and delivery cursor; no plugin database.
    const timer = setInterval(() => void restore(), 10_000);
    void restore();
    return () => { clearInterval(timer); stop.abort(); };

    /** Reconnect to active reviews after a daemon or plugin restart. */
    async function restore() {
      try {
        // Sessions can start in a nested directory; Biff stores the canonical JJ root.
        workspace ??= (await runCommand(["jj", "root", "--no-pager"], { cwd: ctx.location.directory })).trim();
        const reviews = await api<ReviewSession[]>(`?workspace=${encodeURIComponent(workspace)}`);
        for (const review of reviews) watch(review);
      } catch (error) {
        // Biff need not be running until the first /biff invocation.
        if (!stop.signal.aborted && !(error instanceof TypeError)) console.error("Biff reconnect:", error);
      }
    }

    /** Each review has one local subscriber; stable prompt IDs also deduplicate host reloads. */
    function watch(review: ReviewSession) {
      if (watching.has(review.id) || !review.agentSession.startsWith("opencode:") || stop.signal.aborted) return;
      watching.add(review.id);
      void forwardReview({
        review, signal: stop.signal,
        read: () => api<ReviewSession>(`/${review.id}/wait`),
        acknowledge: (sequence) => api(`/${review.id}/ack`, { sequence }),
        deliver: (prompt) => ctx.session.prompt(prompt),
      }).catch((error: unknown) => {
        if (!stop.signal.aborted) console.error("Biff feedback delivery:", error);
      }).finally(() => watching.delete(review.id));
    }

    /** Stop outstanding long polls when OpenCode unloads this plugin. */
    async function api<T>(path: string, body?: unknown): Promise<T> {
      const response = await fetch(`${origin}/api/reviews${path}`, { signal: stop.signal, ...(body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Biff request failed");
      return result;
    }
  },
});
