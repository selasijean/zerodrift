/**
 * Tests for activateSyncGroup() and deactivateSyncGroup() on StoreManager.
 *
 * These methods let the app programmatically add/remove sync group subscriptions
 * at runtime. deactivateSyncGroup fires `onSyncGroupDelete` (when configured)
 * after dropping the group from meta — that callback is the adopter's hook to
 * evict pool/IDB records via sm.evictByIndex / sm.evictWhere or manual cleanup.
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  type MockedFunction,
} from "vitest";
import { makeStoreManager } from "./helpers/storeManager";
import { StoreManager } from "@zerodrift/StoreManager";
import { MemoryAdapter } from "@zerodrift/MemoryAdapter";
import { BaseModel } from "@zerodrift/BaseModel";
import type { SSEClientFactory } from "@zerodrift/SyncConnection";
import { TestLayeredDriver, TestLayeredAccount, addToPool } from "./fixtures";
import {
  controllableSSEClient,
  makeFactory,
  sendMessage,
} from "./helpers/sseClient";

// ── helpers ───────────────────────────────────────────────────────────────────

/** Mock shape used by tests: invoked when bootstrapFetcher is called with syncGroups. */
type SyncGroupFetcher = (
  groups: string[],
  options?: unknown,
) => Promise<Record<string, Record<string, unknown>[]>>;

/**
 * Build a StoreManager backed by MemoryAdapter. The optional `syncGroupFetcher`
 * is wired into the bootstrapFetcher: when bootstrap is called with
 * `options.syncGroups`, this returns the records it produces; otherwise empty.
 */
async function makeManager(
  opts: {
    syncGroupFetcher?: MockedFunction<SyncGroupFetcher>;
    initialGroups?: string[];
    syncUrl?: string;
    sseClientFactory?: SSEClientFactory;
    onSyncGroupDelete?: (
      groupId: string,
      sm: StoreManager,
    ) => void | Promise<void>;
    bootstrap?: boolean;
  } = {},
) {
  const adapter = new MemoryAdapter();
  const bootstrapFetcher = vi
    .fn()
    .mockImplementation(async (_type, options) => {
      if (options?.syncGroups != null && opts.syncGroupFetcher != null) {
        const models = await opts.syncGroupFetcher(options.syncGroups, options);
        return { lastSyncId: 0, subscribedSyncGroups: [], models };
      }
      return {
        lastSyncId: 0,
        subscribedSyncGroups: opts.initialGroups ?? [],
        models: {},
      };
    });
  const manager = makeStoreManager({
    workspaceId: crypto.randomUUID(),
    bootstrapFetcher,
    storageAdapter: adapter,
    syncUrl: opts.syncUrl,
    sseClientFactory: opts.sseClientFactory,
    onSyncGroupDelete: opts.onSyncGroupDelete,
  });
  if (opts.bootstrap === true) {
    await manager.bootstrap();
  } else {
    await manager.database.connect();
    await manager.database.saveMeta({
      lastSyncId: 0,
      subscribedSyncGroups: opts.initialGroups ?? [],
      schemaHash: "test",
      dbVersion: 1,
      backendDatabaseVersion: 0,
    });
  }
  return manager;
}

/** Seed pool + IDB with records for a layer-scoped model. */
async function seedLayered<T extends BaseModel>(
  manager: StoreManager,
  Ctor: new () => T,
  layerId: string,
  ids: string[],
  extra: (id: string) => Record<string, unknown>,
) {
  const modelName = Ctor.name;
  for (const id of ids) {
    const record = { id, layerId, ...extra(id) };
    const instance = new Ctor();
    instance.hydrate(record);
    addToPool(manager, modelName, instance);
    await manager.database.writeModels(modelName, [record]);
  }
}

const seedLayer = (manager: StoreManager, layerId: string, ids: string[]) =>
  seedLayered(manager, TestLayeredDriver, layerId, ids, (id) => ({
    name: `Driver ${id}`,
  }));

const seedAccount = (manager: StoreManager, layerId: string, ids: string[]) =>
  seedLayered(manager, TestLayeredAccount, layerId, ids, (id) => ({
    label: `Account ${id}`,
  }));

/** Factory that records every URL it's called with and returns a no-op client. */
function recordingSSEFactory(): { factory: SSEClientFactory; urls: string[] } {
  const urls: string[] = [];
  const factory: SSEClientFactory = (url) => {
    urls.push(url);
    return { onmessage: null, onerror: null, close: vi.fn() };
  };
  return { factory, urls };
}

// ── setup / teardown ──────────────────────────────────────────────────────────

let manager: StoreManager;

beforeEach(() => {
  BaseModel.storeManager = null;
});

afterEach(async () => {
  await manager?.teardown();
  BaseModel.storeManager = null;
});

// ── activateSyncGroup() ───────────────────────────────────────────────────────

describe("activateSyncGroup()", () => {
  it("calls syncGroupFetcher with the given groupId", async () => {
    const syncGroupFetcher = vi.fn().mockResolvedValue({});
    manager = await makeManager({ syncGroupFetcher });

    await manager.activateSyncGroup("layer-A");

    expect(syncGroupFetcher).toHaveBeenCalledWith(
      ["layer-A"],
      expect.objectContaining({ currentMeta: expect.anything() }),
    );
  });

  it("writes fetched records to IDB", async () => {
    const syncGroupFetcher = vi.fn().mockResolvedValue({
      TestLayeredDriver: [
        { id: "d1", layerId: "layer-A", name: "Alpha" },
        { id: "d2", layerId: "layer-A", name: "Beta" },
      ],
    });
    manager = await makeManager({ syncGroupFetcher });

    await manager.activateSyncGroup("layer-A");

    expect(
      await manager.database.readModel("TestLayeredDriver", "d1"),
    ).toMatchObject({ id: "d1", name: "Alpha" });
    expect(
      await manager.database.readModel("TestLayeredDriver", "d2"),
    ).toMatchObject({ id: "d2", name: "Beta" });
  });

  it("hydrates Instant models into the pool", async () => {
    const syncGroupFetcher = vi.fn().mockResolvedValue({
      TestLayeredDriver: [{ id: "d1", layerId: "layer-A", name: "Alpha" }],
    });
    manager = await makeManager({ syncGroupFetcher });

    await manager.activateSyncGroup("layer-A");

    expect(manager.objectPool.getById("TestLayeredDriver", "d1")).toBeDefined();
  });

  it("updates an existing pool model rather than creating a duplicate", async () => {
    const syncGroupFetcher = vi.fn().mockResolvedValue({
      TestLayeredDriver: [{ id: "d1", layerId: "layer-A", name: "Updated" }],
    });
    manager = await makeManager({ syncGroupFetcher });

    // Pre-populate pool with stale data
    const existing = new TestLayeredDriver();
    existing.hydrate({ id: "d1", layerId: "layer-A", name: "Stale" });
    addToPool(manager, "TestLayeredDriver", existing);

    await manager.activateSyncGroup("layer-A");

    const poolModel = manager.objectPool.getById(
      "TestLayeredDriver",
      "d1",
    ) as TestLayeredDriver;
    expect(poolModel).toBeDefined();
    expect(poolModel.name).toBe("Updated");
    // Same instance — no duplicate
    expect(poolModel).toBe(existing);
  });

  it("adds the groupId to meta.subscribedSyncGroups", async () => {
    const syncGroupFetcher = vi.fn().mockResolvedValue({});
    manager = await makeManager({
      syncGroupFetcher,
      initialGroups: ["layer-B"],
    });

    await manager.activateSyncGroup("layer-A");

    expect(manager.database.currentMeta?.subscribedSyncGroups).toContain(
      "layer-A",
    );
    expect(manager.database.currentMeta?.subscribedSyncGroups).toContain(
      "layer-B",
    );
  });

  it("is a no-op if the group is already subscribed", async () => {
    const syncGroupFetcher = vi.fn().mockResolvedValue({});
    manager = await makeManager({
      syncGroupFetcher,
      initialGroups: ["layer-A"],
    });

    await manager.activateSyncGroup("layer-A");
    await manager.activateSyncGroup("layer-A");

    expect(syncGroupFetcher).not.toHaveBeenCalled();
  });

  it("does not duplicate the groupId in meta when activated once", async () => {
    const syncGroupFetcher = vi.fn().mockResolvedValue({});
    manager = await makeManager({ syncGroupFetcher });

    await manager.activateSyncGroup("layer-A");

    const groups = manager.database.currentMeta?.subscribedSyncGroups ?? [];
    expect(groups.filter((g) => g === "layer-A")).toHaveLength(1);
  });

  it("reconnects SSE with the activated group in the URL", async () => {
    const { factory, urls } = recordingSSEFactory();

    manager = makeStoreManager({
      workspaceId: crypto.randomUUID(),
      bootstrapFetcher: vi.fn().mockResolvedValue({
        lastSyncId: 0,
        subscribedSyncGroups: [],
        models: {},
      }),
      syncUrl: "http://test/events",
      sseClientFactory: factory,
    });
    await manager.bootstrap();

    const urlsBefore = urls.length;
    await manager.activateSyncGroup("layer-A");

    // A new SSE connection should have been opened after activation
    expect(urls.length).toBeGreaterThan(urlsBefore);
    expect(urls[urls.length - 1]).toContain("layer-A");
  });

  // Guards the contract documented in StoreManager.fetchSyncGroupModels:
  // dbMeta.lastSyncId is a global checkpoint across all subscribed groups.
  // A scoped fetch's lastSyncId only describes the requested groups, so
  // assigning it would let SSE skip events for *other* subscribed groups
  // — silent data loss. Don't advance it from a scoped fetch even when
  // the scoped response is "newer".
  it("does not advance dbMeta.lastSyncId when the scoped fetch returns a higher syncId", async () => {
    const adapter = new MemoryAdapter();
    const bootstrapFetcher = vi
      .fn()
      .mockImplementation(async (_type, options) => {
        if (options?.syncGroups != null) {
          return {
            lastSyncId: 1000,
            subscribedSyncGroups: [],
            models: {},
          };
        }
        return { lastSyncId: 500, subscribedSyncGroups: [], models: {} };
      });
    manager = makeStoreManager({
      workspaceId: crypto.randomUUID(),
      bootstrapFetcher,
      storageAdapter: adapter,
    });
    await manager.database.connect();
    await manager.database.saveMeta({
      lastSyncId: 500,
      subscribedSyncGroups: [],
      schemaHash: "test",
      dbVersion: 1,
      backendDatabaseVersion: 0,
    });

    await manager.activateSyncGroup("layer-A");

    expect(manager.database.currentMeta?.lastSyncId).toBe(500);
  });
});

// ── activateSyncGroup() — array input ────────────────────────────────────────

describe("activateSyncGroup() with array input", () => {
  it("activates multiple groups in one call", async () => {
    const syncGroupFetcher = vi.fn().mockResolvedValue({});
    manager = await makeManager({ syncGroupFetcher });

    await manager.activateSyncGroup(["layer-A", "layer-B"]);

    expect(manager.database.currentMeta?.subscribedSyncGroups).toContain(
      "layer-A",
    );
    expect(manager.database.currentMeta?.subscribedSyncGroups).toContain(
      "layer-B",
    );
  });

  it("calls syncGroupFetcher once with all new group IDs", async () => {
    const syncGroupFetcher = vi.fn().mockResolvedValue({});
    manager = await makeManager({ syncGroupFetcher });

    await manager.activateSyncGroup(["layer-A", "layer-B"]);

    expect(syncGroupFetcher).toHaveBeenCalledOnce();
    expect(syncGroupFetcher).toHaveBeenCalledWith(
      ["layer-A", "layer-B"],
      expect.anything(),
    );
  });

  it("skips already-subscribed IDs and only fetches new ones", async () => {
    const syncGroupFetcher = vi.fn().mockResolvedValue({});
    manager = await makeManager({
      syncGroupFetcher,
      initialGroups: ["layer-A"],
    });

    await manager.activateSyncGroup(["layer-A", "layer-B"]);

    expect(syncGroupFetcher).toHaveBeenCalledWith(
      ["layer-B"],
      expect.anything(),
    );
  });

  it("is a no-op if all IDs are already subscribed", async () => {
    const syncGroupFetcher = vi.fn().mockResolvedValue({});
    manager = await makeManager({
      syncGroupFetcher,
      initialGroups: ["layer-A", "layer-B"],
    });

    await manager.activateSyncGroup(["layer-A", "layer-B"]);

    expect(syncGroupFetcher).not.toHaveBeenCalled();
  });
});

// ── activateSyncGroup() — fetch: false ────────────────────────────────────────

describe("activateSyncGroup() with fetch: false", () => {
  it("subscribes without calling syncGroupFetcher", async () => {
    const syncGroupFetcher = vi.fn().mockResolvedValue({});
    manager = await makeManager({ syncGroupFetcher });

    await manager.activateSyncGroup("layer-A", { fetch: false });

    expect(syncGroupFetcher).not.toHaveBeenCalled();
    expect(manager.database.currentMeta?.subscribedSyncGroups).toContain(
      "layer-A",
    );
  });

  it("still reconnects SSE after subscribing", async () => {
    const { factory, urls } = recordingSSEFactory();
    manager = makeStoreManager({
      workspaceId: crypto.randomUUID(),
      bootstrapFetcher: vi.fn().mockResolvedValue({
        lastSyncId: 0,
        subscribedSyncGroups: [],
        models: {},
      }),
      syncUrl: "http://test/events",
      sseClientFactory: factory,
    });
    await manager.bootstrap();

    const urlsBefore = urls.length;
    await manager.activateSyncGroup("layer-A", { fetch: false });

    expect(urls.length).toBeGreaterThan(urlsBefore);
    expect(urls[urls.length - 1]).toContain("layer-A");
  });
});

// ── activateSyncGroup() — ephemeral: true ─────────────────────────────────────

describe("activateSyncGroup() with ephemeral: true", () => {
  it("hydrates models into the pool and writes to IDB as usual", async () => {
    const syncGroupFetcher = vi.fn().mockResolvedValue({
      TestLayeredDriver: [{ id: "d1", layerId: "layer-A", name: "Alpha" }],
    });
    manager = await makeManager({ syncGroupFetcher });

    await manager.activateSyncGroup("layer-A", { ephemeral: true });

    expect(manager.objectPool.getById("TestLayeredDriver", "d1")).toBeDefined();
    expect(
      await manager.database.readModel("TestLayeredDriver", "d1"),
    ).toMatchObject({ id: "d1", name: "Alpha" });
  });

  it("adds the group to in-memory meta but does not call saveMeta", async () => {
    const syncGroupFetcher = vi.fn().mockResolvedValue({});
    manager = await makeManager({ syncGroupFetcher });

    const saveMetaSpy = vi.spyOn(manager.database, "saveMeta");

    await manager.activateSyncGroup("layer-A", { ephemeral: true });

    // In-memory meta has the group
    expect(manager.database.currentMeta?.subscribedSyncGroups).toContain(
      "layer-A",
    );
    // saveMeta was not called
    expect(saveMetaSpy).not.toHaveBeenCalled();
  });

  it("still reconnects SSE with the group in the URL", async () => {
    const { factory, urls } = recordingSSEFactory();

    manager = makeStoreManager({
      workspaceId: crypto.randomUUID(),
      bootstrapFetcher: vi.fn().mockResolvedValue({
        lastSyncId: 0,
        subscribedSyncGroups: [],
        models: {},
      }),
      syncUrl: "http://test/events",
      sseClientFactory: factory,
    });
    await manager.bootstrap();

    const urlsBefore = urls.length;
    await manager.activateSyncGroup("layer-A", { ephemeral: true });

    expect(urls.length).toBeGreaterThan(urlsBefore);
    expect(urls[urls.length - 1]).toContain("layer-A");
  });

  it("deactivate clears the ephemeral group from meta", async () => {
    const syncGroupFetcher = vi.fn().mockResolvedValue({});
    manager = await makeManager({ syncGroupFetcher });

    await manager.activateSyncGroup("layer-A", { ephemeral: true });
    expect(manager.database.currentMeta?.subscribedSyncGroups).toContain(
      "layer-A",
    );

    await manager.deactivateSyncGroup("layer-A");
    expect(manager.database.currentMeta?.subscribedSyncGroups).not.toContain(
      "layer-A",
    );
  });
});

// ── deactivateSyncGroup() ─────────────────────────────────────────────────────

describe("deactivateSyncGroup()", () => {
  it("removes the groupId from meta.subscribedSyncGroups", async () => {
    manager = await makeManager({ initialGroups: ["layer-A", "layer-B"] });

    await manager.deactivateSyncGroup("layer-A");

    expect(manager.database.currentMeta?.subscribedSyncGroups).not.toContain(
      "layer-A",
    );
    expect(manager.database.currentMeta?.subscribedSyncGroups).toContain(
      "layer-B",
    );
  });

  it("does not evict already-loaded data — eviction is the caller's responsibility", async () => {
    manager = await makeManager({ initialGroups: ["layer-A"] });
    await seedLayer(manager, "layer-A", ["d1"]);

    await manager.deactivateSyncGroup("layer-A");

    expect(manager.objectPool.getById("TestLayeredDriver", "d1")).toBeDefined();
    expect(
      await manager.database.readModel("TestLayeredDriver", "d1"),
    ).not.toBeNull();
  });

  it("is a no-op if the group is not currently subscribed", async () => {
    manager = await makeManager({ initialGroups: [] });
    await seedLayer(manager, "layer-A", ["d1"]);

    await expect(manager.deactivateSyncGroup("layer-A")).resolves.not.toThrow();
    expect(manager.objectPool.getById("TestLayeredDriver", "d1")).toBeDefined();
  });

  it("reconnects SSE without the deactivated group in the URL", async () => {
    const { factory, urls } = recordingSSEFactory();

    manager = makeStoreManager({
      workspaceId: crypto.randomUUID(),
      bootstrapFetcher: vi.fn().mockResolvedValue({
        lastSyncId: 0,
        subscribedSyncGroups: ["layer-A"],
        models: {},
      }),
      syncUrl: "http://test/events",
      sseClientFactory: factory,
    });
    await manager.bootstrap();

    const urlsBefore = urls.length;
    await manager.deactivateSyncGroup("layer-A");

    expect(urls.length).toBeGreaterThan(urlsBefore);
    expect(urls[urls.length - 1]).not.toContain("layer-A");
  });
});

// ── deactivateSyncGroup() — array input ──────────────────────────────────────

describe("deactivateSyncGroup() with array input", () => {
  it("deactivates multiple groups in one call", async () => {
    manager = await makeManager({ initialGroups: ["layer-A", "layer-B"] });

    await manager.deactivateSyncGroup(["layer-A", "layer-B"]);

    expect(manager.database.currentMeta?.subscribedSyncGroups).toHaveLength(0);
  });

  it("only deactivates the specified groups", async () => {
    manager = await makeManager({
      initialGroups: ["layer-A", "layer-B", "layer-C"],
    });

    await manager.deactivateSyncGroup(["layer-A", "layer-B"]);

    expect(manager.database.currentMeta?.subscribedSyncGroups).toEqual([
      "layer-C",
    ]);
  });

  it("skips IDs that are not currently subscribed", async () => {
    manager = await makeManager({ initialGroups: ["layer-A"] });

    await expect(
      manager.deactivateSyncGroup(["layer-A", "layer-X"]),
    ).resolves.not.toThrow();

    expect(manager.database.currentMeta?.subscribedSyncGroups).toEqual([]);
  });
});

// ── activate → deactivate → reactivate roundtrip ──────────────────────────────

describe("activate → deactivate → reactivate roundtrip", () => {
  it("re-fetches models from the server after reactivation", async () => {
    const syncGroupFetcher = vi.fn().mockResolvedValue({
      TestLayeredDriver: [{ id: "d1", layerId: "layer-A", name: "Driver" }],
    });
    manager = await makeManager({ syncGroupFetcher });

    await manager.activateSyncGroup("layer-A");
    expect(manager.objectPool.getById("TestLayeredDriver", "d1")).toBeDefined();

    await manager.deactivateSyncGroup("layer-A");
    await manager.activateSyncGroup("layer-A");

    // Fetcher called on first activate and again after reactivation
    expect(syncGroupFetcher).toHaveBeenCalledTimes(2);
  });
});

// ── evictByIndex / evictWhere ─────────────────────────────────────────────────

describe("evictByIndex()", () => {
  it("removes pool + IDB records matching the index value", async () => {
    manager = await makeManager({ initialGroups: ["layer-A", "layer-B"] });
    await seedLayer(manager, "layer-A", ["d1", "d2"]);
    await seedLayer(manager, "layer-B", ["d3"]);

    await manager.evictByIndex("TestLayeredDriver", "layerId", "layer-A");

    expect(
      manager.objectPool.getById("TestLayeredDriver", "d1"),
    ).toBeUndefined();
    expect(
      manager.objectPool.getById("TestLayeredDriver", "d2"),
    ).toBeUndefined();
    expect(manager.objectPool.getById("TestLayeredDriver", "d3")).toBeDefined();
    expect(
      await manager.database.readModel("TestLayeredDriver", "d1"),
    ).toBeNull();
    expect(
      await manager.database.readModel("TestLayeredDriver", "d3"),
    ).not.toBeNull();
  });

  it("with { keepInDb: true } releases the pool but leaves IDB rows intact", async () => {
    manager = await makeManager({ initialGroups: ["layer-A"] });
    await seedLayer(manager, "layer-A", ["d1", "d2"]);

    await manager.evictByIndex("TestLayeredDriver", "layerId", "layer-A", {
      keepInDb: true,
    });

    // Pool released…
    expect(
      manager.objectPool.getById("TestLayeredDriver", "d1"),
    ).toBeUndefined();
    expect(
      manager.objectPool.getById("TestLayeredDriver", "d2"),
    ).toBeUndefined();
    // …but the persistent copy stays, so a switch back rehydrates from IDB.
    expect(
      await manager.database.readModel("TestLayeredDriver", "d1"),
    ).not.toBeNull();
    expect(
      await manager.database.readModel("TestLayeredDriver", "d2"),
    ).not.toBeNull();
  });
});

describe("evictAllByIndex()", () => {
  it("evicts matching pool + IDB records across every model declaring the index", async () => {
    manager = await makeManager({ initialGroups: ["layer-A", "layer-B"] });
    await seedLayer(manager, "layer-A", ["d1", "d2"]);
    await seedLayer(manager, "layer-B", ["d3"]);
    await seedAccount(manager, "layer-A", ["a1", "a2"]);
    await seedAccount(manager, "layer-B", ["a3"]);

    await manager.evictAllByIndex("layerId", "layer-A");

    // layer-A rows gone from both pools and both IDB stores.
    expect(
      manager.objectPool.getById("TestLayeredDriver", "d1"),
    ).toBeUndefined();
    expect(
      manager.objectPool.getById("TestLayeredDriver", "d2"),
    ).toBeUndefined();
    expect(
      manager.objectPool.getById("TestLayeredAccount", "a1"),
    ).toBeUndefined();
    expect(
      manager.objectPool.getById("TestLayeredAccount", "a2"),
    ).toBeUndefined();
    expect(
      await manager.database.readModel("TestLayeredDriver", "d1"),
    ).toBeNull();
    expect(
      await manager.database.readModel("TestLayeredAccount", "a1"),
    ).toBeNull();

    // layer-B rows untouched.
    expect(manager.objectPool.getById("TestLayeredDriver", "d3")).toBeDefined();
    expect(
      manager.objectPool.getById("TestLayeredAccount", "a3"),
    ).toBeDefined();
    expect(
      await manager.database.readModel("TestLayeredDriver", "d3"),
    ).not.toBeNull();
    expect(
      await manager.database.readModel("TestLayeredAccount", "a3"),
    ).not.toBeNull();
  });

  it("is a no-op when no registered model declares the indexKey", async () => {
    manager = await makeManager();
    await seedLayer(manager, "layer-A", ["d1"]);

    // No model has a `mysteryField` indexed property — nothing happens.
    await expect(
      manager.evictAllByIndex("mysteryField", "anything"),
    ).resolves.toBeUndefined();

    expect(manager.objectPool.getById("TestLayeredDriver", "d1")).toBeDefined();
  });
});

describe("evictWhere()", () => {
  it("removes pool + IDB records matching the predicate and reports the count", async () => {
    manager = await makeManager({ initialGroups: ["layer-A"] });
    await seedLayer(manager, "layer-A", ["d1", "d2", "d3"]);

    const count = await manager.evictWhere(
      "TestLayeredDriver",
      (m) => m.id === "d1" || m.id === "d3",
    );

    // Pool walk + IDB walk both match d1/d3 → counted twice (sum of both passes).
    expect(count).toBe(4);
    expect(
      manager.objectPool.getById("TestLayeredDriver", "d1"),
    ).toBeUndefined();
    expect(manager.objectPool.getById("TestLayeredDriver", "d2")).toBeDefined();
    expect(
      manager.objectPool.getById("TestLayeredDriver", "d3"),
    ).toBeUndefined();
    expect(
      await manager.database.readModel("TestLayeredDriver", "d1"),
    ).toBeNull();
    expect(
      await manager.database.readModel("TestLayeredDriver", "d2"),
    ).not.toBeNull();
  });

  it("with { keepInDb: true } counts only pool removals and keeps IDB rows", async () => {
    manager = await makeManager({ initialGroups: ["layer-A"] });
    await seedLayer(manager, "layer-A", ["d1", "d2", "d3"]);

    const count = await manager.evictWhere(
      "TestLayeredDriver",
      (m) => m.id === "d1" || m.id === "d3",
      { keepInDb: true },
    );

    // Pool-only pass: d1/d3 counted once each, no IDB walk.
    expect(count).toBe(2);
    expect(
      manager.objectPool.getById("TestLayeredDriver", "d1"),
    ).toBeUndefined();
    expect(manager.objectPool.getById("TestLayeredDriver", "d2")).toBeDefined();
    expect(
      await manager.database.readModel("TestLayeredDriver", "d1"),
    ).not.toBeNull();
    expect(
      await manager.database.readModel("TestLayeredDriver", "d3"),
    ).not.toBeNull();
  });
});

// ── onSyncGroupDelete ─────────────────────────────────────────────────────────

describe("onSyncGroupDelete", () => {
  it("fires once per group when deactivateSyncGroup is called by the user", async () => {
    const onSyncGroupDelete = vi.fn();
    manager = await makeManager({
      initialGroups: ["layer-A", "layer-B"],
      onSyncGroupDelete,
    });

    await manager.deactivateSyncGroup(["layer-A", "layer-B"]);

    expect(onSyncGroupDelete).toHaveBeenCalledTimes(2);
    expect(onSyncGroupDelete).toHaveBeenCalledWith("layer-A", manager);
    expect(onSyncGroupDelete).toHaveBeenCalledWith("layer-B", manager);
  });

  it("is not called for already-unsubscribed groups", async () => {
    const onSyncGroupDelete = vi.fn();
    manager = await makeManager({ onSyncGroupDelete });

    await manager.deactivateSyncGroup("layer-A");

    expect(onSyncGroupDelete).not.toHaveBeenCalled();
  });

  it("fires when an SSE delta packet carries removedSyncGroups", async () => {
    const onSyncGroupDelete = vi.fn();
    const sseClient = controllableSSEClient();
    manager = await makeManager({
      initialGroups: ["layer-A"],
      syncUrl: "http://test/events",
      sseClientFactory: makeFactory(sseClient),
      onSyncGroupDelete,
      bootstrap: true,
    });

    sendMessage(sseClient, {
      syncActions: [],
      removedSyncGroups: ["layer-A"],
    });

    await vi.waitFor(() => expect(onSyncGroupDelete).toHaveBeenCalledTimes(1));
    expect(onSyncGroupDelete).toHaveBeenCalledWith("layer-A", manager);
  });
});
