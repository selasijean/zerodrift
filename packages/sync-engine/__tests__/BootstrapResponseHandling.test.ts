/**
 * Tests for how StoreManager consumes BootstrapResponse fields:
 *   - `deletedIds` tombstones are evicted from IDB + pool on every consumer.
 *   - `subscribedSyncGroups` is append-only on fullBootstrap (never overwrites)
 *     and ignored on partialBootstrap (client is the source of truth there).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { StoreManager } from "@sync-engine/StoreManager";
import { BootstrapType } from "@sync-engine/Database";
import { MemoryAdapter } from "@sync-engine/MemoryAdapter";
import { BaseModel } from "@sync-engine/BaseModel";
import { TestTask } from "./fixtures";

let manager: StoreManager;

beforeEach(() => {
  BaseModel.storeManager = null;
});

afterEach(async () => {
  await manager?.teardown();
  BaseModel.storeManager = null;
});

// ── deletedIds eviction ──────────────────────────────────────────────────────

describe("deletedIds — fullBootstrap", () => {
  it("evicts tombstones from IDB and the in-memory pool", async () => {
    const adapter = new MemoryAdapter();
    const bootstrapFetcher = vi.fn().mockResolvedValue({
      lastSyncId: 5,
      subscribedSyncGroups: [],
      models: { TestTask: [{ id: "t-keep", title: "Kept" }] },
      deletedIds: { TestTask: ["t-gone"] },
    });

    manager = new StoreManager({
      workspaceId: crypto.randomUUID(),
      bootstrapFetcher,
      storageAdapter: adapter,
    });

    await manager.database.connect();
    await manager.database.writeModels("TestTask", [
      { id: "t-gone", title: "Stale from prior session" },
    ]);

    await manager.bootstrap();

    expect(
      await manager.database.readModel("TestTask", "t-keep"),
    ).not.toBeNull();
    expect(await manager.database.readModel("TestTask", "t-gone")).toBeNull();
    expect(manager.objectPool.getById("TestTask", "t-gone")).toBeUndefined();
  });
});

describe("deletedIds — partialBootstrap", () => {
  it("evicts tombstones reported in the delta", async () => {
    const adapter = new MemoryAdapter();
    const bootstrapFetcher = vi.fn().mockResolvedValue({
      lastSyncId: 100,
      subscribedSyncGroups: [],
      models: { TestTask: [{ id: "t-fresh", title: "From delta" }] },
      deletedIds: { TestTask: ["t-tombstone"] },
    });

    manager = new StoreManager({
      workspaceId: crypto.randomUUID(),
      bootstrapFetcher,
      storageAdapter: adapter,
    });

    await manager.database.connect();
    await manager.database.saveMeta({
      lastSyncId: 50,
      subscribedSyncGroups: [],
      schemaHash: "test",
      dbVersion: 1,
      backendDatabaseVersion: 0,
    });
    await manager.database.writeModels("TestTask", [
      { id: "t-tombstone", title: "Stale" },
    ]);
    const stale = new TestTask();
    stale.hydrate({ id: "t-tombstone", title: "Stale" });
    manager.objectPool.put("TestTask", stale);

    await manager.bootstrap();

    const [type] = bootstrapFetcher.mock.calls[0];
    expect(type).toBe(BootstrapType.Partial);

    expect(
      await manager.database.readModel("TestTask", "t-tombstone"),
    ).toBeNull();
    expect(
      manager.objectPool.getById("TestTask", "t-tombstone"),
    ).toBeUndefined();
  });
});

describe("deletedIds — fetchSyncGroupModels", () => {
  it("evicts tombstones returned by a scoped sync-group fetch", async () => {
    const adapter = new MemoryAdapter();
    const bootstrapFetcher = vi
      .fn()
      .mockImplementationOnce(async () => ({
        lastSyncId: 10,
        subscribedSyncGroups: [],
        models: {},
      }))
      .mockImplementationOnce(async () => ({
        lastSyncId: 12,
        subscribedSyncGroups: ["team-a"],
        models: { TestTask: [{ id: "t-fresh", title: "Fresh" }] },
        deletedIds: { TestTask: ["t-stale"] },
      }));

    manager = new StoreManager({
      workspaceId: crypto.randomUUID(),
      bootstrapFetcher,
      storageAdapter: adapter,
    });

    await manager.bootstrap();
    await manager.database.writeModels("TestTask", [
      { id: "t-stale", title: "Stale before scoped fetch" },
    ]);
    const stale = new TestTask();
    stale.hydrate({ id: "t-stale", title: "Stale" });
    manager.objectPool.put("TestTask", stale);

    await manager.activateSyncGroup("team-a");

    expect(await manager.database.readModel("TestTask", "t-stale")).toBeNull();
    expect(manager.objectPool.getById("TestTask", "t-stale")).toBeUndefined();
    expect(
      await manager.database.readModel("TestTask", "t-fresh"),
    ).not.toBeNull();
  });
});

describe("deletedIds — missing field is a no-op", () => {
  it("does not throw when deletedIds is absent", async () => {
    const adapter = new MemoryAdapter();
    const bootstrapFetcher = vi.fn().mockResolvedValue({
      lastSyncId: 1,
      subscribedSyncGroups: [],
      models: {},
    });

    manager = new StoreManager({
      workspaceId: crypto.randomUUID(),
      bootstrapFetcher,
      storageAdapter: adapter,
    });

    await expect(manager.bootstrap()).resolves.not.toThrow();
  });
});

// ── subscribedSyncGroups merge semantics ─────────────────────────────────────

describe("subscribedSyncGroups — fullBootstrap (first-time)", () => {
  it("seeds dbMeta.subscribedSyncGroups from the response", async () => {
    const adapter = new MemoryAdapter();
    const bootstrapFetcher = vi.fn().mockResolvedValue({
      lastSyncId: 5,
      subscribedSyncGroups: ["team-a", "team-b"],
      models: {},
    });

    manager = new StoreManager({
      workspaceId: crypto.randomUUID(),
      bootstrapFetcher,
      storageAdapter: adapter,
    });

    await manager.bootstrap();

    const meta = await manager.database.loadMeta();
    expect(meta!.subscribedSyncGroups.sort()).toEqual(["team-a", "team-b"]);
  });
});

describe("subscribedSyncGroups — fullBootstrap (re-bootstrap via schema mismatch)", () => {
  // When the server's backendDatabaseVersion differs from what's stored,
  // partialBootstrap detects the mismatch and falls through to fullBootstrap.
  // dbMeta is still intact at that point — we use it to test the merge.
  function setupForReBootstrap(
    existingGroups: string[],
    serverGroups: string[],
  ) {
    const adapter = new MemoryAdapter();
    const bootstrapFetcher = vi
      .fn()
      // First call: Partial with backendDatabaseVersion=1 forces a re-bootstrap
      .mockImplementationOnce(async () => ({
        lastSyncId: 100,
        subscribedSyncGroups: [],
        models: {},
        backendDatabaseVersion: 1,
      }))
      // Second call: Full with the server's reported subscriptions
      .mockImplementationOnce(async () => ({
        lastSyncId: 100,
        subscribedSyncGroups: serverGroups,
        models: {},
        backendDatabaseVersion: 1,
      }));

    const sm = new StoreManager({
      workspaceId: crypto.randomUUID(),
      bootstrapFetcher,
      storageAdapter: adapter,
    });
    return { sm, adapter, bootstrapFetcher, existingGroups };
  }

  it("merges response into existing set, never overwrites", async () => {
    const { sm } = setupForReBootstrap(
      ["team-b", "team-c"], // existing
      ["team-a"], // server reports only team-a
    );
    manager = sm;

    await manager.database.connect();
    await manager.database.saveMeta({
      lastSyncId: 50,
      subscribedSyncGroups: ["team-b", "team-c"],
      schemaHash: "test",
      dbVersion: 1,
      backendDatabaseVersion: 0,
    });

    await manager.bootstrap();

    const meta = await manager.database.loadMeta();
    expect(meta!.subscribedSyncGroups.sort()).toEqual([
      "team-a",
      "team-b",
      "team-c",
    ]);
  });

  it("dedupes when response and existing overlap", async () => {
    const { sm } = setupForReBootstrap(
      ["team-a", "team-c"],
      ["team-a", "team-b"],
    );
    manager = sm;

    await manager.database.connect();
    await manager.database.saveMeta({
      lastSyncId: 50,
      subscribedSyncGroups: ["team-a", "team-c"],
      schemaHash: "test",
      dbVersion: 1,
      backendDatabaseVersion: 0,
    });

    await manager.bootstrap();

    const meta = await manager.database.loadMeta();
    expect(meta!.subscribedSyncGroups.sort()).toEqual([
      "team-a",
      "team-b",
      "team-c",
    ]);
  });
});

// ── bootstrapSyncGroups hook ─────────────────────────────────────────────────

describe("bootstrapSyncGroups — config hook", () => {
  it("seeds dbMeta and passes the union as syncGroups to Phase 1", async () => {
    const adapter = new MemoryAdapter();
    const bootstrapFetcher = vi.fn().mockResolvedValue({
      lastSyncId: 5,
      subscribedSyncGroups: [],
      models: {},
    });

    manager = new StoreManager({
      workspaceId: crypto.randomUUID(),
      bootstrapFetcher,
      bootstrapSyncGroups: async () => ["team-a", "team-b"],
      storageAdapter: adapter,
    });

    await manager.bootstrap();

    const [type, opts] = bootstrapFetcher.mock.calls[0];
    expect(type).toBe(BootstrapType.Full);
    expect(opts.syncGroups?.sort()).toEqual(["team-a", "team-b"]);

    const meta = await manager.database.loadMeta();
    expect(meta!.subscribedSyncGroups.sort()).toEqual(["team-a", "team-b"]);
  });

  it("appends to existing dbMeta.subscribedSyncGroups (never shrinks)", async () => {
    const adapter = new MemoryAdapter();
    const bootstrapFetcher = vi.fn().mockResolvedValue({
      lastSyncId: 100,
      subscribedSyncGroups: [],
      models: {},
    });

    manager = new StoreManager({
      workspaceId: crypto.randomUUID(),
      bootstrapFetcher,
      // Hook returns a subset of what's persisted.
      bootstrapSyncGroups: async () => ["team-a"],
      storageAdapter: adapter,
    });

    await manager.database.connect();
    await manager.database.saveMeta({
      lastSyncId: 50,
      subscribedSyncGroups: ["team-b", "team-c"],
      schemaHash: "test",
      dbVersion: 1,
      backendDatabaseVersion: 0,
    });

    await manager.bootstrap();

    const opts = bootstrapFetcher.mock.calls[0][1];
    expect(opts.syncGroups?.sort()).toEqual(["team-a", "team-b", "team-c"]);

    const meta = await manager.database.loadMeta();
    expect(meta!.subscribedSyncGroups.sort()).toEqual([
      "team-a",
      "team-b",
      "team-c",
    ]);
  });

  it("does not pass syncGroups when hook returns empty and no persisted set", async () => {
    const adapter = new MemoryAdapter();
    const bootstrapFetcher = vi.fn().mockResolvedValue({
      lastSyncId: 0,
      subscribedSyncGroups: [],
      models: {},
    });

    manager = new StoreManager({
      workspaceId: crypto.randomUUID(),
      bootstrapFetcher,
      bootstrapSyncGroups: async () => [],
      storageAdapter: adapter,
    });

    await manager.bootstrap();

    const opts = bootstrapFetcher.mock.calls[0][1];
    expect(opts.syncGroups).toBeUndefined();
  });

  it("hook failure aborts bootstrap (fatal)", async () => {
    const adapter = new MemoryAdapter();
    const bootstrapFetcher = vi.fn().mockResolvedValue({
      lastSyncId: 0,
      subscribedSyncGroups: [],
      models: {},
    });

    manager = new StoreManager({
      workspaceId: crypto.randomUUID(),
      bootstrapFetcher,
      bootstrapSyncGroups: async () => {
        throw new Error("auth lookup failed");
      },
      storageAdapter: adapter,
    });

    await expect(manager.bootstrap()).rejects.toThrow("auth lookup failed");
    expect(bootstrapFetcher).not.toHaveBeenCalled();
  });
});

describe("subscribedSyncGroups — partialBootstrap", () => {
  it("ignores response.subscribedSyncGroups; client is source of truth", async () => {
    const adapter = new MemoryAdapter();
    const bootstrapFetcher = vi.fn().mockResolvedValue({
      lastSyncId: 100,
      subscribedSyncGroups: ["team-server-says"], // server's (stale?) view
      models: {},
    });

    manager = new StoreManager({
      workspaceId: crypto.randomUUID(),
      bootstrapFetcher,
      storageAdapter: adapter,
    });

    await manager.database.connect();
    await manager.database.saveMeta({
      lastSyncId: 50, // > 0 forces partialBootstrap path
      subscribedSyncGroups: ["team-client"],
      schemaHash: "test",
      dbVersion: 1,
      backendDatabaseVersion: 0,
    });

    await manager.bootstrap();

    const [type] = bootstrapFetcher.mock.calls[0];
    expect(type).toBe(BootstrapType.Partial);

    const meta = await manager.database.loadMeta();
    expect(meta!.subscribedSyncGroups).toEqual(["team-client"]);
  });
});
