import { describe, expect, it } from "bun:test";
import { BackgroundSaveRegistry, OptimisticSaveQueue } from "../src/optimisticSave";

describe("optimisticSave", () => {
  it("changes the displayed value before the write completes", () => {
    // Given a held background write
    const held = Promise.withResolvers<void>();
    const queue = new OptimisticSaveQueue<boolean>("resolution", new BackgroundSaveRegistry());

    // When a thread is resolved
    queue.save("a", true, false, () => held.promise, "Thread A");

    // Then it appears resolved immediately
    expect(queue.value("a", false)).toEqual(true);
    held.resolve();
  });

  it("serializes a reversal after its in-flight write", async () => {
    // Given a held resolve request
    const held = Promise.withResolvers<void>();
    const queue = new OptimisticSaveQueue<boolean>("resolution", new BackgroundSaveRegistry());
    const writes: boolean[] = [];
    function persist(value: boolean) { writes.push(value); return writes.length === 1 ? held.promise : Promise.resolve(); }
    queue.save("a", true, false, persist, "Thread A");

    // When the thread is reopened before the first request completes
    queue.save("a", false, false, persist, "Thread A");
    held.resolve();
    await held.promise;

    // Then the server receives the resolve before the reversal
    expect(writes).toEqual([true, false]);
  });

  it("lets another entity finish while the first is still saving", async () => {
    // Given a held request for thread A
    const held = Promise.withResolvers<void>();
    const registry = new BackgroundSaveRegistry();
    const queue = new OptimisticSaveQueue<boolean>("resolution", registry);
    queue.save("a", true, false, () => held.promise, "Thread A");

    // When thread B is saved independently
    const saved = Promise.resolve();
    queue.save("b", true, false, () => saved, "Thread B");
    await saved;

    // Then only thread A remains pending
    expect(registry.getSnapshot().filter((receipt) => receipt.status === "saving").map((receipt) => receipt.label)).toEqual(["Thread A"]);
    held.resolve();
  });

  it("does not roll back a newer intent when an older write fails", async () => {
    // Given a held resolve request followed by an optimistic reversal
    const held = Promise.withResolvers<void>();
    const queue = new OptimisticSaveQueue<boolean>("resolution", new BackgroundSaveRegistry());
    queue.save("a", true, false, () => held.promise, "Thread A");
    queue.save("a", false, false, () => Promise.resolve(), "Thread A");

    // When the older request fails
    held.reject(new Error("Network interrupted"));
    await held.promise.catch(() => {});

    // Then the newer intent is still displayed
    expect(queue.value("a", true)).toEqual(false);
  });

  it("rolls a failed latest write back to the last acknowledgement", async () => {
    // Given an acknowledged resolve followed by a held reversal
    const queue = new OptimisticSaveQueue<boolean>("resolution", new BackgroundSaveRegistry());
    const saved = Promise.resolve();
    queue.save("a", true, false, () => saved, "Thread A");
    await saved;
    // And the reversal is in flight
    const failed = Promise.withResolvers<void>();
    queue.save("a", false, false, () => failed.promise, "Thread A");

    // When the reversal fails
    failed.reject(new Error("Permission denied"));
    await failed.promise.catch(() => {});

    // Then the last acknowledged resolved state is restored
    expect(queue.value("a", false)).toEqual(true);
  });

  it("retries the failed intent rather than the rolled-back value", async () => {
    // Given a failed resolve
    const registry = new BackgroundSaveRegistry();
    const queue = new OptimisticSaveQueue<boolean>("resolution", registry);
    const failed = Promise.withResolvers<void>();
    const writes: boolean[] = [];
    function persist(value: boolean) { writes.push(value); return writes.length === 1 ? failed.promise : Promise.resolve(); }
    queue.save("a", true, false, persist, "Thread A");
    failed.reject(new Error("Temporary failure"));
    await failed.promise.catch(() => {});

    // When Retry is requested
    registry.getSnapshot()[0].retry();

    // Then the original resolve is sent again
    expect(writes).toEqual([true, true]);
  });

  it("does not let a stale snapshot erase a pending value", () => {
    // Given an optimistic resolve whose request is held
    const held = Promise.withResolvers<void>();
    const queue = new OptimisticSaveQueue<boolean>("resolution", new BackgroundSaveRegistry());
    queue.save("a", true, false, () => held.promise, "Thread A");

    // When an old server snapshot arrives
    queue.reconcile(new Map([["a", false]]));

    // Then the optimistic state remains visible
    expect(queue.value("a", false)).toEqual(true);
    held.resolve();
  });

  it("retains a pending value when its view remounts", () => {
    // Given a resource-scoped queue with a held request
    const registry = new BackgroundSaveRegistry();
    const queue = registry.queue<boolean>("resolution:pr-1");
    const held = Promise.withResolvers<void>();
    queue.save("a", true, false, () => held.promise, "Thread A");

    // When the same resource opens again
    const reopened = registry.queue<boolean>("resolution:pr-1");

    // Then it reuses the pending optimistic state
    expect(reopened.value("a", false)).toEqual(true);
    held.resolve();
  });

  it("coalesces a reversal back to the value already being saved", async () => {
    // Given a held resolve
    const held = Promise.withResolvers<void>();
    const queue = new OptimisticSaveQueue<boolean>("resolution", new BackgroundSaveRegistry());
    const writes: boolean[] = [];
    function persist(value: boolean) { writes.push(value); return held.promise; }
    queue.save("a", true, false, persist, "Thread A");

    // When the user reopens then resolves again before the acknowledgement
    queue.save("a", false, false, persist, "Thread A");
    queue.save("a", true, false, persist, "Thread A");
    held.resolve();
    await held.promise;

    // Then the already-successful write satisfies the final intent
    expect(writes).toEqual([true]);
  });

  it("lets a fresh view replace an acknowledged value changed elsewhere", async () => {
    // Given a saved resolve whose view closed before reconciling
    const queue = new OptimisticSaveQueue<boolean>("resolution", new BackgroundSaveRegistry());
    const saved = Promise.resolve();
    queue.save("a", true, false, () => saved, "Thread A");
    await saved;

    // When a fresh server snapshot shows that someone else reopened the thread
    queue.reconcile(new Map([["a", false]]), true);

    // Then the old acknowledgement no longer overrides the server
    expect(queue.value("a", false)).toEqual(false);
  });

  it("preserves every append operation in entity order", async () => {
    // Given a held comment publication and a second submission to the same thread
    const registry = new BackgroundSaveRegistry();
    const held = Promise.withResolvers<void>();
    const published: string[] = [];
    const first = registry.submit("comments", "thread-a", "first", "First comment", async () => { await held.promise; published.push("First comment"); });
    const second = registry.submit("comments", "thread-a", "second", "Second comment", async () => { published.push("Second comment"); });

    // When the first submission can finish
    held.resolve();
    await Promise.all([first, second]);

    // Then neither submission was coalesced away or published out of order
    expect(published).toEqual(["First comment", "Second comment"]);
  });

  it("deduplicates repeated submissions with the same ID", async () => {
    // Given one submission ID used twice
    const registry = new BackgroundSaveRegistry();
    const published: string[] = [];

    // When the UI attempts the same submission again
    await Promise.all([
      registry.submit("comments", "thread-a", "same-id", "Comment", async () => { published.push("Original"); }),
      registry.submit("comments", "thread-a", "same-id", "Comment", async () => { published.push("Duplicate"); }),
    ]);

    // Then only the original snapshot is published
    expect(published).toEqual(["Original"]);
  });

  it("retries a failed append operation through the same receipt", async () => {
    // Given a publication that fails once
    const registry = new BackgroundSaveRegistry();
    let attempts = 0;
    async function publish() { if (++attempts === 1) throw new Error("Try again"); }
    await registry.submit("comments", "thread-a", "comment-id", "Comment", publish);

    // When its retained receipt is retried
    registry.getSnapshot()[0].retry();
    await registry.submit("comments", "thread-a", "comment-id", "Comment", publish);

    // Then the original operation is acknowledged successfully
    expect(registry.getSnapshot()[0].status).toBe("saved");
  });
  it("a batch reversal repairs remote success whose response was lost", async () => {
    // Given a remote write that applied but whose response is still pending
    const registry = new BackgroundSaveRegistry();
    const queue = new OptimisticSaveQueue<boolean>("progress", registry);
    const held = Promise.withResolvers<void>();
    let remote = false;
    let calls = 0;
    async function persist(value: boolean, confirmed: boolean, attempted = confirmed) {
      if (value !== confirmed || value !== attempted) remote = value;
      if (++calls === 1) await held.promise;
    }
    queue.save("file", true, false, persist, "Review file");
    // And the reader reverses while that response is pending
    queue.save("file", false, false, persist, "Review file");

    // When the first response is lost
    held.reject(new Error("Response lost"));
    await held.promise.catch(() => {});

    // Then the reversal repairs remote state even though it equals the original acknowledgement
    expect(remote).toBe(false);
  });
});
