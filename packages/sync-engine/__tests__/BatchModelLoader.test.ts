import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { StoreManager } from "@sync-engine/StoreManager";
import { MemoryAdapter } from "@sync-engine/MemoryAdapter";
import { BaseModel } from "@sync-engine/BaseModel";
import { BatchModelLoader } from "@sync-engine/BatchModelLoader";

let manager: StoreManager;

beforeEach(() => {
  BaseModel.storeManager = null;
});

afterEach(async () => {
  await manager?.teardown();
  BaseModel.storeManager = null;
});

describe("BatchModelLoader", () => {
  it("coalesces concurrent triples submitted in the same microtask", async () => {
    const fetcher = vi.fn(async () => ({
      // Server returns one bag per modelName containing all matching records.
      TestActivity: [
        { id: "a1", taskId: "t1", text: "for t1" },
        { id: "a2", taskId: "t2", text: "for t2" },
      ],
    }));

    const loader = new BatchModelLoader(fetcher);
    const [r1, r2] = await Promise.all([
      loader.load({ modelName: "TestActivity", indexKey: "taskId", value: "t1" }),
      loader.load({ modelName: "TestActivity", indexKey: "taskId", value: "t2" }),
    ]);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(r1.map((r) => r.id)).toEqual(["a1"]);
    expect(r2.map((r) => r.id)).toEqual(["a2"]);
  });

  it("dedupes identical triples — the server only sees one entry", async () => {
    let receivedQueries: unknown[] = [];
    const fetcher = vi.fn(async (qs) => {
      receivedQueries = qs;
      return { TestActivity: [{ id: "a1", taskId: "t1" }] };
    });
    const loader = new BatchModelLoader(fetcher);

    const [r1, r2, r3] = await Promise.all([
      loader.load({ modelName: "TestActivity", indexKey: "taskId", value: "t1" }),
      loader.load({ modelName: "TestActivity", indexKey: "taskId", value: "t1" }),
      loader.load({ modelName: "TestActivity", indexKey: "taskId", value: "t1" }),
    ]);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(receivedQueries).toHaveLength(1);
    // All three waiters see the same record set.
    expect(r1.map((r) => r.id)).toEqual(["a1"]);
    expect(r2).toEqual(r1);
    expect(r3).toEqual(r1);
  });

  it("propagates the fetcher's error to every waiter", async () => {
    const error = new Error("network down");
    const fetcher = vi.fn(async () => {
      throw error;
    });
    const loader = new BatchModelLoader(fetcher);

    const results = await Promise.allSettled([
      loader.load({ modelName: "X", indexKey: "k", value: "v1" }),
      loader.load({ modelName: "X", indexKey: "k", value: "v2" }),
    ]);

    expect(results.every((r) => r.status === "rejected")).toBe(true);
    for (const r of results) {
      if (r.status === "rejected") {
        expect(r.reason).toBe(error);
      }
    }
  });
});

describe("StoreManager wiring with onDemandIndexBatchFetcher", () => {
  it("routes loadCollection through BatchModelLoader when configured", async () => {
    const adapter = new MemoryAdapter();
    const batchFetcher = vi.fn(async () => ({
      TestActivity: [
        { id: "a1", taskId: "t1", text: "x" },
        { id: "a2", taskId: "t2", text: "y" },
      ],
    }));

    manager = new StoreManager({
      workspaceId: crypto.randomUUID(),
      bootstrapFetcher: vi.fn().mockResolvedValue({
        lastSyncId: 0,
        subscribedSyncGroups: [],
        models: {},
      }),
      onDemandIndexBatchFetcher: batchFetcher,
      storageAdapter: adapter,
    });
    await manager.bootstrap();

    const [t1, t2] = await Promise.all([
      manager.loadCollection("TestActivity", "taskId", "t1"),
      manager.loadCollection("TestActivity", "taskId", "t2"),
    ]);

    expect(batchFetcher).toHaveBeenCalledTimes(1);
    expect(t1.map((m) => m.id)).toEqual(["a1"]);
    expect(t2.map((m) => m.id)).toEqual(["a2"]);
  });

  it("falls back to onDemandFetcher when no batch fetcher is configured", async () => {
    const adapter = new MemoryAdapter();
    const fetcher = vi.fn(async (modelName, indexKey, value) => [
      { id: "a1", [indexKey]: value, text: "fallback" },
    ]);

    manager = new StoreManager({
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

    await manager.loadCollection("TestActivity", "taskId", "t1");
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith("TestActivity", "taskId", "t1");
  });
});
