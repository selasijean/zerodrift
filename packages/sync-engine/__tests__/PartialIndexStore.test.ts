import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeStoreManager } from "./helpers/storeManager";
import { StoreManager } from "@sync-engine/StoreManager";
import { MemoryAdapter } from "@sync-engine/MemoryAdapter";
import { BaseModel } from "@sync-engine/BaseModel";

let manager: StoreManager;

beforeEach(() => {
  BaseModel.storeManager = null;
});

afterEach(async () => {
  await manager?.teardown();
  BaseModel.storeManager = null;
});

/**
 * Phase 2: persistent partial-index store. The storage adapter records every
 * fully-fetched `(modelName, indexKey, value)` triple so that a fresh
 * StoreManager (e.g. after page reload) can skip the server fetch when the
 * adapter already has coverage.
 */
describe("Persistent partial-index coverage", () => {
  it("records coverage on successful getOrLoadCollection", async () => {
    const adapter = new MemoryAdapter();
    const fetcher = vi.fn().mockResolvedValue([
      { id: "a1", taskId: "t1", text: "first" },
    ]);
    manager = makeStoreManager({
      workspaceId: crypto.randomUUID(),
      bootstrapFetcher: vi.fn().mockResolvedValue({
        lastSyncId: 0,
        subscribedSyncGroups: [],
        models: {},
      }),
      onDemandFetcher: fetcher,
      storageAdapter: adapter,
    });
    await manager.bootstrap();

    await manager.getOrLoadCollection("TestActivity", "taskId", "t1");

    const recorded = await adapter.loadPartialIndexes();
    expect(recorded).toContainEqual({
      modelName: "TestActivity",
      indexKey: "taskId",
      value: "t1",
      firstSyncId: 0,
    });
  });

  it("marks the model loaded even when getOrLoadCollection returns empty", async () => {
    // Without this, the SSE catchup URL would omit the model and future
    // server-side inserts for it would get filtered out.
    const adapter = new MemoryAdapter();
    const fetcher = vi.fn().mockResolvedValue([]);
    manager = makeStoreManager({
      workspaceId: crypto.randomUUID(),
      bootstrapFetcher: vi.fn().mockResolvedValue({
        lastSyncId: 0,
        subscribedSyncGroups: [],
        models: {},
      }),
      onDemandFetcher: fetcher,
      storageAdapter: adapter,
    });
    await manager.bootstrap();

    expect([...adapter.loadedModels]).not.toContain("TestActivity");
    await manager.getOrLoadCollection("TestActivity", "taskId", "t-empty");
    expect([...adapter.loadedModels]).toContain("TestActivity");
  });

  it("rebuilds the in-memory cache from the adapter on bootstrap", async () => {
    const adapter = new MemoryAdapter();
    await adapter.recordPartialIndex("TestActivity", "taskId", "t1", 0);

    manager = makeStoreManager({
      workspaceId: crypto.randomUUID(),
      bootstrapFetcher: vi.fn().mockResolvedValue({
        lastSyncId: 0,
        subscribedSyncGroups: [],
        models: {},
      }),
      storageAdapter: adapter,
    });
    await manager.bootstrap();

    expect(manager.isCollectionLoaded("TestActivity", "taskId", "t1")).toBe(
      true,
    );
  });

  it("skips the server fetch when prior coverage is rehydrated from the adapter", async () => {
    const adapter = new MemoryAdapter();
    await adapter.recordPartialIndex("TestActivity", "taskId", "t1", 0);
    // Pre-seed the adapter with the records so getOrLoadCollection returns them via
    // the IDB read path even though the server fetcher is never called.
    await adapter.writeModels("TestActivity", [
      { id: "a1", taskId: "t1", text: "cached" },
    ]);

    const fetcher = vi.fn();
    manager = makeStoreManager({
      workspaceId: crypto.randomUUID(),
      bootstrapFetcher: vi.fn().mockResolvedValue({
        lastSyncId: 0,
        subscribedSyncGroups: [],
        models: {},
      }),
      onDemandFetcher: fetcher,
      storageAdapter: adapter,
    });
    await manager.bootstrap();

    const items = await manager.getOrLoadCollection("TestActivity", "taskId", "t1");

    expect(fetcher).not.toHaveBeenCalled();
    expect(items.map((m) => m.id)).toEqual(["a1"]);
  });

  it("clears coverage when evictByIndex runs", async () => {
    const adapter = new MemoryAdapter();
    await adapter.recordPartialIndex("TestActivity", "taskId", "t1", 0);

    manager = makeStoreManager({
      workspaceId: crypto.randomUUID(),
      bootstrapFetcher: vi.fn().mockResolvedValue({
        lastSyncId: 0,
        subscribedSyncGroups: [],
        models: {},
      }),
      storageAdapter: adapter,
    });
    await manager.bootstrap();

    expect(manager.isCollectionLoaded("TestActivity", "taskId", "t1")).toBe(
      true,
    );

    await manager.evictByIndex("TestActivity", "taskId", "t1");

    expect(manager.isCollectionLoaded("TestActivity", "taskId", "t1")).toBe(
      false,
    );
    const recorded = await adapter.loadPartialIndexes();
    expect(recorded).toHaveLength(0);
  });

  it("clearPartialIndexesForModel removes all coverage entries for one model", async () => {
    const adapter = new MemoryAdapter();
    await adapter.recordPartialIndex("TestActivity", "taskId", "t1", 0);
    await adapter.recordPartialIndex("TestActivity", "taskId", "t2", 0);
    await adapter.recordPartialIndex("TestComment", "taskId", "t1", 0);

    await adapter.clearPartialIndexesForModel("TestActivity");

    const recorded = await adapter.loadPartialIndexes();
    expect(recorded).toEqual([
      {
        modelName: "TestComment",
        indexKey: "taskId",
        value: "t1",
        firstSyncId: 0,
      },
    ]);
  });

  it("records firstSyncId at the time of fetch and exposes it via getPartialIndexCoverage", async () => {
    const adapter = new MemoryAdapter();
    await adapter.saveMeta({
      lastSyncId: 4242,
      subscribedSyncGroups: [],
      schemaHash: "hash",
      dbVersion: 1,
      backendDatabaseVersion: 0,
    });
    const fetcher = vi.fn().mockResolvedValue([
      { id: "a1", taskId: "t1", text: "first" },
    ]);
    manager = makeStoreManager({
      workspaceId: crypto.randomUUID(),
      bootstrapFetcher: vi.fn().mockResolvedValue({
        lastSyncId: 4242,
        subscribedSyncGroups: [],
        models: {},
      }),
      onDemandFetcher: fetcher,
      storageAdapter: adapter,
    });
    await manager.bootstrap();

    await manager.getOrLoadCollection("TestActivity", "taskId", "t1");

    expect(manager.getPartialIndexCoverage()).toContainEqual({
      modelName: "TestActivity",
      indexKey: "taskId",
      value: "t1",
      firstSyncId: 4242,
    });
  });
});
