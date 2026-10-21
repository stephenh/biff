import { describe, expect, it } from "bun:test";
import { groupFileComments } from "../src/FileComments";
import type { LineThread } from "../src/lineComments";

describe("fileComments", () => {
  it("groups renamed paths under the current file name", () => {
    // Given a renamed file with discussion on its old path
    const files = [{ name: "new.ts", prevName: "old.ts" }];
    const thread = makeThread("renamed", "old.ts");

    // When discussions are grouped
    const groups = groupFileComments(files, "new.ts", [thread]);

    // Then the thread belongs to the renamed file without becoming orphaned
    expect(groups).toEqual([{ path: "new.ts", threads: [{ ...thread, outdated: false }] }]);
  });

  it("retains threads whose file disappeared from the patch", () => {
    // Given a thread on a file absent from the current diff
    const thread = makeThread("missing", "missing.ts");

    // When discussions are grouped
    const groups = groupFileComments([{ name: "current.ts" }], "current.ts", [thread]);

    // Then the missing file keeps its own orphaned group
    expect(groups).toEqual([{ path: "current.ts", threads: [] }, { path: "missing.ts", threads: [{ ...thread, outdated: true }] }]);
  });

  it("shows current threads before outdated coordinates within a file", () => {
    // Given an old thread whose original line precedes a current discussion
    const old = { ...makeThread("old", "file.ts"), outdated: true };
    const current = makeThread("current", "file.ts", 50);

    // When discussions are grouped
    const groups = groupFileComments([{ name: "file.ts" }], "file.ts", [old, current]);

    // Then current discussions precede orphaned ones
    expect(groups.flatMap((group) => group.threads.map((thread) => thread.id))).toEqual(["current", "old"]);
  });

  it("opens at the selected file rather than the first file in the diff", () => {
    // Given discussion on two files
    const first = makeThread("first", "first.ts");
    const second = makeThread("second", "second.ts");

    // When comments opens from the second file
    const groups = groupFileComments([{ name: "first.ts" }, { name: "second.ts" }], "second.ts", [first, second]);

    // Then the selected file is the first group
    expect(groups.map((group) => group.path)).toEqual(["second.ts", "first.ts"]);
  });

  it("places orphaned threads below current threads from every file", () => {
    // Given an orphaned thread on the selected file and a current thread on another file
    const orphaned = { ...makeThread("orphaned", "selected.ts"), outdated: true };
    const current = makeThread("current", "other.ts");
    // And a thread on a file absent from the patch
    const missing = makeThread("missing", "missing.ts");

    // When comments are ordered across files
    const groups = groupFileComments([{ name: "selected.ts" }, { name: "other.ts" }], "selected.ts", [orphaned, missing, current]);

    // Then all current threads appear before the orphaned section
    expect(groups.flatMap((group) => group.threads.map((thread) => thread.id))).toEqual(["current", "orphaned", "missing"]);
  });
});

/** Keep grouping fixtures focused on identity and file coordinates. */
function makeThread(id: string, path: string, line = 1): LineThread {
  return { id, location: { path, line, side: "RIGHT" }, comments: [{ id: 1, body: id, user: { login: "alice" }, html_url: "" }] };
}
