import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { FileDiffLoadedFiles } from "@pierre/diffs";
import { outlineSymbols, SymbolIndexes, type SymbolSource } from "../server/symbolIndexes";
import { Storage } from "../server/storage";
import { symbolRequest } from "../server/symbolApi";
import { symbolWords } from "../shared/symbols";
import { symbolLookup } from "../src/diffSymbols";
import { findSymbols } from "../src/SymbolPicker";
import { createApi } from "../server/api";
import { GitHub } from "../server/github";
import { Workspaces } from "../server/workspaces";

describe("symbolIndexes", () => {
  let storage: Storage;
  let indexes: SymbolIndexes;
  beforeEach(() => { storage = new Storage(); indexes = new SymbolIndexes(storage); });
  afterEach(async () => { await indexes.drain(); await storage.close(); });

  it("extracts full-source declarations and class members with the bundled Rust executable", async () => {
    // Given a complete TypeScript file rather than a patch hunk
    const file = { path: "src/reviews.ts", oldPath: "src/old.ts" };
    // When both immutable sides are outlined
    const symbols = await outlineSymbols(file, contents("export function before() {}\n", "export class Reviews {\n  saveReview() {}\n}\n"));
    // Then members retain their source side, one-based line and enclosing class
    expect(symbols).toEqual([
      { name: "before", kind: "function", path: file.path, side: "LEFT", line: 1 },
      { name: "Reviews", kind: "class", path: file.path, side: "RIGHT", line: 1 },
      { name: "saveReview", kind: "method", path: file.path, side: "RIGHT", line: 2, scope: "Reviews" },
    ]);
  });

  it("extracts a second language without a custom declaration extractor", async () => {
    // Given a Python source file
    // When it is outlined
    const symbols = await outlineSymbols({ path: "review.py", oldPath: "review.py" }, contents("", "class Review:\n    def save(self):\n        pass\n"));
    // Then its class and method use the same navigation contract
    expect(symbols).toEqual([
      { name: "Review", kind: "class", path: "review.py", side: "RIGHT", line: 1 },
      { name: "save", kind: "method", path: "review.py", side: "RIGHT", line: 2, scope: "Review" },
    ]);
  });

  it("admits indexing while its source request is held", async () => {
    // Given a source provider that cannot yet return content
    const held = Promise.withResolvers<FileDiffLoadedFiles>();
    const source = sourceFor(() => held.promise);
    try {
      // When the index is requested
      const result = indexes.read(source);
      // Then callers immediately receive an explicit pending result
      expect(result).toEqual({ symbols: [], completed: 0, total: 1, state: "indexing", errors: [] });
    } finally { held.resolve(contents("", "function saved() {}\n")); }
  });

  it("reuses persisted declarations without loading source after a service restart", async () => {
    // Given a completed review-owned index
    const source = sourceFor(async () => contents("", "function saved() {}\n"));
    indexes.read(source);
    await indexes.drain();
    // And a fresh service whose source is unavailable
    indexes = new SymbolIndexes(storage);
    // When the same comparison is requested
    indexes.read({ ...source, load: async () => { throw new Error("Source must not be needed"); } });
    await indexes.drain();
    // Then SQLite supplies a complete declaration index
    expect(indexes.read(source)).toEqual({ symbols: [{ name: "saved", kind: "function", path: "review.ts", side: "RIGHT", line: 1 }], completed: 1, total: 1, state: "complete", errors: [] });
  });

  it("does not reuse another comparison's line coordinates", async () => {
    // Given an indexed old comparison
    const source = sourceFor(async () => contents("", "function saved() {}\n"));
    indexes.read(source);
    await indexes.drain();
    // When a new revision moves the declaration
    const next = { ...source, revision: "new-head", load: async () => contents("", "\nfunction saved() {}\n") };
    indexes.read(next);
    await indexes.drain();
    // Then navigation uses the new line instead of stale cached coordinates
    expect(indexes.read(next).symbols).toEqual([{ name: "saved", kind: "function", path: "review.ts", side: "RIGHT", line: 2 }]);
  });

  it("keeps successful files when another source fails and supports retry", async () => {
    // Given two files, one of which cannot be loaded yet
    let available = false;
    const source: SymbolSource = { ...sourceFor(async (file) => {
      if (file.path === "second.ts" && !available) throw new Error("Source unavailable");
      return contents("", `function ${file.path === "second.ts" ? "second" : "first"}() {}\n`);
    }), files: [{ path: "review.ts", oldPath: "review.ts" }, { path: "second.ts", oldPath: "second.ts" }] };
    indexes.read(source);
    await indexes.drain();
    // And the source becomes available
    available = true;
    // When the failed index is retried
    indexes.read(source, true);
    await indexes.drain();
    // Then both definitions are available without losing the first file's cached work
    expect(indexes.read(source).symbols.map((symbol) => symbol.name)).toEqual(["first", "second"]);
  });

  it("records failure instead of caching a fabricated empty source", async () => {
    // Given a source read that fails
    const source = sourceFor(async () => { throw new Error("GitHub offline"); });
    // When indexing finishes
    indexes.read(source);
    await indexes.drain();
    // Then the failure is distinct from a complete file with no declarations
    expect(indexes.read(source)).toEqual({ symbols: [], completed: 1, total: 1, state: "failed", errors: ["review.ts: GitHub offline"] });
  });

  it("stores declaration indexes under a synthetic row ID and the review foreign key", async () => {
    // Given an indexed comparison
    indexes.read(sourceFor(async () => contents("", "function saved() {}\n")));
    await indexes.drain();
    // When its owner is removed
    storage.db.exec("DELETE FROM review_aliases");
    storage.db.exec("DELETE FROM reviews");
    // Then disposable symbol indexes cascade with that review
    expect(storage.db.query("SELECT * FROM symbol_indexes").all()).toEqual([]);
  });

  it("rejects mutable revision names", () => {
    // Given a request with a branch name rather than the displayed commit
    // When its manifest is parsed
    // Then no index can silently track a moving branch
    expect(() => symbolRequest({ head: "main", files: [] })).toThrow("Invalid symbol head revision");
  });

  it("matches whole Unicode identifiers in comments and strings", () => {
    // Given references mixed with prose and a longer unrelated identifier
    // When source words are extracted
    const words = symbolWords('// saveReview "saveReview" saveReviewer café $store 123saveReview');
    // Then exact-name lookup has stable source offsets without lexical filtering
    expect(words).toEqual([
      { name: "saveReview", start: 3, end: 13 }, { name: "saveReview", start: 15, end: 25 },
      { name: "saveReviewer", start: 27, end: 39 }, { name: "café", start: 40, end: 44 }, { name: "$store", start: 45, end: 51 },
    ]);
  });

  it("does not resolve a removed reference against a head declaration", () => {
    // Given differently located declarations on each side
    const lookup = symbolLookup([
      { name: "saveReview", kind: "function", path: "review.ts", side: "LEFT", line: 4 },
      { name: "saveReview", kind: "function", path: "review.ts", side: "RIGHT", line: 12 },
    ]);
    // When the removed name is looked up
    // Then only the base coordinate is returned
    expect(lookup.get("LEFT:saveReview")?.map((symbol) => symbol.line)).toEqual([4]);
  });

  it("ranks exact symbol names before fuzzy subsequences", () => {
    // Given declarations with similarly spelled names
    const symbols = ["saveReviews", "saveReview", "startReview"].map((name) => ({ name, kind: "function", path: "review.ts", side: "RIGHT" as const, line: 1 }));
    // When a name is searched
    // Then the exact declaration is first
    expect(findSymbols(symbols, "saveReview").map((symbol) => symbol.name)).toEqual(["saveReview", "saveReviews"]);
  });

  it("returns an admission response before its remote source completes", async () => {
    // Given an API whose GitHub source is held
    const held = Promise.withResolvers<ReturnType<typeof contents>>();
    const github = new GitHub(undefined, storage);
    github.contents = async () => held.promise;
    const api = createApi({ storage, github, workspaces: new Workspaces(storage), symbols: indexes });
    try {
      // When the displayed comparison is admitted
      const response = await api(new Request("http://127.0.0.1:4567/api/github/pr/example/repo/1/symbols", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ head: "a".repeat(40), base: "b".repeat(40), files: [{ path: "review.ts", oldPath: "review.ts" }] }),
      }));
      // Then the HTTP response is available without waiting for the held source
      expect(await response.json()).toEqual({ symbols: [], completed: 0, total: 1, state: "indexing", errors: [] });
    } finally { held.resolve(contents("", "function saved() {}\n")); }
  });

  it("does not interpret source paths as filesystem escapes", () => {
    // Given an otherwise valid immutable comparison
    // When a path outside its repository is supplied
    // Then it is rejected before source reads or parser execution
    expect(() => symbolRequest({ head: "a".repeat(40), files: [{ path: "../secret.ts", oldPath: "file.ts" }] })).toThrow("Invalid symbol source path");
  });

  it("handles files without a supported declaration grammar as complete empty indexes", async () => {
    // Given a prose file rather than executable source
    // When the bundled extractor processes it
    const symbols = await outlineSymbols({ path: "notes.txt", oldPath: "notes.txt" }, contents("", "saveReview is a useful function.\n"));
    // Then no invented declaration or parser failure is reported
    expect(symbols).toEqual([]);
  });

  it("extracts JavaScript private members without dropping their hash prefix", async () => {
    // Given private methods, fields, and accessors beside a same-named public method
    const source = "class Example {\n  #foo() {}\n  foo() {}\n  async #bar() {}\n  static #baz() {}\n  #field = () => {};\n  get #value() { return 1; }\n}\n";
    // When the real bundled extractor outlines the JavaScript source
    const symbols = await outlineSymbols({ path: "example.js", oldPath: "example.js" }, contents("", source));
    // Then every member retains its complete declaration name
    expect(symbols.map((symbol) => symbol.name)).toEqual(["Example", "#foo", "foo", "#bar", "#baz", "#field", "#value"]);
  });

  it("keeps private JavaScript references distinct from public references", () => {
    // Given private and public references with the same identifier stem
    // When source words are extracted for a JavaScript file
    const words = symbolWords("this.#foo(); this.foo();", "example.js");
    // Then the private prefix is part of both the name and its source range
    expect(words).toEqual([
      { name: "this", start: 0, end: 4 }, { name: "#foo", start: 5, end: 9 },
      { name: "this", start: 13, end: 17 }, { name: "foo", start: 18, end: 21 },
    ]);
  });

  it("preserves Unicode private names in TypeScript module files", () => {
    // Given a private Unicode identifier in a TypeScript module
    // When source words are extracted
    const words = symbolWords("this.#café()", "example.mts");
    // Then the complete identifier has UTF-16 source offsets
    expect(words).toEqual([{ name: "this", start: 0, end: 4 }, { name: "#café", start: 5, end: 10 }]);
  });

  it("keeps hash-comment navigation unchanged in Python", () => {
    // Given a name immediately following Python's comment marker
    // When source words are extracted for a Python file
    const words = symbolWords("#saveReview", "example.py");
    // Then the marker is not incorrectly treated as a private-name prefix
    expect(words).toEqual([{ name: "saveReview", start: 1, end: 11 }]);
  });

  it("does not fall back to a public name inside an invalid private identifier", () => {
    // Given invalid private names beside a valid one
    // When JavaScript source words are extracted
    const words = symbolWords("#123foo ##foo #foo", "example.tsx");
    // Then only the complete valid private identifier is available for lookup
    expect(words).toEqual([{ name: "#foo", start: 14, end: 18 }]);
  });
});

/** Supply exact old/new source text without a filesystem checkout. */
function contents(oldSource: string, newSource: string) {
  return { oldFile: { name: "review.ts", contents: oldSource }, newFile: { name: "review.ts", contents: newSource } } satisfies FileDiffLoadedFiles;
}

/** Keep review ownership and explicit snapshot identity visible in cache tests. */
function sourceFor(load: SymbolSource["load"]): SymbolSource {
  return { scope: "example/repo/1", revision: "head/base", files: [{ path: "review.ts", oldPath: "review.ts" }], load };
}
