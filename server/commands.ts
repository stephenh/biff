export interface CommandOptions { cwd?: string; input?: string }
export type RunCommand = (args: string[], options?: CommandOptions) => Promise<string>;

/** Run argv directly, keeping shell interpretation and authentication out of the SPA. */
export async function runCommand(args: string[], options: CommandOptions = {}): Promise<string> {
  const child = Bun.spawn(args, {
    cwd: options.cwd,
    env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_PAGER: "cat", NO_COLOR: "1" },
    stdin: options.input === undefined ? "ignore" : new Blob([options.input]),
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, 60000);
  try {
    const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (timedOut) throw new Error(`${args[0]} timed out after 60 seconds`);
    if (code !== 0) throw new Error(error.trim() || `${args[0]} exited with code ${code}`);
    return output;
  } finally {
    clearTimeout(timer);
  }
}
