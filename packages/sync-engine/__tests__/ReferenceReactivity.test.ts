import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeStoreManager } from "./helpers/storeManager";
import { StoreManager } from "@sync-engine/StoreManager";
import { ModelRegistry } from "@sync-engine/ModelRegistry";
import {
  TestProject,
  TestTask,
  TestUser,
  TestWorkspace,
  observe,
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

/**
 * The `@Reference` getter is a virtual lookup — it re-resolves through the pool
 * on every read instead of caching a value. These tests pin down the four
 * reactivity edges of that resolution: FK change, target deletion (no FK
 * change), target identity swap, and pool clear.
 */
describe("@Reference reactivity through the pool", () => {
  it("re-evaluates when the holder's FK changes", () => {
    const projectMeta = ModelRegistry.getModelMeta("TestProject")!;
    const a = manager.objectPool.hydrateAndPut("TestProject", projectMeta, {
      id: "p-a",
      title: "A",
      workspaceId: "w1",
    }) as TestProject;
    const b = manager.objectPool.hydrateAndPut("TestProject", projectMeta, {
      id: "p-b",
      title: "B",
      workspaceId: "w1",
    }) as TestProject;

    const taskMeta = ModelRegistry.getModelMeta("TestTask")!;
    const task = manager.objectPool.hydrateAndPut("TestTask", taskMeta, {
      id: "t1",
      projectId: "p-a",
      title: "Run migration",
    }) as TestTask;

    const { observed, dispose } = observe(() => task.project);

    expect(observed[0]).toBe(a);

    task.projectId = "p-b";
    expect(observed[observed.length - 1]).toBe(b);

    dispose();
  });

  it("re-evaluates when the target is removed from the pool while the FK is unchanged", () => {
    const projectMeta = ModelRegistry.getModelMeta("TestProject")!;
    const project = manager.objectPool.hydrateAndPut(
      "TestProject",
      projectMeta,
      { id: "p1", title: "P", workspaceId: "w1" },
    ) as TestProject;

    const taskMeta = ModelRegistry.getModelMeta("TestTask")!;
    const task = manager.objectPool.hydrateAndPut("TestTask", taskMeta, {
      id: "t1",
      projectId: "p1",
      title: "Run migration",
    }) as TestTask;

    const { observed, dispose } = observe(() => task.project);

    expect(observed[0]).toBe(project);

    // Remove the target without touching the holder's FK. Before the per-id
    // atom fix, this would leave observers stale: getById returns undefined
    // but no MobX dependency was tracking the pool.
    manager.objectPool.remove("TestProject", "p1");

    expect(observed.length).toBe(2);
    expect(observed[1]).toBeNull();
    expect(task.project).toBeNull();

    dispose();
  });

  it("re-evaluates when the target's pool entry is replaced with a new instance", () => {
    const projectMeta = ModelRegistry.getModelMeta("TestProject")!;
    const original = manager.objectPool.hydrateAndPut(
      "TestProject",
      projectMeta,
      { id: "p1", title: "Original", workspaceId: "w1" },
    ) as TestProject;

    const taskMeta = ModelRegistry.getModelMeta("TestTask")!;
    const task = manager.objectPool.hydrateAndPut("TestTask", taskMeta, {
      id: "t1",
      projectId: "p1",
      title: "Run migration",
    }) as TestTask;

    const { observed, dispose } = observe(() => task.project);

    expect(observed[0]).toBe(original);

    // Identity swap: remove + put with a freshly-constructed instance for the
    // same id. The atom fires twice (remove → null, put → new instance).
    manager.objectPool.remove("TestProject", "p1");
    const replacement = manager.objectPool.hydrateAndPut(
      "TestProject",
      projectMeta,
      { id: "p1", title: "Replacement", workspaceId: "w1" },
    ) as TestProject;

    expect(replacement).not.toBe(original);
    expect(task.project).toBe(replacement);
    expect(observed[observed.length - 1]).toBe(replacement);

    dispose();
  });

  it("does NOT re-fire when an existing target is updated in place via hydrate", () => {
    // Reading `task.project` (without drilling into properties) should track
    // pool identity, not field changes on the project. In-place hydrate keeps
    // the same instance — the atom should stay quiet so observers don't churn.
    const projectMeta = ModelRegistry.getModelMeta("TestProject")!;
    const project = manager.objectPool.hydrateAndPut(
      "TestProject",
      projectMeta,
      { id: "p1", title: "Initial", workspaceId: "w1" },
    ) as TestProject;

    const taskMeta = ModelRegistry.getModelMeta("TestTask")!;
    const task = manager.objectPool.hydrateAndPut("TestTask", taskMeta, {
      id: "t1",
      projectId: "p1",
      title: "Run migration",
    }) as TestTask;

    const { observed, dispose } = observe(() => task.project);

    // hydrate-and-put for an existing id reuses the instance and does NOT
    // mark the entry as new. Reading task.project should not re-fire.
    manager.objectPool.hydrateAndPut("TestProject", projectMeta, {
      id: "p1",
      title: "Updated",
      workspaceId: "w1",
    });

    expect(project.title).toBe("Updated");
    expect(observed).toHaveLength(1); // initial only
    expect(observed[0]).toBe(project);

    dispose();
  });

  it("re-evaluates a nullable @Reference when the user is deleted (cascade nullify path)", () => {
    // TestTask.assigneeId is nullable with onDelete: "nullify". Deleting the
    // user from the pool should let observers reading task.assignee see null.
    const userMeta = ModelRegistry.getModelMeta("TestUser")!;
    const user = manager.objectPool.hydrateAndPut("TestUser", userMeta, {
      id: "u1",
      name: "Alice",
      email: "a@b",
    }) as TestUser;

    const taskMeta = ModelRegistry.getModelMeta("TestTask")!;
    const task = manager.objectPool.hydrateAndPut("TestTask", taskMeta, {
      id: "t1",
      projectId: "",
      assigneeId: "u1",
      title: "Pair on this",
    }) as TestTask;

    const { observed, dispose } = observe(() => task.assignee);

    expect(observed[0]).toBe(user);
    manager.objectPool.remove("TestUser", "u1");
    expect(observed[observed.length - 1]).toBeNull();

    dispose();
  });

  it("clearing the pool wakes observers tracking @Reference reads", () => {
    const wsMeta = ModelRegistry.getModelMeta("TestWorkspace")!;
    const ws = manager.objectPool.hydrateAndPut("TestWorkspace", wsMeta, {
      id: "w1",
      name: "Workspace",
    }) as TestWorkspace;

    const projectMeta = ModelRegistry.getModelMeta("TestProject")!;
    const project = manager.objectPool.hydrateAndPut(
      "TestProject",
      projectMeta,
      { id: "p1", title: "P", workspaceId: "w1" },
    ) as TestProject;

    const { observed, dispose } = observe(() => project.workspace);

    expect(observed[0]).toBe(ws);

    manager.objectPool.clear();

    expect(observed[observed.length - 1]).toBeNull();
    expect(project.workspace).toBeNull();

    dispose();
  });
});
