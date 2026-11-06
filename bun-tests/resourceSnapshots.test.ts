import { describe, expect, it } from "bun:test";
import { latestVersion } from "../src/api";

describe("resourceSnapshots", () => {
  it("accepts the initial acknowledged snapshot", () => {
    // Given no previous snapshot
    // When the first version arrives
    const incoming = { version: 1, body: "Initial" };
    // Then it becomes the acknowledged snapshot
    expect(latestVersion(undefined, incoming)).toEqual(incoming);
  });

  it("rejects a read older than an acknowledged mutation", () => {
    // Given a mutation acknowledged at version 3
    const current = { version: 3, body: "Saved" };
    // When an older cached read arrives
    const incoming = { version: 2, body: "Obsolete" };
    // Then the last acknowledgement is retained
    expect(latestVersion(current, incoming)).toEqual(current);
  });

  it("accepts a newer stream event", () => {
    // Given the last fetched snapshot
    const current = { version: 1, body: "Initial" };
    // When a newer stream snapshot arrives
    const incoming = { version: 2, body: "Stream update" };
    // Then it replaces the older snapshot
    expect(latestVersion(current, incoming)).toEqual(incoming);
  });

  it("does not erase a known revision with an unversioned snapshot", () => {
    // Given a known acknowledged revision
    const current = { version: 2, body: "Saved" };
    // When a response lacks evidence that it is newer
    const incoming = { body: "Unknown revision" };
    // Then the known revision wins
    expect(latestVersion<{ version?: number; body: string }>(current, incoming)).toEqual(current);
  });
});
