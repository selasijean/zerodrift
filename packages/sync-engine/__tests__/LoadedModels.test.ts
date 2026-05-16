/**
 * Loaded-models tracking & SSE catchup URL.
 *
 * The adapter tracks which models have data locally (rows in IDB / entries
 * in MemoryAdapter's Map). The SSE URL passes that set as `&onlyModels=`
 * so the server skips deltas for models the client never touched. Mid-
 * session add/remove transitions trigger a debounced reconnect so the
 * server picks up the new filter for the live stream.
 */

import { describe, it, expect, vi } from "vitest";
import { makeStoreManager } from "./helpers/storeManager";
import { MemoryAdapter } from "@sync-engine/MemoryAdapter";
import { BaseModel } from "@sync-engine/BaseModel";
import { makeSyncConnection } from "./helpers/makeSyncConnection";
import { ObjectPool } from "@sync-engine/ObjectPool";
import { TransactionQueue } from "@sync-engine/TransactionQueue";
import type {
  SSEClient,
  SSEClientFactory,
} from "@sync-engine/SyncConnection";
import "./fixtures";

function noopSSEClient(): SSEClient {
  return { onmessage: null, onerror: null, close: vi.fn() };
}

function recordingFactory(): { factory: SSEClientFactory; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    factory: (url) => {
      calls.push(url);
      return noopSSEClient();
    },
  };
}

describe("loadedModels tracking", () => {
  it("starts empty and grows as writeModels writes records", async () => {
    const adapter = new MemoryAdapter();
    await adapter.connect();
    expect([...adapter.loadedModels]).toEqual([]);

    await adapter.writeModels("TestTask", [{ id: "t1", title: "x" }]);
    expect([...adapter.loadedModels]).toEqual(["TestTask"]);

    await adapter.writeModels("TestTask", [{ id: "t2", title: "y" }]);
    // Same model, second write — set is unchanged.
    expect([...adapter.loadedModels]).toEqual(["TestTask"]);
  });

  it("ignores empty writes (no records)", async () => {
    const adapter = new MemoryAdapter();
    await adapter.connect();
    await adapter.writeModels("TestTask", []);
    await adapter.writeModelsIfAbsent("TestTask", []);
    expect([...adapter.loadedModels]).toEqual([]);
  });

  it("markModelLoaded marks the model even with no rows written", async () => {
    // Empty server response from `getOrLoadCollection` / `getOrLoadById` still expresses
    // "we want SSE deltas for this model". The adapter's writeModels path
    // bails on records.length === 0, so a separate marker call is the only
    // way to register the load.
    const adapter = new MemoryAdapter();
    await adapter.connect();
    adapter.markModelLoaded("TestActivity");
    expect([...adapter.loadedModels]).toContain("TestActivity");
  });

  it("removes a model from the set when its store is cleared", async () => {
    const adapter = new MemoryAdapter();
    await adapter.connect();
    await adapter.writeModels("TestTask", [{ id: "t1", title: "x" }]);
    await adapter.clearModelStore("TestTask");
    expect([...adapter.loadedModels]).toEqual([]);
  });

  it("reseeds from non-empty buckets on reconnect", async () => {
    const adapter = new MemoryAdapter();
    await adapter.connect();
    await adapter.writeModels("TestTask", [{ id: "t1", title: "x" }]);

    await adapter.connect();
    // The Map persists across connects; the set rebuilds from it.
    expect([...adapter.loadedModels]).toEqual(["TestTask"]);
  });

  it("notifies subscribers on add and remove transitions", async () => {
    const adapter = new MemoryAdapter();
    await adapter.connect();
    const cb = vi.fn();
    const unsub = adapter.onLoadedModelsChange(cb);

    await adapter.writeModels("TestTask", [{ id: "t1", title: "x" }]);
    expect(cb).toHaveBeenCalledTimes(1);

    // Second write to same model: no transition, no notify.
    await adapter.writeModels("TestTask", [{ id: "t2", title: "y" }]);
    expect(cb).toHaveBeenCalledTimes(1);

    await adapter.clearModelStore("TestTask");
    expect(cb).toHaveBeenCalledTimes(2);

    unsub();
    await adapter.writeModels("TestTask", [{ id: "t3", title: "z" }]);
    expect(cb).toHaveBeenCalledTimes(2); // unsubscribed
  });
});

describe("SSE URL onlyModels param", () => {
  it("appends &onlyModels=<csv> when loadedModels is non-empty", async () => {
    const adapter = new MemoryAdapter();
    await adapter.connect();
    await adapter.saveMeta({
      lastSyncId: 7,
      subscribedSyncGroups: ["g1"],
      schemaHash: "x",
      dbVersion: 1,
      backendDatabaseVersion: 0,
    });
    await adapter.writeModels("TestTask", [{ id: "t1", title: "x" }]);
    await adapter.writeModels("TestProject", [{ id: "p1", name: "y" }]);

    const { factory, calls } = recordingFactory();
    const pool = new ObjectPool();
    const queue = new TransactionQueue(adapter, pool);
    const conn = makeSyncConnection({
      url: "http://x/events",
      db: adapter,
      pool,
      queue,
      sseClientFactory: factory,
    });
    conn.connect();

    expect(calls).toHaveLength(1);
    const url = calls[0];
    expect(url).toContain("lastSyncId=7");
    // onlyModels carries both models, comma-separated and URL-encoded.
    expect(url).toMatch(/onlyModels=[^&]*TestTask/);
    expect(url).toMatch(/onlyModels=[^&]*TestProject/);

    conn.disconnect();
  });

  it("sorts loadedModels for a stable URL across iteration orders", async () => {
    const adapter = new MemoryAdapter();
    await adapter.connect();
    await adapter.saveMeta({
      lastSyncId: 0,
      subscribedSyncGroups: [],
      schemaHash: "x",
      dbVersion: 1,
      backendDatabaseVersion: 0,
    });
    // Insertion order is the reverse of alphabetical.
    await adapter.writeModels("TestProject", [{ id: "p1" }]);
    await adapter.writeModels("TestComment", [{ id: "c1" }]);
    await adapter.writeModels("TestActivity", [{ id: "a1" }]);

    const { factory, calls } = recordingFactory();
    const pool = new ObjectPool();
    const queue = new TransactionQueue(adapter, pool);
    const conn = makeSyncConnection({
      url: "http://x/events",
      db: adapter,
      pool,
      queue,
      sseClientFactory: factory,
    });
    conn.connect();

    // The URL is the union of always-subscribed (Instant + Ephemeral) plus
    // loadedModels. Verify the three names we wrote appear in alphabetical
    // order regardless of insertion order.
    const url = calls[0];
    const param = url.match(/onlyModels=([^&]+)/)?.[1] ?? "";
    const names = decodeURIComponent(param).split(",");
    const a = names.indexOf("TestActivity");
    const c = names.indexOf("TestComment");
    const p = names.indexOf("TestProject");
    expect(a).toBeGreaterThan(-1);
    expect(c).toBeGreaterThan(-1);
    expect(p).toBeGreaterThan(-1);
    expect(a).toBeLessThan(c);
    expect(c).toBeLessThan(p);

    conn.disconnect();
  });

  it("includes Instant + Ephemeral models even when no records have been written", async () => {
    // An Instant model the server has zero rows for in this workspace would
    // otherwise be omitted from the catchup URL (writeModels never fired with
    // records, so it's not in loadedModels). The server would filter future
    // inserts for it. The fix: always-subscribe Instant + Ephemeral.
    const adapter = new MemoryAdapter();
    await adapter.connect();
    await adapter.saveMeta({
      lastSyncId: 0,
      subscribedSyncGroups: [],
      schemaHash: "x",
      dbVersion: 1,
      backendDatabaseVersion: 0,
    });

    const { factory, calls } = recordingFactory();
    const pool = new ObjectPool();
    const queue = new TransactionQueue(adapter, pool);
    const conn = makeSyncConnection({
      url: "http://x/events",
      db: adapter,
      pool,
      queue,
      sseClientFactory: factory,
    });
    conn.connect();

    // TestTask is Instant; TestMetric is Ephemeral. Both should be present
    // even though we never wrote any rows for them.
    expect(calls[0]).toMatch(/onlyModels=[^&]*TestTask/);
    expect(calls[0]).toMatch(/onlyModels=[^&]*TestMetric/);
    // TestActivity is Partial — NOT pre-subscribed, no rows written.
    expect(calls[0]).not.toMatch(/onlyModels=[^&]*TestActivity/);

    conn.disconnect();
  });
});

describe("StoreManager — reconnect on loaded-models change", () => {
  it("coalesces a burst of writes into a single SSE reconnect", async () => {
    BaseModel.storeManager = null;
    const adapter = new MemoryAdapter();
    await adapter.saveMeta({
      lastSyncId: 100,
      subscribedSyncGroups: [],
      schemaHash: "x",
      dbVersion: 1,
      backendDatabaseVersion: 0,
    });

    const { factory, calls } = recordingFactory();
    const manager = makeStoreManager({
      workspaceId: crypto.randomUUID(),
      bootstrapFetcher: vi.fn().mockResolvedValue({
        lastSyncId: 100,
        subscribedSyncGroups: [],
        models: {},
      }),
      storageAdapter: adapter,
      syncUrl: "http://x/events",
      sseClientFactory: factory,
    });
    try {
      await manager.bootstrap();
      const initialConnects = calls.length;

      // Three sequential awaited writes for distinct models — each fires the
      // listener, but the setTimeout(0) debounce coalesces them into one
      // reconnect on the next macrotask.
      await adapter.writeModels("TestTask", [{ id: "t1" }]);
      await adapter.writeModels("TestProject", [{ id: "p1" }]);
      await adapter.writeModels("TestComment", [{ id: "c1" }]);

      // Wait one macrotask for the timer to fire.
      await new Promise((r) => setTimeout(r, 0));

      expect(calls.length).toBe(initialConnects + 1);
    } finally {
      await manager.teardown();
      BaseModel.storeManager = null;
    }
  });
});
