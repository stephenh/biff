import { describe, expect, test } from "bun:test";
import { anchorComment, commentHunks, followComment } from "../shared/commentHunks";

describe("commentHunks", () => {
  test("a comment follows an unchanged semantic hunk after unrelated lines move", async () => {
    // Given a comment on the second line of an edit
    const original = await commentHunks(patch(10));
    const comment = anchorComment(original, { path: "file.txt", line: 11, side: "RIGHT", body: "Keep this note." });
    // And the same edit appears farther down the file
    const current = await commentHunks(patch(40));

    // When resolving its hunk-relative attachment
    const followed = followComment(current, comment);

    // Then its text and relative line survive without depending on a commit SHA
    expect(followed).toMatchObject({ path: "file.txt", line: 41, side: "RIGHT", body: "Keep this note.", anchor: { offset: 1 } });
  });

  test("changed hunk text does not attach the comment to a different edit", async () => {
    // Given an anchored comment
    const comment = anchorComment(await commentHunks(patch(10)), { path: "file.txt", line: 10, side: "RIGHT", body: "Keep me visible." });
    // And the replacement was changed
    const current = await commentHunks(patch(10).replace("new first", "different first"));

    // When following its original identity
    const followed = followComment(current, comment);

    // Then the caller must retain it as needing re-anchoring
    expect(followed).toEqual(undefined);
  });

  test("a duplicate appearing at another coordinate cannot steal a comment", async () => {
    // Given a unique edit with a comment
    const comment = anchorComment(await commentHunks(patch(10)), { path: "file.txt", line: 10, side: "RIGHT", body: "This occurrence only." });
    // And two matching edits now exist at different coordinates
    const current = await commentHunks(patch(40) + "@@ -80,2 +80,2 @@\n-old first\n-old second\n+new first\n+new second\n");

    // When resolving the old comment
    const followed = followComment(current, comment);

    // Then no ambiguous occurrence is selected
    expect(followed).toEqual(undefined);
  });

  test("old-side offsets remain on the deletion side when additions have a different offset", async () => {
    // Given a comment on the second deleted line
    const comment = anchorComment(await commentHunks(patch(10)), { path: "file.txt", line: 11, side: "LEFT", body: "Why remove this?" });
    // And earlier insertions shifted only the new side
    const current = await commentHunks(patch(40).replace("+40,2", "+70,2"));

    // When the deletion comment follows the edit
    const followed = followComment(current, comment);

    // Then it uses the old-side offset rather than the addition coordinate
    expect(followed).toMatchObject({ line: 41, side: "LEFT" });
  });

  test("a selected range follows only when every selected line survives", async () => {
    // Given a comment covering both changed lines
    const comment = anchorComment(await commentHunks(patch(10)), { path: "file.txt", line: 10, side: "RIGHT", body: "Both lines." }, 11);
    // And the unchanged edit moved
    const current = await commentHunks(patch(40));

    // When moving the range attachment
    const followed = followComment(current, comment);

    // Then the full selection length remains attached
    expect(followed).toMatchObject({ line: 40, anchor: { lineCount: 2, text: "new first\nnew second\n" } });
  });
  test("a comment follows its selected code when neighboring edits change", async () => {
    // Given a comment on code inside a larger edit
    const comment = anchorComment(await commentHunks(patch(10)), { path: "file.txt", line: 11, side: "RIGHT", body: "Keep this." });
    // And a push moves the code and changes its neighbor
    const current = await commentHunks(patch(40).replace("new first", "different first"));

    // When repairing the attachment
    const followed = followComment(current, comment);

    // Then unchanged selected code supplies the new location
    expect(followed).toMatchObject({ line: 41, body: "Keep this." });
  });

  test("text recovery does not choose between duplicate lines in changed edits", async () => {
    // Given a comment whose hunk no longer exists
    const comment = anchorComment(await commentHunks(patch(10)), { path: "file.txt", line: 11, side: "RIGHT", body: "Keep this." });
    // And its selected text occurs twice in the replacement
    const current = await commentHunks(patch(40).replace("new first", "new second"));

    // When attempting text recovery
    const followed = followComment(current, comment);

    // Then neither occurrence silently steals the comment
    expect(followed).toEqual(undefined);
  });
});

/** Two changed lines share one edit so offset assertions are independent of context width. */
function patch(line: number): string {
  return `diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt\n@@ -${line},2 +${line},2 @@\n-old first\n-old second\n+new first\n+new second\n`;
}
