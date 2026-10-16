export interface MentionToken { start: number; end: number; query: string }

/** Find a GitHub username token at the caret without treating email addresses as mentions. */
export function mentionAtCaret(value: string, start: number, end: number): MentionToken | undefined {
  if (start !== end) return;
  const match = value.slice(0, start).match(/(?:^|[\s([{])@([a-z\d-]{0,39})$/i);
  if (!match) return;
  const query = match[1];
  const suffix = value.slice(start).match(/^[a-z\d-]*/i)![0];
  return { start: start - query.length - 1, end: start + suffix.length, query };
}

/** Replace just the active username, retaining text on either side of the caret. */
export function completeMention(value: string, token: MentionToken, login: string): { value: string; caret: number } {
  const suffix = value.slice(token.end);
  const space = !suffix || !/^[\s.,!?;:)\]}]/.test(suffix) ? " " : "";
  const prefix = `${value.slice(0, token.start)}@${login}${space}`;
  return { value: prefix + suffix, caret: prefix.length + (suffix.startsWith(" ") ? 1 : 0) };
}
