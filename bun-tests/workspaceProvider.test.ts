import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Storage } from "../server/storage";
import { Workspaces } from "../server/workspaces";
import type { WorkspaceProvider } from "../server/workspaceProvider";
import type { LocalReview, WorkingCopy } from "../shared/types";

describe("workspaceProvider", () => {
  let storage: Storage;
  beforeEach(() => {
    storage = new Storage();
    storage.db.exec("INSERT INTO workspaces VALUES ('workspace','Project','/provider-only/project')");
  });
  afterEach(async () => { await storage.close(); });

  test("accepted snapshots remain readable without a provider or registration", async () => {
    // Given a capture returned by a provider whose path does not exist on this server
    const workspaces = new Workspaces(storage, undefined, new CapturedProvider());
    const accepted = await workspaces.review("workspace", "@");
    // And the registration is subsequently removed
    await workspaces.remove("workspace");

    // When a fresh service reads the accepted capture without contacting that provider
    const recovered = new Workspaces(storage).snapshot("workspace", accepted.snapshotId!);

    // Then the immutable code and coordinates are still available
    expect(recovered).toEqual(accepted);
  });

  test("a provider cannot accept a snapshot under another workspace identity", async () => {
    // Given a provider returning the wrong workspace
    const provider = new CapturedProvider();
    provider.workspaceOverride = "another-workspace";
    const workspaces = new Workspaces(storage, undefined, provider);

    // When its response is rejected
    await workspaces.review("workspace", "@").catch(() => {});

    // Then no capture is accepted
    expect(storage.db.query("SELECT id FROM review_snapshots").all()).toEqual([]);
  });

  test("snapshot lookup enforces the selected workspace", async () => {
    // Given a capture belonging to one workspace
    const workspaces = new Workspaces(storage, undefined, new CapturedProvider());
    const accepted = await workspaces.review("workspace", "@");

    // When another workspace URL requests it
    // Then the mismatched scope is rejected
    expect(() => workspaces.snapshot("another-workspace", accepted.snapshotId!)).toThrow("Snapshot belongs to another workspace");
  });

  test("provider failure leaves earlier captures intact", async () => {
    // Given an accepted capture followed by provider disconnection
    const provider = new CapturedProvider();
    const workspaces = new Workspaces(storage, undefined, provider);
    const accepted = await workspaces.review("workspace", "@");
    provider.offline = true;

    // When preparation of a replacement fails
    await workspaces.review("workspace", "@").catch(() => {});

    // Then the previous capture remains the only accepted snapshot
    expect(storage.db.query("SELECT id FROM review_snapshots").all()).toEqual([{ id: accepted.snapshotId }]);
  });
});

/** Represent a source on another filesystem without introducing a network transport in these tests. */
class CapturedProvider implements WorkspaceProvider {
  offline = false;
  workspaceOverride?: string;

  /** Return immutable source data rather than executing any local JJ command. */
  async review(workspace: WorkingCopy): Promise<LocalReview> {
    if (this.offline) throw new Error("Provider offline");
    const selected = { commit_id: "a".repeat(40), change_id: "change", description: "Captured", author: { name: "Author", email: "a@example.com", timestamp: "today" } };
    return { workspace: { ...workspace, id: this.workspaceOverride ?? workspace.id }, selected, revisions: [selected], patch: "immutable diff" };
  }

  /** The provider contract also supports bookmark selection. */
  async bookmarkReview(workspace: WorkingCopy): Promise<LocalReview> { return this.review(workspace); }

  /** Content capture is a separate source operation, not implicit in reading a stored snapshot. */
  async contents(): Promise<never> { throw new Error("Contents unavailable"); }
}
