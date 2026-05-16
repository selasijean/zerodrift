/**
 * The get-or-load family on `StoreManager` — pool-first lookups with on-
 * demand fetch fallback. All generic over `T extends BaseModel`.
 *
 *   getOrLoadById(modelName, id)
 *   getOrLoadCollection(modelName, indexKey, value)
 *   getOrLoadAll(modelName, { syncGroups? })
 *
 * The first three are the pool-first single-id, bulk-id, and indexed-
 * collection lookups. The fourth triggers a Full bootstrap fetch for the
 * model (optionally scoped to
 * sync groups), tracks coverage in `partialIndexCoverage` under the `"*"`
 * sentinel `indexKey`, and reuses the cache on subsequent same-scope calls.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeStoreManager } from "./helpers/storeManager";
import { StoreManager } from "@sync-engine/StoreManager";
import { MemoryAdapter } from "@sync-engine/MemoryAdapter";
import { BaseModel } from "@sync-engine/BaseModel";
import { ModelRegistry } from "@sync-engine/ModelRegistry";
import { TestActivity, TestNote } from "./fixtures";

let manager: StoreManager;

beforeEach(() => {
  BaseModel.storeManager = null;
});

afterEach(async () => {
  await manager?.teardown();
  BaseModel.storeManager = null;
});

describe("StoreManager.getOrLoad family", () => {
  it("getOrLoadById is generic and returns a typed model", async () => {
    const adapter = new MemoryAdapter();
    const fetcher = vi
      .fn()
      .mockResolvedValue([{ id: "n1", content: "hello", taskId: "t1" }]);
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

    const note = await manager.getOrLoadById<TestNote>("TestNote", "n1");
    expect(note?.id).toBe("n1");
    expect(note?.content).toBe("hello");
  });

  it("getOrLoadByIds is generic and bulk-fetches missing ids in one call", async () => {
    // Verifies the bulk path: pool-first, IDB next, then a single
    // `onDemandBatchFetcher` call for the still-missing subset (one
    // server request instead of N).
    const adapter = new MemoryAdapter();
    const batchFetcher = vi
      .fn()
      .mockResolvedValue([
        { id: "n1", content: "one", taskId: "t1" },
        { id: "n2", content: "two", taskId: "t1" },
        { id: "n3", content: "three", taskId: "t1" },
      ]);
    manager = makeStoreManager({
      workspaceId: crypto.randomUUID(),
      bootstrapFetcher: vi.fn().mockResolvedValue({
        lastSyncId: 0,
        subscribedSyncGroups: [],
        models: {},
      }),
      onDemandBatchFetcher: batchFetcher,
      storageAdapter: adapter,
    });
    await manager.bootstrap();

    const notes = await manager.getOrLoadByIds<TestNote>("TestNote", [
      "n1",
      "n2",
      "n3",
    ]);
    expect(notes.map((n) => n.id).sort()).toEqual(["n1", "n2", "n3"]);
    expect(batchFetcher).toHaveBeenCalledTimes(1);
    expect(batchFetcher.mock.calls[0]).toEqual([
      "TestNote",
      ["n1", "n2", "n3"],
    ]);
  });

  it("getOrLoadCollection is generic and returns a typed collection", async () => {
    const adapter = new MemoryAdapter();
    const fetcher = vi
      .fn()
      .mockResolvedValue([{ id: "a1", taskId: "t1", text: "x" }]);
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

    const items = await manager.getOrLoadCollection<TestActivity>(
      "TestActivity",
      "taskId",
      "t1",
    );
    expect(items.map((a) => a.id)).toEqual(["a1"]);
  });
});

describe("StoreManager.getOrLoadAll", () => {
  it("returns pool contents for Instant models without a server hit", async () => {
    const adapter = new MemoryAdapter();
    const bootstrap = vi.fn().mockResolvedValue({
      lastSyncId: 0,
      subscribedSyncGroups: [],
      models: { TestNote: [{ id: "n1", content: "x", taskId: "t1" }] },
    });
    manager = makeStoreManager({
      workspaceId: crypto.randomUUID(),
      bootstrapFetcher: bootstrap,
      storageAdapter: adapter,
    });
    await manager.bootstrap();
    bootstrap.mockClear();

    const notes = await manager.getOrLoadAll<TestNote>("TestNote");
    expect(notes.map((n) => n.id)).toEqual(["n1"]);
    // No additional bootstrap call — Instant models are already loaded.
    expect(bootstrap).not.toHaveBeenCalled();
  });

  it("issues a Full fetch for Lazy/Partial models on first call, caches on second", async () => {
    const adapter = new MemoryAdapter();
    const bootstrap = vi.fn(async (_type, options) => {
      const models: Record<string, Record<string, unknown>[]> = options?.onlyModels?.includes(
        "TestActivity",
      )
        ? {
            TestActivity: [
              { id: "a1", taskId: "t1", text: "x" },
              { id: "a2", taskId: "t2", text: "y" },
            ],
          }
        : {};
      return { lastSyncId: 0, subscribedSyncGroups: [] as string[], models };
    });
    manager = makeStoreManager({
      workspaceId: crypto.randomUUID(),
      bootstrapFetcher: bootstrap,
      storageAdapter: adapter,
    });
    await manager.bootstrap();
    bootstrap.mockClear();

    const first = await manager.getOrLoadAll<TestActivity>("TestActivity");
    expect(first.map((a) => a.id).sort()).toEqual(["a1", "a2"]);
    expect(bootstrap).toHaveBeenCalledTimes(1);
    expect(bootstrap.mock.calls[0][1]?.onlyModels).toEqual(["TestActivity"]);
    expect(bootstrap.mock.calls[0][1]?.syncGroups).toBeUndefined();

    // Second call hits cache — no second bootstrap fetch.
    const second = await manager.getOrLoadAll<TestActivity>("TestActivity");
    expect(second.map((a) => a.id).sort()).toEqual(["a1", "a2"]);
    expect(bootstrap).toHaveBeenCalledTimes(1);

    // The model now appears in `loadedModels` for SSE catchup-URL purposes.
    expect([...adapter.loadedModels]).toContain("TestActivity");
  });

  it("scopes the Full fetch by syncGroups when provided", async () => {
    const adapter = new MemoryAdapter();
    const bootstrap = vi.fn(async (_type, _options) => ({
      lastSyncId: 0,
      subscribedSyncGroups: [],
      models: {
        TestActivity: [{ id: "a-team-A", taskId: "t1", text: "x" }],
      },
    }));
    manager = makeStoreManager({
      workspaceId: crypto.randomUUID(),
      bootstrapFetcher: bootstrap,
      storageAdapter: adapter,
    });
    await manager.bootstrap();
    bootstrap.mockClear();

    await manager.getOrLoadAll<TestActivity>("TestActivity", {
      syncGroups: ["team-A"],
    });
    expect(bootstrap).toHaveBeenCalledTimes(1);
    expect(bootstrap.mock.calls[0][1]?.syncGroups).toEqual(["team-A"]);

    // Same scope hits cache.
    await manager.getOrLoadAll<TestActivity>("TestActivity", {
      syncGroups: ["team-A"],
    });
    expect(bootstrap).toHaveBeenCalledTimes(1);

    // Different scope re-fetches.
    await manager.getOrLoadAll<TestActivity>("TestActivity", {
      syncGroups: ["team-B"],
    });
    expect(bootstrap).toHaveBeenCalledTimes(2);
    expect(bootstrap.mock.calls[1][1]?.syncGroups).toEqual(["team-B"]);
  });

  it("encodes scope per-element so comma-bearing IDs don't collide", async () => {
    // `["a,b"]` and `["a", "b"]` would both `.join(",")` to `"a,b"`. The
    // engine encodes per-element (`encodeURIComponent`) before joining, so
    // `["a,b"]` becomes `"a%2Cb"` while `["a", "b"]` becomes `"a,b"` —
    // distinct cache keys.
    const adapter = new MemoryAdapter();
    const bootstrap = vi.fn(async (_type, _options) => ({
      lastSyncId: 0,
      subscribedSyncGroups: [] as string[],
      models: { TestActivity: [] as Record<string, unknown>[] },
    }));
    manager = makeStoreManager({
      workspaceId: crypto.randomUUID(),
      bootstrapFetcher: bootstrap,
      storageAdapter: adapter,
    });
    await manager.bootstrap();
    bootstrap.mockClear();

    await manager.getOrLoadAll<TestActivity>("TestActivity", {
      syncGroups: ["a,b"],
    });
    await manager.getOrLoadAll<TestActivity>("TestActivity", {
      syncGroups: ["a", "b"],
    });
    expect(bootstrap).toHaveBeenCalledTimes(2);
  });

  it("skips the IDB scan on cache-hit when the model was already hydrated this session", async () => {
    const adapter = new MemoryAdapter();
    const readSpy = vi.spyOn(adapter, "readAllModels");
    const bootstrap = vi.fn(async (_type, _options) => ({
      lastSyncId: 0,
      subscribedSyncGroups: [] as string[],
      models: {
        TestActivity: [{ id: "a1", taskId: "t1", text: "x" }],
      },
    }));
    manager = makeStoreManager({
      workspaceId: crypto.randomUUID(),
      bootstrapFetcher: bootstrap,
      storageAdapter: adapter,
    });
    await manager.bootstrap();
    readSpy.mockClear();

    // First call: fetches + hydrates from response.
    await manager.getOrLoadAll<TestActivity>("TestActivity");
    const firstReads = readSpy.mock.calls.length;

    // Second call: same scope, cache hit — should NOT re-read the IDB store.
    await manager.getOrLoadAll<TestActivity>("TestActivity");
    expect(readSpy.mock.calls.length).toBe(firstReads);
  });

  it("treats syncGroups as set-equal regardless of order", async () => {
    const adapter = new MemoryAdapter();
    const bootstrap = vi.fn(async (_type, _options) => ({
      lastSyncId: 0,
      subscribedSyncGroups: [] as string[],
      models: { TestActivity: [] as Record<string, unknown>[] },
    }));
    manager = makeStoreManager({
      workspaceId: crypto.randomUUID(),
      bootstrapFetcher: bootstrap,
      storageAdapter: adapter,
    });
    await manager.bootstrap();
    bootstrap.mockClear();

    await manager.getOrLoadAll<TestActivity>("TestActivity", {
      syncGroups: ["team-A", "team-B"],
    });
    await manager.getOrLoadAll<TestActivity>("TestActivity", {
      syncGroups: ["team-B", "team-A"],
    });
    // Same set, same coverage entry — only one server fetch.
    expect(bootstrap).toHaveBeenCalledTimes(1);
  });

  describe("in-flight delta merge", () => {
    it("preserves an SSE-delivered insert when the snapshot has older data for the same id", async () => {
      const adapter = new MemoryAdapter();
      const meta = ModelRegistry.getModelMeta("TestActivity")!;
      let bootstrapCallNum = 0;
      const bootstrap = vi.fn(async (_type, options) => {
        bootstrapCallNum++;
        // First call is the engine's own bootstrap (no `onlyModels`).
        if (!options?.onlyModels?.includes("TestActivity")) {
          return {
            lastSyncId: 0,
            subscribedSyncGroups: [] as string[],
            models: {} as Record<string, Record<string, unknown>[]>,
          };
        }
        // The getOrLoadAll fetch — simulate SSE arriving mid-flight by
        // performing the writes the SSE pipeline would do.
        await adapter.writeModels("TestActivity", [
          { id: "a-newer", taskId: "t1", text: "from-sse" },
        ]);
        manager.objectPool.hydrateAndPut("TestActivity", meta, {
          id: "a-newer",
          taskId: "t1",
          text: "from-sse",
        });
        return {
          lastSyncId: 1,
          subscribedSyncGroups: [] as string[],
          models: {
            TestActivity: [
              { id: "a-newer", taskId: "t1", text: "older-snapshot" },
              { id: "a-fresh", taskId: "t1", text: "fresh" },
            ],
          },
        };
      });
      manager = makeStoreManager({
        workspaceId: crypto.randomUUID(),
        bootstrapFetcher: bootstrap,
        storageAdapter: adapter,
      });
      await manager.bootstrap();

      const result =
        await manager.getOrLoadAll<TestActivity>("TestActivity");
      const byId = new Map(result.map((a) => [a.id, a]));

      // SSE-delivered version wins in the pool.
      expect(byId.get("a-newer")?.text).toBe("from-sse");
      // Snapshot-only records still hydrate normally.
      expect(byId.get("a-fresh")?.text).toBe("fresh");

      // IDB also keeps the SSE-newer copy.
      const stored = await adapter.readAllModels("TestActivity");
      const storedById = new Map(stored.map((r) => [r.id as string, r]));
      expect(storedById.get("a-newer")?.text).toBe("from-sse");
      expect(storedById.get("a-fresh")?.text).toBe("fresh");

      expect(bootstrapCallNum).toBe(2);
    });

    it("drops snapshot records whose id was deleted during the in-flight window", async () => {
      const adapter = new MemoryAdapter();
      const bootstrap = vi.fn(async (_type, options) => {
        if (!options?.onlyModels?.includes("TestActivity")) {
          return {
            lastSyncId: 0,
            subscribedSyncGroups: [] as string[],
            models: {} as Record<string, Record<string, unknown>[]>,
          };
        }
        // Simulate an SSE delete for `a-deleted` that arrived mid-flight:
        // IDB delete + tombstone via the public callback the SyncConnection
        // would call on a `D` action.
        await adapter.deleteModel("TestActivity", "a-deleted");
        manager.recordInflightDelete("TestActivity", "a-deleted");
        return {
          lastSyncId: 1,
          subscribedSyncGroups: [] as string[],
          models: {
            TestActivity: [
              { id: "a-deleted", taskId: "t1", text: "would-resurrect" },
              { id: "a-keep", taskId: "t1", text: "keep" },
            ],
          },
        };
      });
      manager = makeStoreManager({
        workspaceId: crypto.randomUUID(),
        bootstrapFetcher: bootstrap,
        storageAdapter: adapter,
      });
      await manager.bootstrap();

      const result =
        await manager.getOrLoadAll<TestActivity>("TestActivity");

      // The deleted record is not resurrected in the pool…
      expect(result.find((a) => a.id === "a-deleted")).toBeUndefined();
      expect(result.find((a) => a.id === "a-keep")?.text).toBe("keep");

      // …or in IDB.
      const stored = await adapter.readAllModels("TestActivity");
      const ids = stored.map((r) => r.id);
      expect(ids).not.toContain("a-deleted");
      expect(ids).toContain("a-keep");
    });

    it("admits SSE inserts to the pool while the fetch is in flight (isModelFullyLoaded flips early)", async () => {
      const adapter = new MemoryAdapter();
      const bootstrap = vi.fn(async (_type, options) => {
        if (!options?.onlyModels?.includes("TestActivity")) {
          return {
            lastSyncId: 0,
            subscribedSyncGroups: [] as string[],
            models: {} as Record<string, Record<string, unknown>[]>,
          };
        }
        // Mid-flight: the gate the SSE pipeline reads must already say true.
        expect(manager.isModelFullyLoaded("TestActivity")).toBe(true);
        return {
          lastSyncId: 1,
          subscribedSyncGroups: [] as string[],
          models: { TestActivity: [] },
        };
      });
      manager = makeStoreManager({
        workspaceId: crypto.randomUUID(),
        bootstrapFetcher: bootstrap,
        storageAdapter: adapter,
      });
      await manager.bootstrap();

      // Before the call, the gate is closed — Partial models don't admit
      // inserts unless something says otherwise.
      expect(manager.isModelFullyLoaded("TestActivity")).toBe(false);
      await manager.getOrLoadAll<TestActivity>("TestActivity");
      // After successful completion, the gate stays open via the persistent
      // `*`-coverage entry, not via the pending refcount.
      expect(manager.isModelFullyLoaded("TestActivity")).toBe(true);
    });

    it("dedupes concurrent calls for the same model+scope into one fetch", async () => {
      const adapter = new MemoryAdapter();
      const bootstrap = vi.fn(async (_type, options) => {
        if (!options?.onlyModels?.includes("TestActivity")) {
          return {
            lastSyncId: 0,
            subscribedSyncGroups: [] as string[],
            models: {} as Record<string, Record<string, unknown>[]>,
          };
        }
        return {
          lastSyncId: 1,
          subscribedSyncGroups: [] as string[],
          models: {
            TestActivity: [{ id: "a1", taskId: "t1", text: "x" }],
          },
        };
      });
      manager = makeStoreManager({
        workspaceId: crypto.randomUUID(),
        bootstrapFetcher: bootstrap,
        storageAdapter: adapter,
      });
      await manager.bootstrap();
      bootstrap.mockClear();

      const [a, b, c] = await Promise.all([
        manager.getOrLoadAll<TestActivity>("TestActivity"),
        manager.getOrLoadAll<TestActivity>("TestActivity"),
        manager.getOrLoadAll<TestActivity>("TestActivity"),
      ]);
      expect(a.map((x) => x.id)).toEqual(["a1"]);
      expect(b.map((x) => x.id)).toEqual(["a1"]);
      expect(c.map((x) => x.id)).toEqual(["a1"]);
      expect(bootstrap).toHaveBeenCalledTimes(1);
    });

    it("clears the pending refcount and tombstones after a failed fetch", async () => {
      const adapter = new MemoryAdapter();
      const fail = new Error("boom");
      const bootstrap = vi.fn(async (_type, options) => {
        if (!options?.onlyModels?.includes("TestActivity")) {
          return {
            lastSyncId: 0,
            subscribedSyncGroups: [] as string[],
            models: {} as Record<string, Record<string, unknown>[]>,
          };
        }
        manager.recordInflightDelete("TestActivity", "a-mid");
        throw fail;
      });
      manager = makeStoreManager({
        workspaceId: crypto.randomUUID(),
        bootstrapFetcher: bootstrap,
        storageAdapter: adapter,
      });
      await manager.bootstrap();

      await expect(
        manager.getOrLoadAll<TestActivity>("TestActivity"),
      ).rejects.toThrow("boom");

      // The gate must close again — coverage was never marked, and the
      // pending refcount must have decremented in the finally block.
      expect(manager.isModelFullyLoaded("TestActivity")).toBe(false);
    });
  });
});
