/**
 * Pool-only seed helpers (`sm.seed` / `sm.seedMany`) — for stories and
 * test setup. They wrap `objectPool.hydrateAndPut`, accept the same
 * shape as `BootstrapResponse.models`, and don't touch IDB or coverage
 * state.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeStoreManager } from "./helpers/storeManager";
import { StoreManager } from "@sync-engine/StoreManager";
import { MemoryAdapter } from "@sync-engine/MemoryAdapter";
import { BaseModel } from "@sync-engine/BaseModel";
import { TestNote, TestTask } from "./fixtures";

let manager: StoreManager;

beforeEach(() => {
  BaseModel.storeManager = null;
});

afterEach(async () => {
  await manager?.teardown();
  BaseModel.storeManager = null;
});

async function makeManager(): Promise<StoreManager> {
  const sm = makeStoreManager({
    workspaceId: crypto.randomUUID(),
    bootstrapFetcher: vi.fn().mockResolvedValue({
      lastSyncId: 0,
      subscribedSyncGroups: [],
      models: {},
    }),
    storageAdapter: new MemoryAdapter(),
  });
  await sm.bootstrap();
  return sm;
}

describe("StoreManager.seed", () => {
  it("hydrates records into the pool and returns typed instances", async () => {
    manager = await makeManager();
    const notes = manager.seed<TestNote>("TestNote", [
      { id: "n1", content: "first", taskId: "t1" },
      { id: "n2", content: "second", taskId: "t1" },
    ]);

    expect(notes).toHaveLength(2);
    expect(notes[0]).toBeInstanceOf(TestNote);
    expect(notes[0].content).toBe("first");
    expect(notes[1].content).toBe("second");

    // Same instances reachable via the pool.
    expect(manager.objectPool.getById<TestNote>("TestNote", "n1")).toBe(notes[0]);
  });

  it("re-seeding the same id re-hydrates in place (preserves identity)", async () => {
    manager = await makeManager();
    const [first] = manager.seed<TestNote>("TestNote", [
      { id: "n1", content: "v1", taskId: "t1" },
    ]);

    const [second] = manager.seed<TestNote>("TestNote", [
      { id: "n1", content: "v2", taskId: "t1" },
    ]);

    // Same instance, updated fields.
    expect(second).toBe(first);
    expect(second.content).toBe("v2");
  });

  it("returns [] for an unregistered model rather than throwing", async () => {
    manager = await makeManager();
    expect(manager.seed("DoesNotExist", [{ id: "x" }])).toEqual([]);
  });

  it("does not write to IDB or mark coverage", async () => {
    const adapter = new MemoryAdapter();
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

    manager.seed("TestNote", [{ id: "n1", content: "x", taskId: "t1" }]);

    expect(await adapter.readModel("TestNote", "n1")).toBeNull();
    expect(manager.isCollectionLoaded("TestNote", "taskId", "t1")).toBe(false);
    expect(manager.isModelFullyLoaded("TestNote")).toBe(false);
  });
});

describe("StoreManager.seedMany", () => {
  it("hydrates multiple model types in one call (bootstrap-response shape)", async () => {
    manager = await makeManager();
    manager.seedMany({
      TestNote: [
        { id: "n1", content: "hello", taskId: "t1" },
        { id: "n2", content: "world", taskId: "t1" },
      ],
      TestTask: [{ id: "t1", title: "First task" }],
    });

    expect(manager.objectPool.getAll<TestNote>("TestNote")).toHaveLength(2);
    expect(
      manager.objectPool.getById<TestTask>("TestTask", "t1")?.title,
    ).toBe("First task");
  });

  it("silently ignores entries whose model isn't registered", async () => {
    manager = await makeManager();
    manager.seedMany({
      TestNote: [{ id: "n1", content: "x", taskId: "t1" }],
      DoesNotExist: [{ id: "x" }],
    });
    expect(
      manager.objectPool.getById<TestNote>("TestNote", "n1"),
    ).toBeDefined();
  });
});
