import { describe, expect, test } from "bun:test";
import { completeMention, mentionAtCaret } from "../src/mentions";

describe("mentions", () => {
  test("a mention at the caret exposes the repository-user search prefix", () => {
    // Given an unfinished mention in a sentence
    const value = "Please ask @pat";

    // When its caret is at the end
    const token = mentionAtCaret(value, value.length, value.length);

    // Then only that username becomes the completion token
    expect(token).toEqual({ start: 11, end: 15, query: "pat" });
  });

  test("an email address does not trigger user suggestions", () => {
    // Given an email address in a comment
    const value = "Contact person@example";

    // When the caret is at its end
    const token = mentionAtCaret(value, value.length, value.length);

    // Then it is not interpreted as a GitHub mention
    expect(token).toBeUndefined();
  });

  test("completing inside a username preserves the surrounding sentence", () => {
    // Given the caret after @pa in an existing mention
    const value = "Ask @patterson about this.";
    const token = mentionAtCaret(value, 7, 7)!;

    // When a repository user is chosen
    const result = completeMention(value, token, "pat-hb");

    // Then the full old username is replaced and typing resumes after its space
    expect(result).toEqual({ value: "Ask @pat-hb about this.", caret: 12 });
  });

  test("completing an empty @ adds a space for continued typing", () => {
    // Given an empty mention at the end of a comment
    const value = "Thanks @";
    const token = mentionAtCaret(value, value.length, value.length)!;

    // When a user is chosen
    const result = completeMention(value, token, "alice");

    // Then typing can continue immediately after the completed mention
    expect(result).toEqual({ value: "Thanks @alice ", caret: 14 });
  });
});
