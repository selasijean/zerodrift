import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { StoreManager, type EvictionConfig } from "@zerodrift/StoreManager";
import { MemoryAdapter } from "@zerodrift/MemoryAdapter";
import { BaseModel } from "@zerodrift/BaseModel";
import { LoadStrategy } from "@zerodrift/types";
import { ClientModel, Property, LazyReference } from "@zerodrift/decorators";
import { ModelRegistry } from "@zerodrift/ModelRegistry";
import { addToPool, TestTask } from "./fixtures";

// ── Test-only model fixtures ────────────────────────────────────────────────

@ClientModel({
  name: "RefTarget",
  loadStrategy: LoadStrategy.Partial,
})
class RefTarget extends BaseModel {
  @Property()
  public name = "";
}

@ClientModel({
  name: "RefHolder",
  loadStrategy: LoadStrategy.Partial,
})
class RefHolder extends BaseModel {
  @Property({ indexed: true })
  public targetId = "";

  @LazyReference("RefTarget")
  public target: RefTarget;
}

@ClientModel({
  name: "ObsIssue",
  loadStrategy: LoadStrategy.Partial,
  eviction: { syncGroupKey: "teamId" },
})
class ObsIssue extends BaseModel {
  @Property()
  public title = "";

  @Property({ indexed: true })
  public teamId = "";
}

// ── Helpers ─────────────────────────────────────────────────────────────────

async function makeTestSm(opts: {
  eviction?: EvictionConfig;
  initialGroups?: string[];
} = {}): Promise<StoreManager> {
  const adapter = new MemoryAdapter();
  const sm = new StoreManager({
    workspaceId: crypto.randomUUID(),
    transport: {
      bootstrapFetcher: vi.fn().mockResolvedValue({
        lastSyncId: 0,
        subscribedSyncGroups: opts.initialGroups ?? [],
        models: {},
      }),
    },
    persistence: { storageAdapter: adapter },
    eviction: opts.eviction,
  });
  await sm.bootstrap();
  return sm;
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
// @Reference getter → trackModel → rehydrator self-heal
//
// These test the real code path: accessing holder.target invokes the
// @LazyReference getter, which calls pool.trackModel(referenceTo, id).
// trackModel checks recentlyEvicted and fires the rehydrator callback,
// which calls sm.getOrLoadById to restore the record from IDB.
// ═══════════════════════════════════════════════════════════════════════════

describe("@Reference self-heal on eviction", () => {
  it("reference getter returns null and clears eviction marker via trackModel", async () => {
    sm = await makeTestSm();

    const target = new RefTarget();
    target.hydrate({ id: "t1", name: "Target" });
    addToPool(sm, "RefTarget", target);

    const holder = new RefHolder();
    holder.hydrate({ id: "h1", targetId: "t1" });
    addToPool(sm, "RefHolder", holder);

    expect(holder.target).toBe(target);

    sm.objectPool.evictInstance("RefTarget", "t1");
    expect(sm.objectPool.wasEvicted("RefTarget", "t1")).toBe(true);

    expect(holder.target).toBeNull();
    expect(sm.objectPool.wasEvicted("RefTarget", "t1")).toBe(false);
  });

  it("server-deleted target does not trigger rehydration", async () => {
    sm = await makeTestSm();

    const rehydratorSpy = vi.fn();
    sm.objectPool.setRehydrator(rehydratorSpy);

    const target = new RefTarget();
    target.hydrate({ id: "t1", name: "Target" });
    addToPool(sm, "RefTarget", target);

    const holder = new RefHolder();
    holder.hydrate({ id: "h1", targetId: "t1" });
    addToPool(sm, "RefHolder", holder);

    sm.objectPool.remove("RefTarget", "t1");

    expect(holder.target).toBeNull();
    expect(rehydratorSpy).not.toHaveBeenCalled();
  });

  it("rehydrator restores evicted record from IDB end-to-end", async () => {
    sm = await makeTestSm();

    await sm.database.writeModels("RefTarget", [
      { id: "t1", name: "Target" },
    ]);

    const meta = ModelRegistry.getModelMeta("RefTarget")!;
    sm.objectPool.hydrateAndPut("RefTarget", meta, {
      id: "t1",
      name: "Target",
    });

    const holder = new RefHolder();
    holder.hydrate({ id: "h1", targetId: "t1" });
    addToPool(sm, "RefHolder", holder);

    sm.objectPool.evictInstance("RefTarget", "t1");

    void holder.target;

    await vi.waitFor(() => {
      expect(sm.objectPool.getById("RefTarget", "t1")).toBeDefined();
    });

    expect(holder.target).not.toBeNull();
    expect((holder.target as RefTarget).name).toBe("Target");
  });

  it("works with existing fixture: TestTask → TestProject", async () => {
    sm = await makeTestSm();

    await sm.database.writeModels("TestProject", [
      { id: "p1", title: "Project", status: "active", workspaceId: "w1" },
    ]);

    const projectMeta = ModelRegistry.getModelMeta("TestProject")!;
    sm.objectPool.hydrateAndPut("TestProject", projectMeta, {
      id: "p1",
      title: "Project",
      status: "active",
      workspaceId: "w1",
    });

    const task = new TestTask();
    task.hydrate({
      id: "task1",
      projectId: "p1",
      title: "Task",
      done: false,
      assigneeId: null,
    });
    addToPool(sm, "TestTask", task);

    expect(task.project.title).toBe("Project");

    sm.objectPool.evictInstance("TestProject", "p1");
    expect(task.project).toBeNull();

    await vi.waitFor(() => {
      expect(sm.objectPool.getById("TestProject", "p1")).toBeDefined();
    });

    expect(task.project.title).toBe("Project");
  });

  it("re-adding evicted record to pool clears stale marker", async () => {
    sm = await makeTestSm();

    const meta = ModelRegistry.getModelMeta("RefTarget")!;
    sm.objectPool.hydrateAndPut("RefTarget", meta, {
      id: "t1",
      name: "Original",
    });

    sm.objectPool.evictInstance("RefTarget", "t1");
    expect(sm.objectPool.wasEvicted("RefTarget", "t1")).toBe(true);

    sm.objectPool.hydrateAndPut("RefTarget", meta, {
      id: "t1",
      name: "Restored",
    });

    expect(sm.objectPool.wasEvicted("RefTarget", "t1")).toBe(false);
  });

  it("re-adding via put clears stale marker", async () => {
    sm = await makeTestSm();

    const target = new RefTarget();
    target.hydrate({ id: "t1", name: "Original" });
    addToPool(sm, "RefTarget", target);

    sm.objectPool.evictInstance("RefTarget", "t1");
    expect(sm.objectPool.wasEvicted("RefTarget", "t1")).toBe(true);

    const restored = new RefTarget();
    restored.hydrate({ id: "t1", name: "Restored" });
    restored.makeModelObservable();
    sm.objectPool.put("RefTarget", restored);

    expect(sm.objectPool.wasEvicted("RefTarget", "t1")).toBe(false);
  });

  it("rapid evict-access-restore cycle does not leak markers", async () => {
    sm = await makeTestSm();

    await sm.database.writeModels("RefTarget", [
      { id: "t1", name: "Target" },
    ]);

    const meta = ModelRegistry.getModelMeta("RefTarget")!;

    const holder = new RefHolder();
    holder.hydrate({ id: "h1", targetId: "t1" });
    addToPool(sm, "RefHolder", holder);

    for (let cycle = 0; cycle < 3; cycle++) {
      sm.objectPool.hydrateAndPut("RefTarget", meta, {
        id: "t1",
        name: `Target-v${cycle}`,
      });

      sm.objectPool.evictInstance("RefTarget", "t1");
      expect(holder.target).toBeNull();

      await vi.waitFor(() => {
        expect(sm.objectPool.getById("RefTarget", "t1")).toBeDefined();
      });
    }

    expect(sm.objectPool.wasEvicted("RefTarget", "t1")).toBe(false);
    expect(holder.target).not.toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Observation + eviction integration
//
// Verifies that the observation refcount (what React hooks maintain)
// actually protects records during sync-group eviction loops. Unlike
// EvictionPolicy.test.ts which tests canEvict in isolation, these test
// the full deactivateSyncGroup → runEvictionLoop → canEvict → skip path.
// ═══════════════════════════════════════════════════════════════════════════

describe("observation protects records during sync-group eviction", () => {
  it("observed records survive while unobserved siblings are evicted", async () => {
    sm = await makeTestSm({ initialGroups: ["team-1"] });
    const meta = ModelRegistry.getModelMeta("ObsIssue")!;

    for (let i = 1; i <= 5; i++) {
      sm.objectPool.hydrateAndPut("ObsIssue", meta, {
        id: `i${i}`,
        title: `Issue ${i}`,
        teamId: "team-1",
      });
    }

    sm.objectPool.observeInstance("ObsIssue", "i2");
    sm.objectPool.observeInstance("ObsIssue", "i4");

    await sm.deactivateSyncGroup("team-1");

    expect(sm.objectPool.getById("ObsIssue", "i2")).toBeDefined();
    expect(sm.objectPool.getById("ObsIssue", "i4")).toBeDefined();

    expect(sm.objectPool.getById("ObsIssue", "i1")).toBeUndefined();
    expect(sm.objectPool.getById("ObsIssue", "i3")).toBeUndefined();
    expect(sm.objectPool.getById("ObsIssue", "i5")).toBeUndefined();

    sm.objectPool.unobserveInstance("ObsIssue", "i2");
    sm.objectPool.unobserveInstance("ObsIssue", "i4");
  });

  it("cross-team navigation: observed team-B survives team-A eviction", async () => {
    sm = await makeTestSm({ initialGroups: ["team-A", "team-B"] });
    const meta = ModelRegistry.getModelMeta("ObsIssue")!;

    for (let i = 1; i <= 3; i++) {
      sm.objectPool.hydrateAndPut("ObsIssue", meta, {
        id: `a${i}`,
        title: `Team-A Issue ${i}`,
        teamId: "team-A",
      });
    }
    for (let i = 1; i <= 3; i++) {
      sm.objectPool.hydrateAndPut("ObsIssue", meta, {
        id: `b${i}`,
        title: `Team-B Issue ${i}`,
        teamId: "team-B",
      });
    }

    sm.objectPool.observeInstance("ObsIssue", "b1");
    sm.objectPool.observeInstance("ObsIssue", "b2");
    sm.objectPool.observeInstance("ObsIssue", "b3");

    await sm.deactivateSyncGroup("team-A");

    for (let i = 1; i <= 3; i++) {
      expect(sm.objectPool.getById("ObsIssue", `a${i}`)).toBeUndefined();
    }
    for (let i = 1; i <= 3; i++) {
      expect(sm.objectPool.getById("ObsIssue", `b${i}`)).toBeDefined();
    }

    sm.objectPool.unobserveInstance("ObsIssue", "b1");
    sm.objectPool.unobserveInstance("ObsIssue", "b2");
    sm.objectPool.unobserveInstance("ObsIssue", "b3");
  });

  it("observed record in evicted team becomes evictable after unobserve", async () => {
    sm = await makeTestSm({ initialGroups: ["team-1"] });
    const meta = ModelRegistry.getModelMeta("ObsIssue")!;

    sm.objectPool.hydrateAndPut("ObsIssue", meta, {
      id: "i1",
      title: "Held",
      teamId: "team-1",
    });

    sm.objectPool.observeInstance("ObsIssue", "i1");

    await sm.deactivateSyncGroup("team-1");
    expect(sm.objectPool.getById("ObsIssue", "i1")).toBeDefined();

    sm.objectPool.unobserveInstance("ObsIssue", "i1");
    expect(sm.canEvict("ObsIssue", "i1")).toEqual({ safe: true });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Self-heal IDB roundtrip
//
// The useRecordByName hook detects "prevItem was present, item is now null,
// id is non-null" and checks wasEvicted. If true, it calls reload() which
// triggers getOrLoadById → IDB read → hydrateAndPut. These tests verify
// the primitives that contract depends on.
// ═══════════════════════════════════════════════════════════════════════════

describe("self-heal IDB roundtrip", () => {
  it("getOrLoadById restores an evicted record from IDB", async () => {
    sm = await makeTestSm();
    const pool = sm.objectPool;
    const meta = ModelRegistry.getModelMeta("ObsIssue")!;

    await sm.database.writeModels("ObsIssue", [
      { id: "i1", title: "Persisted", teamId: "t1" },
    ]);

    pool.hydrateAndPut("ObsIssue", meta, {
      id: "i1",
      title: "Persisted",
      teamId: "t1",
    });

    pool.evictInstance("ObsIssue", "i1");
    expect(pool.getById("ObsIssue", "i1")).toBeUndefined();

    const reloaded = await sm.getOrLoadById("ObsIssue", "i1");
    expect(reloaded).not.toBeNull();
    expect((reloaded as ObsIssue).title).toBe("Persisted");
    expect(pool.getById("ObsIssue", "i1")).toBeDefined();
  });

  it("restored record clears eviction marker so future removes are clean", async () => {
    sm = await makeTestSm();
    const pool = sm.objectPool;
    const meta = ModelRegistry.getModelMeta("ObsIssue")!;

    await sm.database.writeModels("ObsIssue", [
      { id: "i1", title: "Test", teamId: "t1" },
    ]);

    pool.hydrateAndPut("ObsIssue", meta, {
      id: "i1",
      title: "Test",
      teamId: "t1",
    });

    pool.evictInstance("ObsIssue", "i1");
    expect(pool.wasEvicted("ObsIssue", "i1")).toBe(true);

    await sm.getOrLoadById("ObsIssue", "i1");
    expect(pool.wasEvicted("ObsIssue", "i1")).toBe(false);

    pool.remove("ObsIssue", "i1");
    expect(pool.wasEvicted("ObsIssue", "i1")).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// evictBatch consolidation (perf regression guard)
// ═══════════════════════════════════════════════════════════════════════════

describe("evictBatch batching", () => {
  it("fires exactly one subscriber notification for a batch", async () => {
    sm = await makeTestSm();
    const meta = ModelRegistry.getModelMeta("ObsIssue")!;

    for (let i = 1; i <= 10; i++) {
      sm.objectPool.hydrateAndPut("ObsIssue", meta, {
        id: `i${i}`,
        title: `Issue ${i}`,
        teamId: "t1",
      });
    }

    let notifyCount = 0;
    sm.objectPool.subscribe("ObsIssue", () => notifyCount++);

    sm.objectPool.evictBatch(
      "ObsIssue",
      Array.from({ length: 10 }, (_, i) => `i${i + 1}`),
    );

    expect(notifyCount).toBe(1);
    expect(sm.objectPool.getAll("ObsIssue").length).toBe(0);
  });

  it("sets eviction markers for all IDs in one batch", async () => {
    sm = await makeTestSm();
    const meta = ModelRegistry.getModelMeta("ObsIssue")!;

    for (let i = 1; i <= 3; i++) {
      sm.objectPool.hydrateAndPut("ObsIssue", meta, {
        id: `i${i}`,
        title: `Issue ${i}`,
        teamId: "t1",
      });
    }

    sm.objectPool.evictBatch("ObsIssue", ["i1", "i2", "i3"]);

    expect(sm.objectPool.wasEvicted("ObsIssue", "i1")).toBe(true);
    expect(sm.objectPool.wasEvicted("ObsIssue", "i2")).toBe(true);
    expect(sm.objectPool.wasEvicted("ObsIssue", "i3")).toBe(true);
  });
});
