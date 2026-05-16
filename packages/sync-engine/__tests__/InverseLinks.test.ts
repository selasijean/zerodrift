import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { StoreManager } from "@sync-engine/StoreManager";
import { ModelRegistry } from "@sync-engine/ModelRegistry";
import {
  TestEagerOwner,
  TestEagerChild,
  TestProject,
  TestTask,
  observe,
} from "./fixtures";

let manager: StoreManager;

beforeEach(async () => {
  manager = new StoreManager({
    workspaceId: crypto.randomUUID(),
    bootstrapFetcher: vi.fn(),
  });
  await manager.database.connect();
});

afterEach(async () => {
  await manager.teardown();
});

/**
 * These tests exercise the architecturally-correct path: parent RefCollections
 * track children automatically as the pool changes. No invalidate-then-reload
 * cycle, no useRecords-and-filter dance — just `parent.children.items` being
 * live at all times.
 */
describe("ObjectPool ↔ RefCollection inverse links", () => {
  it("attaches a child that enters the pool AFTER the parent", () => {
    const ownerMeta = ModelRegistry.getModelMeta("TestEagerOwner")!;
    const owner = manager.objectPool.hydrateAndPut("TestEagerOwner", ownerMeta, {
      id: "o1",
      name: "Acme",
    }) as TestEagerOwner;

    expect(owner.children.items).toHaveLength(0);

    const childMeta = ModelRegistry.getModelMeta("TestEagerChild")!;
    const child = manager.objectPool.hydrateAndPut("TestEagerChild", childMeta, {
      id: "c1",
      ownerId: "o1",
      name: "alpha",
    }) as TestEagerChild;

    expect(owner.children.items).toContain(child);
    expect(owner.children.items).toHaveLength(1);
  });

  it("backfills children that entered the pool BEFORE the parent", () => {
    const childMeta = ModelRegistry.getModelMeta("TestEagerChild")!;
    const c1 = manager.objectPool.hydrateAndPut("TestEagerChild", childMeta, {
      id: "c1",
      ownerId: "o1",
      name: "alpha",
    }) as TestEagerChild;
    const c2 = manager.objectPool.hydrateAndPut("TestEagerChild", childMeta, {
      id: "c2",
      ownerId: "o1",
      name: "beta",
    }) as TestEagerChild;

    const ownerMeta = ModelRegistry.getModelMeta("TestEagerOwner")!;
    const owner = manager.objectPool.hydrateAndPut("TestEagerOwner", ownerMeta, {
      id: "o1",
      name: "Acme",
    }) as TestEagerOwner;

    expect(owner.children.items.map((c) => c.id).sort()).toEqual(["c1", "c2"]);
    expect(owner.children.items).toContain(c1);
    expect(owner.children.items).toContain(c2);
  });

  it("detaches a child when it is removed from the pool", () => {
    const ownerMeta = ModelRegistry.getModelMeta("TestEagerOwner")!;
    const owner = manager.objectPool.hydrateAndPut("TestEagerOwner", ownerMeta, {
      id: "o1",
      name: "Acme",
    }) as TestEagerOwner;

    const childMeta = ModelRegistry.getModelMeta("TestEagerChild")!;
    manager.objectPool.hydrateAndPut("TestEagerChild", childMeta, {
      id: "c1",
      ownerId: "o1",
      name: "alpha",
    });

    expect(owner.children.items).toHaveLength(1);

    manager.objectPool.remove("TestEagerChild", "c1");
    expect(owner.children.items).toHaveLength(0);
  });

  it("moves a child between parent collections when its FK is reassigned", () => {
    const ownerMeta = ModelRegistry.getModelMeta("TestEagerOwner")!;
    const ownerA = manager.objectPool.hydrateAndPut("TestEagerOwner", ownerMeta, {
      id: "o-a",
      name: "A",
    }) as TestEagerOwner;
    const ownerB = manager.objectPool.hydrateAndPut("TestEagerOwner", ownerMeta, {
      id: "o-b",
      name: "B",
    }) as TestEagerOwner;

    const childMeta = ModelRegistry.getModelMeta("TestEagerChild")!;
    const child = manager.objectPool.hydrateAndPut("TestEagerChild", childMeta, {
      id: "c1",
      ownerId: "o-a",
      name: "alpha",
    }) as TestEagerChild;

    expect(ownerA.children.items).toContain(child);
    expect(ownerB.children.items).toHaveLength(0);

    // User-driven mutation via the prototype setter.
    child.ownerId = "o-b";

    expect(ownerA.children.items).toHaveLength(0);
    expect(ownerB.children.items).toContain(child);
  });

  it("re-routes a child via hydrate() — the SSE delta path", () => {
    const ownerMeta = ModelRegistry.getModelMeta("TestEagerOwner")!;
    const ownerA = manager.objectPool.hydrateAndPut("TestEagerOwner", ownerMeta, {
      id: "o-a",
      name: "A",
    }) as TestEagerOwner;
    const ownerB = manager.objectPool.hydrateAndPut("TestEagerOwner", ownerMeta, {
      id: "o-b",
      name: "B",
    }) as TestEagerOwner;

    const childMeta = ModelRegistry.getModelMeta("TestEagerChild")!;
    const child = manager.objectPool.hydrateAndPut("TestEagerChild", childMeta, {
      id: "c1",
      ownerId: "o-a",
      name: "alpha",
    }) as TestEagerChild;

    expect(ownerA.children.items).toContain(child);

    // hydrate() is the path applySyncAction takes for U/V/C — it bypasses the
    // prototype setter and writes directly to MobX boxes. The pool must still
    // see the FK transition and re-route.
    child.hydrate({ ownerId: "o-b" });

    expect(ownerA.children.items).toHaveLength(0);
    expect(ownerB.children.items).toContain(child);
  });

  it("triggers MobX reactions when items changes — the original BlockPage bug", () => {
    // Models in different types entering the pool independently should still
    // wake observers reading parent.children.items. This is the precise scenario
    // from the BlockPage / TableBlock report.
    const ownerMeta = ModelRegistry.getModelMeta("TestEagerOwner")!;
    const owner = manager.objectPool.hydrateAndPut("TestEagerOwner", ownerMeta, {
      id: "o1",
      name: "Acme",
    }) as TestEagerOwner;

    const { observed, dispose } = observe(() => owner.children.items.length);

    const childMeta = ModelRegistry.getModelMeta("TestEagerChild")!;
    manager.objectPool.hydrateAndPut("TestEagerChild", childMeta, {
      id: "c1",
      ownerId: "o1",
      name: "alpha",
    });
    manager.objectPool.hydrateAndPut("TestEagerChild", childMeta, {
      id: "c2",
      ownerId: "o1",
      name: "beta",
    });

    expect(observed).toEqual([0, 1, 2]);
    dispose();
  });

  it("ignores children whose FK doesn't match any parent in the pool", () => {
    const childMeta = ModelRegistry.getModelMeta("TestEagerChild")!;
    const child = manager.objectPool.hydrateAndPut("TestEagerChild", childMeta, {
      id: "c1",
      ownerId: "o-orphan",
      name: "alpha",
    }) as TestEagerChild;

    // No parent yet — attach is a silent no-op, no errors thrown.
    expect(child).toBeDefined();
  });

  it("works for lazy ReferenceCollections too — items reflects pool state", () => {
    // TestProject.tasks is a @LazyReferenceCollection. Even without ever
    // calling `.load()`, items should track pool changes.
    const projectMeta = ModelRegistry.getModelMeta("TestProject")!;
    const project = manager.objectPool.hydrateAndPut("TestProject", projectMeta, {
      id: "p1",
      title: "Migration",
      workspaceId: "w1",
    }) as TestProject;

    expect(project.tasks.items).toHaveLength(0);
    expect(project.tasks.isLoaded).toBe(false);

    const taskMeta = ModelRegistry.getModelMeta("TestTask")!;
    const task = manager.objectPool.hydrateAndPut("TestTask", taskMeta, {
      id: "t1",
      projectId: "p1",
      title: "Run migration",
    }) as TestTask;

    expect(project.tasks.items).toContain(task);
    // Still not "loaded" — items is hot but the loader has never run.
    expect(project.tasks.isLoaded).toBe(false);
  });
});
