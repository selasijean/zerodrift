/**
 * Tests for the eviction policy (Phases 1–3).
 *
 * Phase 1: Safety predicate (canEvict), observation tracking, eviction
 *          markers, batch eviction, self-heal.
 * Phase 2: Sync-group-leave via onSyncGroupDelete callback.
 * Phase 3: Resident-count watermark via maxResident.
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { StoreManager } from "@zerodrift/StoreManager";
import { MemoryAdapter } from "@zerodrift/MemoryAdapter";
import { BaseModel } from "@zerodrift/BaseModel";
import { ClientModel, Property } from "@zerodrift/decorators";
import { LoadStrategy } from "@zerodrift/types";
import { ModelRegistry } from "@zerodrift/ModelRegistry";
import { addToPool } from "./fixtures";

// ── Test-only model fixtures ────────────────────────────────────────────────
//
// These are Partial models with eviction config, separate from the shared
// fixtures (which are Eager and don't opt into eviction).

@ClientModel({
  name: "EvictableIssue",
  loadStrategy: LoadStrategy.Partial,
})
class EvictableIssue extends BaseModel {
  @Property()
  public title = "";

  @Property({ indexed: true })
  public teamId = "";
}

@ClientModel({
  name: "EvictableComment",
  loadStrategy: LoadStrategy.Partial,
})
class EvictableComment extends BaseModel {
  @Property()
  public body = "";

  @Property({ indexed: true })
  public teamId = "";
}

@ClientModel({
  name: "WatermarkItem",
  loadStrategy: LoadStrategy.Partial,
  eviction: { maxResident: 5 },
})
class WatermarkItem extends BaseModel {
  @Property()
  public label = "";
}

@ClientModel({
  name: "EphemeralColl",
  loadStrategy: LoadStrategy.Ephemeral,
})
class EphemeralColl extends BaseModel {
  @Property()
  public label = "";

  @Property({ indexed: true })
  public teamId = "";
}

// Eager with no eviction config — "always resident", exempt from a global cap.
@ClientModel({
  name: "EagerDefault",
  loadStrategy: LoadStrategy.Eager,
})
class EagerDefault extends BaseModel {
  @Property()
  public label = "";
}

// Eager that opts into eviction with an empty config — accepts the global cap.
@ClientModel({
  name: "EagerOptIn",
  loadStrategy: LoadStrategy.Eager,
  eviction: {},
})
class EagerOptIn extends BaseModel {
  @Property()
  public label = "";
}

@ClientModel({
  name: "NoEvictModel",
  loadStrategy: LoadStrategy.Partial,
  eviction: false,
})
class NoEvictModel extends BaseModel {
  @Property()
  public value = "";
}

// ── helpers ─────────────────────────────────────────────────────────────────

async function makeManager(opts: {
  eviction?: {
    maxResident?: number;
    lowWaterRatio?: number;
  };
  initialGroups?: string[];
  syncUrl?: string;
  onSyncGroupDelete?: (
    groupId: string,
    sm: StoreManager,
  ) => void | Promise<void>;
  onDemandFetcher?: (
    modelName: string,
    indexKey: string,
    value: string,
  ) => Promise<Record<string, unknown>[]>;
  bootstrap?: boolean;
} = {}) {
  const adapter = new MemoryAdapter();
  const bootstrapFetcher = vi.fn().mockResolvedValue({
    lastSyncId: 0,
    subscribedSyncGroups: opts.initialGroups ?? [],
    models: {},
  });
  const sm = new StoreManager({
    workspaceId: crypto.randomUUID(),
    transport: {
      bootstrapFetcher,
      syncUrl: opts.syncUrl,
    },
    persistence: { storageAdapter: adapter },
    hooks: { onSyncGroupDelete: opts.onSyncGroupDelete },
    loading:
      opts.onDemandFetcher != null
        ? { onDemand: { mode: "perKey", fetch: opts.onDemandFetcher } }
        : undefined,
    eviction: opts.eviction,
  });
  if (opts.bootstrap === true) {
    await sm.bootstrap();
  } else {
    await sm.database.connect();
    await sm.database.saveMeta({
      lastSyncId: 0,
      subscribedSyncGroups: opts.initialGroups ?? [],
      schemaHash: "test",
      dbVersion: 1,
      backendDatabaseVersion: 0,
    });
  }
  return sm;
}

function seedPool(
  sm: StoreManager,
  modelName: string,
  Ctor: new () => BaseModel,
  records: Record<string, unknown>[],
) {
  for (const data of records) {
    const inst = new Ctor();
    inst.hydrate(data);
    addToPool(sm, modelName, inst);
  }
}

async function seedPoolAndDb(
  sm: StoreManager,
  modelName: string,
  Ctor: new () => BaseModel,
  records: Record<string, unknown>[],
) {
  for (const data of records) {
    const inst = new Ctor();
    inst.hydrate(data);
    addToPool(sm, modelName, inst);
    await sm.database.writeModels(modelName, [data]);
  }
}

// ── setup / teardown ────────────────────────────────────────────────────────

let sm: StoreManager;

beforeEach(() => {
  BaseModel.storeManager = null;
});

afterEach(async () => {
  await sm?.teardown();
  BaseModel.storeManager = null;
});

// ═══════════════════════════════════════════════════════════════════════════
// Phase 1: Safety predicate + observation tracking + eviction markers
// ═══════════════════════════════════════════════════════════════════════════

describe("canEvict — safety predicate", () => {
  it("allows eviction of a clean, unobserved Partial record", async () => {
    sm = await makeManager();
    seedPool(sm, "EvictableIssue", EvictableIssue, [
      { id: "i1", title: "Test", teamId: "t1" },
    ]);

    expect(sm.canEvict("EvictableIssue", "i1")).toEqual({ safe: true });
  });

  it("blocks Eager models by default", async () => {
    sm = await makeManager();
    const meta = ModelRegistry.getModelMeta("TestWorkspace");
    expect(meta?.loadStrategy).toBe(LoadStrategy.Eager);
    expect(sm.canEvict("TestWorkspace", "x")).toEqual({
      safe: false,
      reason: "strategyExempt",
    });
  });

  it("blocks LocalOnly models", async () => {
    sm = await makeManager();
    expect(sm.canEvict("NoEvictModel", "x")).toEqual({
      safe: false,
      reason: "strategyExempt",
    });
  });

  it("blocks records with unsaved changes", async () => {
    sm = await makeManager();
    seedPool(sm, "EvictableIssue", EvictableIssue, [
      { id: "i1", title: "Original", teamId: "t1" },
    ]);
    const inst = sm.objectPool.getById<EvictableIssue>("EvictableIssue", "i1")!;
    inst.title = "Changed";

    expect(sm.canEvict("EvictableIssue", "i1")).toEqual({
      safe: false,
      reason: "unsavedChanges",
    });
  });

  it("blocks observed records", async () => {
    sm = await makeManager();
    seedPool(sm, "EvictableIssue", EvictableIssue, [
      { id: "i1", title: "Test", teamId: "t1" },
    ]);
    sm.objectPool.observeInstance("EvictableIssue", "i1");

    expect(sm.canEvict("EvictableIssue", "i1")).toEqual({
      safe: false,
      reason: "observed",
    });

    sm.objectPool.unobserveInstance("EvictableIssue", "i1");
    expect(sm.canEvict("EvictableIssue", "i1")).toEqual({ safe: true });
  });

  it("blocks records with eviction: false even if Partial", async () => {
    sm = await makeManager();
    seedPool(sm, "NoEvictModel", NoEvictModel, [
      { id: "n1", value: "test" },
    ]);

    expect(sm.canEvict("NoEvictModel", "n1")).toEqual({
      safe: false,
      reason: "strategyExempt",
    });
  });
});

// ── Observation tracking ────────────────────────────────────────────────────

describe("ObjectPool observation tracking", () => {
  it("tracks observe/unobserve refcount", async () => {
    sm = await makeManager();
    const pool = sm.objectPool;

    expect(pool.isObserved("X", "1")).toBe(false);

    pool.observeInstance("X", "1");
    expect(pool.isObserved("X", "1")).toBe(true);

    pool.observeInstance("X", "1");
    expect(pool.isObserved("X", "1")).toBe(true);

    pool.unobserveInstance("X", "1");
    expect(pool.isObserved("X", "1")).toBe(true);

    pool.unobserveInstance("X", "1");
    expect(pool.isObserved("X", "1")).toBe(false);
  });

  it("unobserve below zero is safe", async () => {
    sm = await makeManager();
    expect(() => sm.objectPool.unobserveInstance("X", "1")).not.toThrow();
    expect(sm.objectPool.isObserved("X", "1")).toBe(false);
  });
});

// ── Eviction markers ────────────────────────────────────────────────────────

describe("eviction markers", () => {
  it("evictInstance marks record and removes from pool", async () => {
    sm = await makeManager();
    seedPool(sm, "EvictableIssue", EvictableIssue, [
      { id: "i1", title: "Test", teamId: "t1" },
    ]);

    sm.objectPool.evictInstance("EvictableIssue", "i1");

    expect(sm.objectPool.getById("EvictableIssue", "i1")).toBeUndefined();
    expect(sm.objectPool.wasEvicted("EvictableIssue", "i1")).toBe(true);
  });

  it("clearEvicted removes the marker", async () => {
    sm = await makeManager();
    seedPool(sm, "EvictableIssue", EvictableIssue, [
      { id: "i1", title: "Test", teamId: "t1" },
    ]);

    sm.objectPool.evictInstance("EvictableIssue", "i1");
    expect(sm.objectPool.wasEvicted("EvictableIssue", "i1")).toBe(true);

    sm.objectPool.clearEvicted("EvictableIssue", "i1");
    expect(sm.objectPool.wasEvicted("EvictableIssue", "i1")).toBe(false);
  });

  it("server-side remove does NOT set eviction marker", async () => {
    sm = await makeManager();
    seedPool(sm, "EvictableIssue", EvictableIssue, [
      { id: "i1", title: "Test", teamId: "t1" },
    ]);

    sm.objectPool.remove("EvictableIssue", "i1");

    expect(sm.objectPool.getById("EvictableIssue", "i1")).toBeUndefined();
    expect(sm.objectPool.wasEvicted("EvictableIssue", "i1")).toBe(false);
  });
});

// ── Batch eviction ──────────────────────────────────────────────────────────

describe("evictBatch", () => {
  it("removes all IDs and fires one notify", async () => {
    sm = await makeManager();
    seedPool(sm, "EvictableIssue", EvictableIssue, [
      { id: "i1", title: "A", teamId: "t1" },
      { id: "i2", title: "B", teamId: "t1" },
      { id: "i3", title: "C", teamId: "t1" },
    ]);

    let notifyCount = 0;
    sm.objectPool.subscribe("EvictableIssue", () => notifyCount++);

    sm.objectPool.evictBatch("EvictableIssue", ["i1", "i2"]);

    expect(sm.objectPool.getById("EvictableIssue", "i1")).toBeUndefined();
    expect(sm.objectPool.getById("EvictableIssue", "i2")).toBeUndefined();
    expect(sm.objectPool.getById("EvictableIssue", "i3")).toBeDefined();
    expect(sm.objectPool.wasEvicted("EvictableIssue", "i1")).toBe(true);
    expect(sm.objectPool.wasEvicted("EvictableIssue", "i2")).toBe(true);
    expect(notifyCount).toBe(1);
  });

  it("is a no-op for empty ID list", async () => {
    sm = await makeManager();
    let notifyCount = 0;
    sm.objectPool.subscribe("EvictableIssue", () => notifyCount++);

    sm.objectPool.evictBatch("EvictableIssue", []);

    expect(notifyCount).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Phase 2: Sync-group-leave via onSyncGroupDelete callback
// ═══════════════════════════════════════════════════════════════════════════

describe("sync-group-leave via onSyncGroupDelete", () => {
  it("onSyncGroupDelete callback fires on user-initiated deactivation", async () => {
    const onSyncGroupDelete = vi.fn();
    sm = await makeManager({
      initialGroups: ["team-1"],
      onSyncGroupDelete,
    });

    await sm.deactivateSyncGroup("team-1");

    expect(onSyncGroupDelete).toHaveBeenCalledWith("team-1", sm);
  });

  it("evictByIndex from callback evicts matching records", async () => {
    sm = await makeManager({
      initialGroups: ["team-1"],
      onSyncGroupDelete: async (groupId, storeManager) => {
        await storeManager.evictByIndex("EvictableIssue", "teamId", groupId, { keepInDb: true });
      },
    });
    seedPool(sm, "EvictableIssue", EvictableIssue, [
      { id: "i1", title: "A", teamId: "team-1" },
      { id: "i2", title: "B", teamId: "team-1" },
      { id: "i3", title: "C", teamId: "team-2" },
    ]);

    await sm.deactivateSyncGroup("team-1");

    expect(sm.objectPool.getById("EvictableIssue", "i1")).toBeUndefined();
    expect(sm.objectPool.getById("EvictableIssue", "i2")).toBeUndefined();
    expect(sm.objectPool.getById("EvictableIssue", "i3")).toBeDefined();
  });

  it("evictByIndex with keepInDb: true preserves IDB rows", async () => {
    sm = await makeManager({
      initialGroups: ["team-1"],
      onSyncGroupDelete: async (groupId, storeManager) => {
        await storeManager.evictByIndex("EvictableIssue", "teamId", groupId, { keepInDb: true });
      },
    });
    await seedPoolAndDb(sm, "EvictableIssue", EvictableIssue, [
      { id: "i1", title: "A", teamId: "team-1" },
    ]);

    await sm.deactivateSyncGroup("team-1");

    expect(sm.objectPool.getById("EvictableIssue", "i1")).toBeUndefined();
    expect(
      await sm.database.readModel("EvictableIssue", "i1"),
    ).not.toBeNull();
  });

  it("evictByIndex without keepInDb removes from IDB", async () => {
    sm = await makeManager({
      initialGroups: ["team-1"],
      onSyncGroupDelete: async (groupId, storeManager) => {
        await storeManager.evictByIndex("EvictableIssue", "teamId", groupId);
      },
    });
    await seedPoolAndDb(sm, "EvictableIssue", EvictableIssue, [
      { id: "i1", title: "A", teamId: "team-1" },
    ]);

    await sm.deactivateSyncGroup("team-1");

    expect(sm.objectPool.getById("EvictableIssue", "i1")).toBeUndefined();
    await vi.waitFor(async () => {
      expect(await sm.database.readModel("EvictableIssue", "i1")).toBeNull();
    });
  });

  it("evicts across multiple models from callback", async () => {
    sm = await makeManager({
      initialGroups: ["team-1"],
      onSyncGroupDelete: async (groupId, storeManager) => {
        await storeManager.evictByIndex("EvictableIssue", "teamId", groupId, { keepInDb: true });
        await storeManager.evictByIndex("EvictableComment", "teamId", groupId, { keepInDb: true });
      },
    });
    seedPool(sm, "EvictableIssue", EvictableIssue, [
      { id: "i1", title: "Issue", teamId: "team-1" },
    ]);
    seedPool(sm, "EvictableComment", EvictableComment, [
      { id: "c1", body: "Comment", teamId: "team-1" },
    ]);

    await sm.deactivateSyncGroup("team-1");

    expect(sm.objectPool.getById("EvictableIssue", "i1")).toBeUndefined();
    expect(sm.objectPool.getById("EvictableComment", "c1")).toBeUndefined();
  });

  it("does not evict when no callback is configured", async () => {
    sm = await makeManager({
      initialGroups: ["team-1"],
    });
    seedPool(sm, "EvictableIssue", EvictableIssue, [
      { id: "i1", title: "A", teamId: "team-1" },
    ]);

    await sm.deactivateSyncGroup("team-1");

    expect(sm.objectPool.getById("EvictableIssue", "i1")).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// { safe: true } must also gate the IDB delete, not just the pool pass.
// A record skipped in the pool for being observed / dirty / in-flight must
// keep its persisted row — otherwise a live instance is orphaned.
// ═══════════════════════════════════════════════════════════════════════════

describe("safe eviction keeps IDB in sync with the pool", () => {
  it("evictByIndex { safe } keeps the IDB row of an observed record", async () => {
    sm = await makeManager({ initialGroups: ["team-1"] });
    await seedPoolAndDb(sm, "EvictableIssue", EvictableIssue, [
      { id: "i1", title: "Observed", teamId: "team-1" },
      { id: "i2", title: "Free", teamId: "team-1" },
    ]);
    sm.objectPool.observeInstance("EvictableIssue", "i1");

    await sm.evictByIndex("EvictableIssue", "teamId", "team-1", { safe: true });

    // i1 skipped in the pool → its IDB row must survive.
    expect(sm.objectPool.getById("EvictableIssue", "i1")).toBeDefined();
    expect(await sm.database.readModel("EvictableIssue", "i1")).not.toBeNull();
    // i2 was free → evicted from both pool and IDB.
    expect(sm.objectPool.getById("EvictableIssue", "i2")).toBeUndefined();
    expect(await sm.database.readModel("EvictableIssue", "i2")).toBeNull();

    sm.objectPool.unobserveInstance("EvictableIssue", "i1");
  });

  it("evictByIndex { safe } keeps the IDB row of a dirty record", async () => {
    sm = await makeManager({ initialGroups: ["team-1"] });
    await seedPoolAndDb(sm, "EvictableIssue", EvictableIssue, [
      { id: "i1", title: "Original", teamId: "team-1" },
    ]);
    const inst = sm.objectPool.getById<EvictableIssue>("EvictableIssue", "i1")!;
    inst.title = "Changed";

    await sm.evictByIndex("EvictableIssue", "teamId", "team-1", { safe: true });

    expect(sm.objectPool.getById("EvictableIssue", "i1")).toBeDefined();
    expect(await sm.database.readModel("EvictableIssue", "i1")).not.toBeNull();
  });

  it("evictByIndex without { safe } force-deletes the IDB row regardless", async () => {
    sm = await makeManager({ initialGroups: ["team-1"] });
    await seedPoolAndDb(sm, "EvictableIssue", EvictableIssue, [
      { id: "i1", title: "Observed", teamId: "team-1" },
    ]);
    sm.objectPool.observeInstance("EvictableIssue", "i1");

    await sm.evictByIndex("EvictableIssue", "teamId", "team-1");

    // Unconditional path: observation is ignored, IDB row goes too.
    expect(sm.objectPool.getById("EvictableIssue", "i1")).toBeUndefined();
    await vi.waitFor(async () => {
      expect(await sm.database.readModel("EvictableIssue", "i1")).toBeNull();
    });

    sm.objectPool.unobserveInstance("EvictableIssue", "i1");
  });

  it("evictWhere { safe } keeps the IDB row of an observed record", async () => {
    sm = await makeManager({ initialGroups: ["team-1"] });
    await seedPoolAndDb(sm, "EvictableIssue", EvictableIssue, [
      { id: "i1", title: "Observed", teamId: "team-1" },
      { id: "i2", title: "Free", teamId: "team-1" },
    ]);
    sm.objectPool.observeInstance("EvictableIssue", "i1");

    await sm.evictWhere(
      "EvictableIssue",
      (m) => m.teamId === "team-1",
      { safe: true },
    );

    expect(sm.objectPool.getById("EvictableIssue", "i1")).toBeDefined();
    expect(await sm.database.readModel("EvictableIssue", "i1")).not.toBeNull();
    expect(sm.objectPool.getById("EvictableIssue", "i2")).toBeUndefined();
    expect(await sm.database.readModel("EvictableIssue", "i2")).toBeNull();

    sm.objectPool.unobserveInstance("EvictableIssue", "i1");
  });

  it("evictByIndex { safe } preserves collection coverage when nothing is evictable", async () => {
    const fetcher = vi.fn().mockResolvedValue([
      { id: "i1", title: "A", teamId: "team-1" },
      { id: "i2", title: "B", teamId: "team-1" },
    ]);
    sm = await makeManager({ initialGroups: ["team-1"], onDemandFetcher: fetcher });

    // Establish coverage via a server fetch, then pin both records.
    await sm.getOrLoadCollection("EvictableIssue", "teamId", "team-1");
    expect(sm.isCollectionLoaded("EvictableIssue", "teamId", "team-1")).toBe(true);
    sm.objectPool.observeInstance("EvictableIssue", "i1");
    sm.objectPool.observeInstance("EvictableIssue", "i2");

    await sm.evictByIndex("EvictableIssue", "teamId", "team-1", { safe: true });

    // Nothing was evictable → IDB still complete → coverage intact, no refetch.
    expect(sm.isCollectionLoaded("EvictableIssue", "teamId", "team-1")).toBe(true);
    expect(sm.objectPool.getById("EvictableIssue", "i1")).toBeDefined();
    expect(sm.objectPool.getById("EvictableIssue", "i2")).toBeDefined();
    await sm.getOrLoadCollection("EvictableIssue", "teamId", "team-1");
    expect(fetcher).toHaveBeenCalledTimes(1);

    sm.objectPool.unobserveInstance("EvictableIssue", "i1");
    sm.objectPool.unobserveInstance("EvictableIssue", "i2");
  });

  it("evictByIndex { safe } clears coverage when some records are evicted", async () => {
    const fetcher = vi.fn().mockResolvedValue([
      { id: "i1", title: "A", teamId: "team-1" },
      { id: "i2", title: "B", teamId: "team-1" },
    ]);
    sm = await makeManager({ initialGroups: ["team-1"], onDemandFetcher: fetcher });

    await sm.getOrLoadCollection("EvictableIssue", "teamId", "team-1");
    sm.objectPool.observeInstance("EvictableIssue", "i1"); // pin only one

    await sm.evictByIndex("EvictableIssue", "teamId", "team-1", { safe: true });

    // i2 was evicted → IDB now partial → coverage torn down so the next load
    // refetches the full set from the server.
    expect(sm.isCollectionLoaded("EvictableIssue", "teamId", "team-1")).toBe(false);
    expect(sm.objectPool.getById("EvictableIssue", "i1")).toBeDefined();
    expect(sm.objectPool.getById("EvictableIssue", "i2")).toBeUndefined();
    await sm.getOrLoadCollection("EvictableIssue", "teamId", "team-1");
    expect(fetcher).toHaveBeenCalledTimes(2);

    sm.objectPool.unobserveInstance("EvictableIssue", "i1");
  });

  it("evictByIndex { safe } clears coverage for pool-only (Ephemeral) eviction", async () => {
    const fetcher = vi.fn().mockResolvedValue([
      { id: "e1", label: "A", teamId: "team-1" },
      { id: "e2", label: "B", teamId: "team-1" },
    ]);
    sm = await makeManager({ initialGroups: ["team-1"], onDemandFetcher: fetcher });

    await sm.getOrLoadCollection("EphemeralColl", "teamId", "team-1");
    expect(sm.isCollectionLoaded("EphemeralColl", "teamId", "team-1")).toBe(true);
    expect(sm.objectPool.getAll<EphemeralColl>("EphemeralColl").length).toBe(2);

    // Pool-only model: records leave the pool but there are no IDB rows, so the
    // safe IDB delete list is empty. Coverage must still clear (poolCount > 0),
    // else the next load short-circuits and the collection stays empty.
    await sm.evictByIndex("EphemeralColl", "teamId", "team-1", { safe: true });

    expect(sm.objectPool.getAll<EphemeralColl>("EphemeralColl").length).toBe(0);
    expect(sm.isCollectionLoaded("EphemeralColl", "teamId", "team-1")).toBe(false);
    await sm.getOrLoadCollection("EphemeralColl", "teamId", "team-1");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("evictByIndex { keepInDb } on Ephemeral clears coverage (no IDB to keep)", async () => {
    const fetcher = vi.fn().mockResolvedValue([
      { id: "e1", label: "A", teamId: "team-1" },
      { id: "e2", label: "B", teamId: "team-1" },
    ]);
    sm = await makeManager({ initialGroups: ["team-1"], onDemandFetcher: fetcher });

    await sm.getOrLoadCollection("EphemeralColl", "teamId", "team-1");
    expect(sm.isCollectionLoaded("EphemeralColl", "teamId", "team-1")).toBe(true);

    // keepInDb is meaningless for Ephemeral — there is no IDB to keep, so the
    // records are gone for good and coverage must not keep claiming completeness.
    await sm.evictByIndex("EphemeralColl", "teamId", "team-1", { keepInDb: true });

    expect(sm.objectPool.getAll<EphemeralColl>("EphemeralColl").length).toBe(0);
    expect(sm.isCollectionLoaded("EphemeralColl", "teamId", "team-1")).toBe(false);
    await sm.getOrLoadCollection("EphemeralColl", "teamId", "team-1");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("watermark eviction of Ephemeral records clears stale coverage", async () => {
    const fetcher = vi.fn().mockResolvedValue([
      { id: "e1", label: "A", teamId: "team-1" },
      { id: "e2", label: "B", teamId: "team-1" },
    ]);
    sm = await makeManager({
      initialGroups: ["team-1"],
      onDemandFetcher: fetcher,
      eviction: { maxResident: 3 },
    });
    const meta = ModelRegistry.getModelMeta("EphemeralColl")!;

    // Load 2 within the cap → coverage set, both resident.
    await sm.getOrLoadCollection("EphemeralColl", "teamId", "team-1");
    expect(sm.isCollectionLoaded("EphemeralColl", "teamId", "team-1")).toBe(true);
    expect(sm.objectPool.getAll<EphemeralColl>("EphemeralColl").length).toBe(2);

    // Push the same model past maxResident with unrelated inserts. The watermark
    // evicts the oldest (the team-1 records) FIFO — pool-only, no IDB backing.
    for (let i = 1; i <= 3; i++) {
      sm.objectPool.hydrateAndPut("EphemeralColl", meta, {
        id: `x${i}`,
        label: `X${i}`,
        teamId: "team-2",
      });
    }

    // The team-1 coverage must be cleared, since its records were evicted with
    // nothing to reload them from.
    expect(sm.objectPool.getById("EphemeralColl", "e1")).toBeUndefined();
    expect(sm.isCollectionLoaded("EphemeralColl", "teamId", "team-1")).toBe(false);

    await sm.getOrLoadCollection("EphemeralColl", "teamId", "team-1");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Phase 3: Resident-count watermark
// ═══════════════════════════════════════════════════════════════════════════

describe("watermark eviction (maxResident)", () => {
  it("evicts oldest records when pool exceeds per-model maxResident", async () => {
    sm = await makeManager();
    const meta = ModelRegistry.getModelMeta("WatermarkItem")!;

    // WatermarkItem has maxResident: 5. Add 7 records.
    for (let i = 1; i <= 7; i++) {
      sm.objectPool.hydrateAndPut("WatermarkItem", meta, {
        id: `w${i}`,
        label: `Item ${i}`,
      });
    }

    // With maxResident=5 and lowWaterRatio=0.75, low-water = floor(5*0.75) = 3.
    // Should evict down to 3 from 7, so 4 evicted. But after w6 triggers at
    // count=6, it evicts 6-3=3 oldest (w1,w2,w3). Then w7 triggers at count=4,
    // which is ≤5, so no more eviction.
    const remaining = sm.objectPool.getAll("WatermarkItem");
    expect(remaining.length).toBeLessThanOrEqual(5);
    // The newest records should survive
    expect(sm.objectPool.getById("WatermarkItem", "w7")).toBeDefined();
  });

  it("does not evict when under maxResident", async () => {
    sm = await makeManager();
    const meta = ModelRegistry.getModelMeta("WatermarkItem")!;

    for (let i = 1; i <= 5; i++) {
      sm.objectPool.hydrateAndPut("WatermarkItem", meta, {
        id: `w${i}`,
        label: `Item ${i}`,
      });
    }

    expect(sm.objectPool.getAll("WatermarkItem").length).toBe(5);
    expect(sm.objectPool.getById("WatermarkItem", "w1")).toBeDefined();
  });

  it("fires on direct put (create path), not just hydrateAndPut", async () => {
    sm = await makeManager();

    // addToPool → objectPool.put, the path commitCreate uses for local creates
    // (store.create / draft().save()). Before the fix the watermark callback
    // only ran from hydrateAndPut, so creates blew past maxResident unbounded.
    for (let i = 1; i <= 8; i++) {
      const inst = new WatermarkItem();
      inst.hydrate({ id: `w${i}`, label: `Item ${i}` });
      addToPool(sm, "WatermarkItem", inst);
    }

    expect(sm.objectPool.getAll("WatermarkItem").length).toBeLessThanOrEqual(5);
    expect(sm.objectPool.getById("WatermarkItem", "w8")).toBeDefined();
  });

  it("never evicts the brand-new create that triggered the check", async () => {
    sm = await makeManager();
    const meta = ModelRegistry.getModelMeta("WatermarkItem")!;

    // Fill to the cap and pin every resident, so the watermark can't touch them.
    for (let i = 1; i <= 5; i++) {
      sm.objectPool.hydrateAndPut("WatermarkItem", meta, {
        id: `w${i}`,
        label: `Item ${i}`,
      });
      sm.objectPool.observeInstance("WatermarkItem", `w${i}`);
    }

    // A clean optimistic create: hydrate populates no pendingChanges (not dirty)
    // and commitCreate enqueues the in-flight transaction only AFTER put. With
    // every resident pinned, the fresh record is the sole evictable one — the
    // watermark must skip the very record whose insert triggered it.
    const fresh = new WatermarkItem();
    fresh.hydrate({ id: "w6", label: "Fresh" });
    sm.commitCreate(fresh);

    expect(sm.objectPool.getById("WatermarkItem", "w6")).toBeDefined();

    for (let i = 1; i <= 5; i++) {
      sm.objectPool.unobserveInstance("WatermarkItem", `w${i}`);
    }
  });

  it("skips observed records during watermark eviction", async () => {
    sm = await makeManager();
    const meta = ModelRegistry.getModelMeta("WatermarkItem")!;

    // Seed 5 records (at the limit)
    for (let i = 1; i <= 5; i++) {
      sm.objectPool.hydrateAndPut("WatermarkItem", meta, {
        id: `w${i}`,
        label: `Item ${i}`,
      });
    }

    // Observe the oldest records
    sm.objectPool.observeInstance("WatermarkItem", "w1");
    sm.objectPool.observeInstance("WatermarkItem", "w2");

    // Add one more to trigger watermark
    sm.objectPool.hydrateAndPut("WatermarkItem", meta, {
      id: "w6",
      label: "Item 6",
    });

    // w1, w2 are observed — they should survive
    expect(sm.objectPool.getById("WatermarkItem", "w1")).toBeDefined();
    expect(sm.objectPool.getById("WatermarkItem", "w2")).toBeDefined();
    // w6 is newest — should survive
    expect(sm.objectPool.getById("WatermarkItem", "w6")).toBeDefined();

    sm.objectPool.unobserveInstance("WatermarkItem", "w1");
    sm.objectPool.unobserveInstance("WatermarkItem", "w2");
  });

  it("uses global maxResident from eviction config as fallback", async () => {
    sm = await makeManager({
      eviction: { maxResident: 3 },
    });
    const meta = ModelRegistry.getModelMeta("EvictableIssue")!;

    // EvictableIssue doesn't have per-model maxResident, but global is 3
    for (let i = 1; i <= 5; i++) {
      sm.objectPool.hydrateAndPut("EvictableIssue", meta, {
        id: `i${i}`,
        title: `Issue ${i}`,
        teamId: "t1",
      });
    }

    expect(sm.objectPool.getAll("EvictableIssue").length).toBeLessThanOrEqual(3);
  });

  it("per-model maxResident overrides global config", async () => {
    sm = await makeManager({
      eviction: { maxResident: 100 },
    });
    const meta = ModelRegistry.getModelMeta("WatermarkItem")!;

    // WatermarkItem has per-model maxResident: 5, global is 100
    for (let i = 1; i <= 7; i++) {
      sm.objectPool.hydrateAndPut("WatermarkItem", meta, {
        id: `w${i}`,
        label: `Item ${i}`,
      });
    }

    expect(sm.objectPool.getAll("WatermarkItem").length).toBeLessThanOrEqual(5);
  });

  it("global maxResident does not apply to Eager models without eviction config", async () => {
    sm = await makeManager({ eviction: { maxResident: 3 } });
    const meta = ModelRegistry.getModelMeta("EagerDefault")!;

    for (let i = 1; i <= 6; i++) {
      sm.objectPool.hydrateAndPut("EagerDefault", meta, {
        id: `e${i}`,
        label: `Item ${i}`,
      });
    }

    // Eager is "always resident": the global cap must not silently evict it.
    expect(sm.objectPool.getAll<EagerDefault>("EagerDefault").length).toBe(6);
  });

  it("an Eager model with eviction: {} opts into the global maxResident", async () => {
    sm = await makeManager({ eviction: { maxResident: 3 } });
    const meta = ModelRegistry.getModelMeta("EagerOptIn")!;

    for (let i = 1; i <= 6; i++) {
      sm.objectPool.hydrateAndPut("EagerOptIn", meta, {
        id: `e${i}`,
        label: `Item ${i}`,
      });
    }

    expect(sm.objectPool.getAll<EagerOptIn>("EagerOptIn").length).toBeLessThanOrEqual(3);
  });

  it("watermark always uses keepInDb: true", async () => {
    sm = await makeManager();
    const meta = ModelRegistry.getModelMeta("WatermarkItem")!;

    // Write to IDB first
    for (let i = 1; i <= 7; i++) {
      await sm.database.writeModels("WatermarkItem", [
        { id: `w${i}`, label: `Item ${i}` },
      ]);
    }

    // Hydrate into pool (triggers watermark)
    for (let i = 1; i <= 7; i++) {
      sm.objectPool.hydrateAndPut("WatermarkItem", meta, {
        id: `w${i}`,
        label: `Item ${i}`,
      });
    }

    // Some records should have been evicted from pool
    const poolCount = sm.objectPool.getAll("WatermarkItem").length;
    expect(poolCount).toBeLessThan(7);

    // But IDB should still have all records (keepInDb: true for watermark)
    for (let i = 1; i <= 7; i++) {
      expect(
        await sm.database.readModel("WatermarkItem", `w${i}`),
      ).not.toBeNull();
    }
  });

  it("respects lowWaterRatio config", async () => {
    sm = await makeManager({
      eviction: { lowWaterRatio: 0.5 },
    });
    const meta = ModelRegistry.getModelMeta("WatermarkItem")!;

    // WatermarkItem has maxResident: 5, lowWaterRatio: 0.5 → low-water = 2
    // Adding 6 items triggers watermark: need to evict 6-2=4
    for (let i = 1; i <= 6; i++) {
      sm.objectPool.hydrateAndPut("WatermarkItem", meta, {
        id: `w${i}`,
        label: `Item ${i}`,
      });
    }

    // With low-water 2, should have at most 2 after eviction at trigger
    // But items are added one at a time, so:
    // w6 added → count=6 > 5 → evict down to floor(5*0.5)=2, target=6-2=4
    expect(sm.objectPool.getAll("WatermarkItem").length).toBeLessThanOrEqual(3);
  });

  it("does not fire for models with eviction: false", async () => {
    sm = await makeManager({
      eviction: { maxResident: 2 },
    });
    const meta = ModelRegistry.getModelMeta("NoEvictModel")!;

    // NoEvictModel has eviction: false. Global maxResident should not apply.
    for (let i = 1; i <= 5; i++) {
      sm.objectPool.hydrateAndPut("NoEvictModel", meta, {
        id: `n${i}`,
        value: `Val ${i}`,
      });
    }

    expect(sm.objectPool.getAll("NoEvictModel").length).toBe(5);
  });

  it("re-hydrating an existing record does not trigger watermark", async () => {
    sm = await makeManager();
    const meta = ModelRegistry.getModelMeta("WatermarkItem")!;

    // Fill exactly to maxResident (5)
    for (let i = 1; i <= 5; i++) {
      sm.objectPool.hydrateAndPut("WatermarkItem", meta, {
        id: `w${i}`,
        label: `Item ${i}`,
      });
    }
    expect(sm.objectPool.getAll("WatermarkItem").length).toBe(5);

    // Re-hydrate an existing record — pool size stays at 5, no eviction
    sm.objectPool.hydrateAndPut("WatermarkItem", meta, {
      id: "w3",
      label: "Updated",
    });

    expect(sm.objectPool.getAll("WatermarkItem").length).toBe(5);
    expect(
      (sm.objectPool.getById("WatermarkItem", "w3") as WatermarkItem).label,
    ).toBe("Updated");
  });
});

// ── Eviction marker self-heal (ObjectPool.trackModel) ───────────────────────

describe("trackModel self-heal", () => {
  it("fires rehydrator when trackModel sees an evicted record", async () => {
    sm = await makeManager();
    seedPool(sm, "EvictableIssue", EvictableIssue, [
      { id: "i1", title: "A", teamId: "t1" },
    ]);

    sm.objectPool.evictInstance("EvictableIssue", "i1");
    expect(sm.objectPool.wasEvicted("EvictableIssue", "i1")).toBe(true);

    // trackModel should clear the eviction marker and fire rehydrator
    sm.objectPool.trackModel("EvictableIssue", "i1");

    expect(sm.objectPool.wasEvicted("EvictableIssue", "i1")).toBe(false);
  });

  it("does not fire rehydrator for server-side deleted records", async () => {
    sm = await makeManager();
    seedPool(sm, "EvictableIssue", EvictableIssue, [
      { id: "i1", title: "A", teamId: "t1" },
    ]);

    // Server-side remove (no eviction marker)
    sm.objectPool.remove("EvictableIssue", "i1");
    expect(sm.objectPool.wasEvicted("EvictableIssue", "i1")).toBe(false);

    // trackModel should not attempt rehydration
    sm.objectPool.trackModel("EvictableIssue", "i1");
    expect(sm.objectPool.wasEvicted("EvictableIssue", "i1")).toBe(false);
  });
});
