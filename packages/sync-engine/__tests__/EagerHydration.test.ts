import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeStoreManager } from "./helpers/storeManager";
import { StoreManager } from "@sync-engine/StoreManager";
import { ModelRegistry } from "@sync-engine/ModelRegistry";
import { BaseModel } from "@sync-engine/BaseModel";
import {
  TestEagerOwner,
  TestEagerChild,
  TestEagerHolder,
  TestProject,
} from "./fixtures";

let manager: StoreManager;

beforeEach(async () => {
  manager = makeStoreManager({
    workspaceId: crypto.randomUUID(),
    bootstrapFetcher: vi.fn(),
  });
  await manager.database.connect();
});

afterEach(async () => {
  await manager.teardown();
});

describe("Eager ReferenceCollection hydration", () => {
  it("auto-loads non-lazy collections when the parent is hydrated", async () => {
    await manager.database.writeModels("TestEagerChild", [
      { id: "c1", ownerId: "o1", name: "alpha" },
      { id: "c2", ownerId: "o1", name: "beta" },
      { id: "c3", ownerId: "o-other", name: "gamma" },
    ]);

    const meta = ModelRegistry.getModelMeta("TestEagerOwner")!;
    const owner = manager.objectPool.hydrateAndPut("TestEagerOwner", meta, {
      id: "o1",
      name: "Acme",
    }) as TestEagerOwner;

    // Eager load is fire-and-forget; await the in-flight promise via load().
    await owner.children.load();

    expect(owner.children.isLoaded).toBe(true);
    expect(owner.children.items.map((c) => c.id).sort()).toEqual(["c1", "c2"]);
  });

  it("recursively eager-loads non-lazy collections nested on children", async () => {
    await manager.database.writeModels("TestEagerChild", [
      { id: "c1", ownerId: "o1", name: "alpha" },
    ]);
    await manager.database.writeModels("TestEagerLeaf", [
      { id: "l1", childId: "c1", label: "leaf-1" },
      { id: "l2", childId: "c1", label: "leaf-2" },
      { id: "l3", childId: "c-other", label: "leaf-3" },
    ]);

    const meta = ModelRegistry.getModelMeta("TestEagerOwner")!;
    const owner = manager.objectPool.hydrateAndPut("TestEagerOwner", meta, {
      id: "o1",
      name: "Acme",
    }) as TestEagerOwner;

    // Wait for the parent's eager load to settle (children loaded into pool
    // via hydrateAndPut, which fires each child's own eager load too).
    await owner.children.load();
    const child = owner.children.items[0] as TestEagerChild;

    // The child's leaves were kicked off inside the child's makeModelObservable
    // — await its in-flight load to verify recursion completed.
    await child.leaves.load();

    expect(child.leaves.isLoaded).toBe(true);
    expect(child.leaves.items.map((l) => l.id).sort()).toEqual(["l1", "l2"]);
  });

  it("leaves lazy ReferenceCollections idle by default (no auto-load)", async () => {
    // TestProject.tasks has no `lazy` flag → defaults to lazy.
    await manager.database.writeModels("TestTask", [
      { id: "t1", projectId: "p1", title: "alpha" },
    ]);

    const meta = ModelRegistry.getModelMeta("TestProject")!;
    const project = manager.objectPool.hydrateAndPut("TestProject", meta, {
      id: "p1",
      title: "Demo",
    }) as TestProject;

    // Yield once so any (non-existent) eager load would have a chance to start.
    await Promise.resolve();
    expect(project.tasks.isLoaded).toBe(false);
    expect(project.tasks.isLoading).toBe(false);
  });

  it("does not eagerly load when no storeManager is wired", () => {
    // Detach the storeManager so makeModelObservable can't fire a load.
    BaseModel.storeManager = null;
    try {
      const owner = new TestEagerOwner();
      owner.hydrate({ id: "o1", name: "Acme" });
      owner.makeModelObservable();
      expect(owner.children.isLoaded).toBe(false);
      expect(owner.children.isLoading).toBe(false);
    } finally {
      BaseModel.storeManager = manager;
    }
  });
});

describe("Eager @Reference hydration", () => {
  it("pulls the referenced model into the pool when @Reference is eager", async () => {
    await manager.database.writeModels("TestUser", [
      { id: "u1", name: "Ada", email: "ada@example.com" },
    ]);

    const meta = ModelRegistry.getModelMeta("TestEagerHolder")!;
    manager.objectPool.hydrateAndPut("TestEagerHolder", meta, {
      id: "h1",
      name: "holder",
      refUserId: "u1",
    });

    // Eager load is fire-and-forget. getOrLoadById is idempotent — calling it again
    // either returns the in-flight result or finishes the read from IDB.
    const user = await manager.getOrLoadById("TestUser", "u1");
    expect(user).not.toBeNull();
    expect(manager.objectPool.getById("TestUser", "u1")).toBeDefined();
  });

  it("skips the load when the id is empty", async () => {
    const meta = ModelRegistry.getModelMeta("TestEagerHolder")!;
    manager.objectPool.hydrateAndPut("TestEagerHolder", meta, {
      id: "h1",
      name: "holder",
      refUserId: "",
    });

    await Promise.resolve();
    expect(manager.objectPool.getAll("TestUser")).toHaveLength(0);
  });

  it("does not affect lazy @Reference (default)", async () => {
    // TestTask.assignee has no `lazy` flag → defaults to lazy.
    await manager.database.writeModels("TestUser", [
      { id: "u1", name: "Ada", email: "ada@example.com" },
    ]);

    const meta = ModelRegistry.getModelMeta("TestTask")!;
    manager.objectPool.hydrateAndPut("TestTask", meta, {
      id: "t1",
      title: "x",
      assigneeId: "u1",
    });

    await Promise.resolve();
    // Default-lazy should not have pulled the user into the pool.
    expect(manager.objectPool.getById("TestUser", "u1")).toBeUndefined();
  });
});

describe("Eager @OwnedCollection hydration", () => {
  it("auto-loads owned items into the collection when @OwnedCollection is eager", async () => {
    await manager.database.writeModels("TestEagerLeaf", [
      { id: "l1", childId: "", label: "alpha" },
      { id: "l2", childId: "", label: "beta" },
      { id: "l3", childId: "", label: "gamma" },
    ]);

    const meta = ModelRegistry.getModelMeta("TestEagerHolder")!;
    const holder = manager.objectPool.hydrateAndPut("TestEagerHolder", meta, {
      id: "h1",
      name: "holder",
      leafIds: ["l1", "l2"],
    }) as TestEagerHolder;

    await holder.ownedLeaves.load();

    expect(holder.ownedLeaves.isLoaded).toBe(true);
    expect(holder.ownedLeaves.items.map((l) => l.id).sort()).toEqual([
      "l1",
      "l2",
    ]);
  });

  it("loads nothing when the ids array is empty", async () => {
    const meta = ModelRegistry.getModelMeta("TestEagerHolder")!;
    const holder = manager.objectPool.hydrateAndPut("TestEagerHolder", meta, {
      id: "h1",
      name: "holder",
      leafIds: [],
    }) as TestEagerHolder;

    await holder.ownedLeaves.load();
    expect(holder.ownedLeaves.items).toHaveLength(0);
  });
});
