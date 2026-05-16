import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeStoreManager } from "./helpers/storeManager";
import {
  StoreManager,
  type BootstrapResponse,
} from "@sync-engine/StoreManager";
import type { CommitIntent } from "@sync-engine/types";
import { TestTask, TestProject, addToPool } from "./fixtures";

const draftId = (id: string) => `draft:${id}`;

const emptyBootstrapResponse: BootstrapResponse = {
  lastSyncId: 0,
  subscribedSyncGroups: [],
  models: {},
};

describe("StoreManager.routeCommit", () => {
  let manager: StoreManager;
  let ops: CommitIntent[];

  beforeEach(async () => {
    ops = [];
  });

  afterEach(async () => {
    await manager.teardown();
  });

  it("fires for updates and lets the engine proceed by default", () => {
    manager = makeStoreManager({
      workspaceId: crypto.randomUUID(),
      bootstrapFetcher: vi.fn(async () => emptyBootstrapResponse),
      routeCommit: (op) => {
        ops.push(op);
      },
    });

    const task = new TestTask();
    task.hydrate({ id: "t1", title: "Old" });
    addToPool(manager, "TestTask", task);

    task.title = "New";
    task.save();

    expect(ops).toHaveLength(1);
    expect(ops[0].kind).toBe("update");
    expect(ops[0].modelName).toBe("TestTask");
    expect(ops[0].model).toBe(task);
    if (ops[0].kind === "update") {
      expect(ops[0].changes.title).toEqual({
        oldValue: "Old",
        newValue: "New",
      });
      expect(ops[0].previousData().title).toBe("Old");
    }
    expect(manager.transactionQueue.pendingCount).toBe(1);
  });

  it("fires for creates with the new model and modelName", () => {
    manager = makeStoreManager({
      workspaceId: crypto.randomUUID(),
      bootstrapFetcher: vi.fn(async () => emptyBootstrapResponse),
      routeCommit: (op) => {
        ops.push(op);
      },
    });

    const project = new TestProject();
    project.id = "p1";
    project.title = "New Project";
    project.save();

    expect(ops).toHaveLength(1);
    expect(ops[0].kind).toBe("create");
    expect(ops[0].modelName).toBe("TestProject");
    expect(ops[0].model).toBe(project);
    expect(manager.transactionQueue.pendingCount).toBe(1);
  });

  it("suppresses the update enqueue when router returns 'skip'", () => {
    manager = makeStoreManager({
      workspaceId: crypto.randomUUID(),
      bootstrapFetcher: vi.fn(async () => emptyBootstrapResponse),
      routeCommit: (op) => {
        if (op.kind === "update") {
          return "skip";
        }
      },
    });

    const task = new TestTask();
    task.hydrate({ id: "t1", title: "Old" });
    addToPool(manager, "TestTask", task);

    task.title = "New";
    task.save();

    expect(manager.transactionQueue.pendingCount).toBe(0);
  });

  it("suppresses create pool insert + enqueue when router returns 'skip'", () => {
    manager = makeStoreManager({
      workspaceId: crypto.randomUUID(),
      bootstrapFetcher: vi.fn(async () => emptyBootstrapResponse),
      routeCommit: () => "skip",
    });

    const project = new TestProject();
    project.id = "p1";
    project.title = "Skipped";
    project.save();

    expect(manager.objectPool.getById("TestProject", "p1")).toBeUndefined();
    expect(manager.transactionQueue.pendingCount).toBe(0);
  });

  it("routes a throwing router through onError and proceeds normally", () => {
    const errors: Array<{ err: Error; kind: string }> = [];
    manager = makeStoreManager({
      workspaceId: crypto.randomUUID(),
      bootstrapFetcher: vi.fn(async () => emptyBootstrapResponse),
      routeCommit: () => {
        throw new Error("boom");
      },
      onError: (err, ctx) => {
        errors.push({ err, kind: ctx.kind });
      },
    });

    const task = new TestTask();
    task.hydrate({ id: "t1", title: "Old" });
    addToPool(manager, "TestTask", task);

    task.title = "New";
    task.save();

    expect(errors).toHaveLength(1);
    expect(errors[0].kind).toBe("beforeCommit");
    expect(errors[0].err.message).toBe("boom");
    expect(manager.transactionQueue.pendingCount).toBe(1);
  });
});

describe("StoreManager.materializePoolOnly / clonePoolOnly", () => {
  let manager: StoreManager;

  beforeEach(async () => {
    manager = makeStoreManager({
      workspaceId: crypto.randomUUID(),
      bootstrapFetcher: vi.fn(async () => emptyBootstrapResponse),
    });
    await manager.database.connect();
  });

  afterEach(async () => {
    await manager.teardown();
  });

  it("materializes records into the pool without enqueueing transactions", () => {
    const clones = manager.materializePoolOnly<TestTask>("TestTask", [
      { id: "draft:t1", title: "A", projectId: "draft" },
      { id: "draft:t2", title: "B", projectId: "draft" },
    ]);

    expect(clones).toHaveLength(2);
    expect(manager.objectPool.getById("TestTask", "draft:t1")).toBe(clones[0]);
    expect(manager.objectPool.getById("TestTask", "draft:t2")).toBe(clones[1]);
    expect(clones[0].title).toBe("A");
    expect(clones[0].projectId).toBe("draft");
    expect(manager.transactionQueue.pendingCount).toBe(0);
  });

  it("clones sources into the pool without enqueueing transactions", () => {
    const t1 = new TestTask();
    t1.hydrate({ id: "t1", title: "A", projectId: "default" });
    addToPool(manager, "TestTask", t1);
    const t2 = new TestTask();
    t2.hydrate({ id: "t2", title: "B", projectId: "default" });
    addToPool(manager, "TestTask", t2);

    const clones = manager.clonePoolOnly([t1, t2], (data) => ({
      ...data,
      id: `draft:${data.id}`,
      projectId: "draft",
    }));

    expect(clones).toHaveLength(2);
    expect(manager.objectPool.getById("TestTask", "draft:t1")).toBe(clones[0]);
    expect(manager.objectPool.getById("TestTask", "draft:t2")).toBe(clones[1]);
    expect(clones[0].title).toBe("A");
    expect(clones[0].projectId).toBe("draft");
    expect(manager.transactionQueue.pendingCount).toBe(0);
  });

  it("wires clones into the in-memory index merge of getOrLoadCollection", async () => {
    const original = new TestTask();
    original.hydrate({ id: "t1", title: "A", projectId: "default" });
    addToPool(manager, "TestTask", original);

    manager.clonePoolOnly([original], (data) => ({
      ...data,
      id: `draft:${data.id}`,
      projectId: "draft",
    }));

    const draftCollection = await manager.getOrLoadCollection<TestTask>(
      "TestTask",
      "projectId",
      "draft",
    );
    expect(draftCollection.map((t) => t.id)).toEqual(["draft:t1"]);

    const defaultCollection = await manager.getOrLoadCollection<TestTask>(
      "TestTask",
      "projectId",
      "default",
    );
    expect(defaultCollection.map((t) => t.id)).toEqual(["t1"]);
  });

  it("throws when the transform leaves the id unchanged", () => {
    const t1 = new TestTask();
    t1.hydrate({ id: "t1", title: "A" });
    addToPool(manager, "TestTask", t1);

    expect(() => manager.clonePoolOnly([t1], (data) => ({ ...data }))).toThrow(
      /different id/,
    );
  });

  it("throws when materializing a record that collides by default", () => {
    const t1 = new TestTask();
    t1.hydrate({ id: "t1", title: "A" });
    addToPool(manager, "TestTask", t1);

    expect(() =>
      manager.materializePoolOnly("TestTask", [{ id: "t1", title: "B" }]),
    ).toThrow(/already exists/);
  });

  it("can explicitly hydrate over an existing pool record", () => {
    const t1 = new TestTask();
    t1.hydrate({ id: "t1", title: "A" });
    addToPool(manager, "TestTask", t1);

    const [hydrated] = manager.materializePoolOnly<TestTask>(
      "TestTask",
      [{ id: "t1", title: "B" }],
      { onCollision: "hydrate" },
    );

    expect(hydrated).toBe(t1);
    expect(t1.title).toBe("B");
  });

  it("composes with routeCommit to redirect an update onto a clone", () => {
    const t1 = new TestTask();
    t1.hydrate({ id: "t1", title: "Old", projectId: "default" });
    addToPool(manager, "TestTask", t1);

    manager = makeStoreManager({
      workspaceId: crypto.randomUUID(),
      bootstrapFetcher: vi.fn(async () => emptyBootstrapResponse),
      routeCommit: (op) => {
        // No adopter-side recursion guard needed: the engine suppresses
        // routing while it replays onto the redirect target.
        if (op.kind !== "update" || op.model.id !== "t1") {
          return;
        }
        const before = op.previousData();
        const [clone] = manager.materializePoolOnly<TestTask>("TestTask", [
          {
            ...before,
            id: draftId(before.id as string),
            projectId: "draft",
          },
        ]);

        return {
          action: "redirect",
          modelId: clone.id,
          restoreOriginal: true,
        };
      },
    });

    addToPool(manager, "TestTask", t1);

    t1.title = "New";
    t1.save();

    expect(t1.title).toBe("Old");
    const clone = manager.objectPool.getById<TestTask>("TestTask", "draft:t1");
    expect(clone?.title).toBe("New");
    expect(manager.transactionQueue.pendingCount).toBe(1);
  });

  it("composes with routeCommit to redirect a create", () => {
    const project = new TestProject();
    project.id = "p1";
    project.title = "Original";

    manager = makeStoreManager({
      workspaceId: crypto.randomUUID(),
      bootstrapFetcher: vi.fn(async () => emptyBootstrapResponse),
      routeCommit: (op) => {
        if (op.kind !== "create") {
          return;
        }
        return {
          action: "redirect",
          modelId: `draft:${op.model.id}`,
        };
      },
    });

    project.save();

    expect(manager.objectPool.getById("TestProject", "p1")).toBeUndefined();
    const clone = manager.objectPool.getById<TestProject>(
      "TestProject",
      "draft:p1",
    );
    expect(clone?.title).toBe("Original");
    expect(manager.transactionQueue.pendingCount).toBe(1);
  });

  it("a missing redirect target drops the write rather than committing the original", () => {
    const errors: string[] = [];
    const t1 = new TestTask();
    t1.hydrate({ id: "t1", title: "Old", projectId: "default" });
    addToPool(manager, "TestTask", t1);

    manager = makeStoreManager({
      workspaceId: crypto.randomUUID(),
      bootstrapFetcher: vi.fn(async () => emptyBootstrapResponse),
      routeCommit: (op) => {
        if (op.kind !== "update") {
          return;
        }
        return {
          action: "redirect",
          modelId: "draft:does-not-exist",
          restoreOriginal: true,
        };
      },
      onError: (err) => {
        errors.push(err.message);
      },
    });
    addToPool(manager, "TestTask", t1);

    t1.title = "New";
    t1.save();

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/redirect target not found/);
    // restoreOriginal honored, original NOT committed.
    expect(t1.title).toBe("Old");
    expect(manager.transactionQueue.pendingCount).toBe(0);
  });
});

describe("StoreManager.onModelTouched", () => {
  let manager: StoreManager;

  afterEach(async () => {
    await manager.teardown();
  });

  it("fires once on the clean→dirty transition, before save()", () => {
    const touched: Array<{ id: string; modelName: string }> = [];
    manager = makeStoreManager({
      workspaceId: crypto.randomUUID(),
      bootstrapFetcher: vi.fn(async () => emptyBootstrapResponse),
      onModelTouched: (model, modelName) => {
        touched.push({ id: model.id, modelName });
      },
    });

    const task = new TestTask();
    task.hydrate({ id: "t1", title: "Old" });
    addToPool(manager, "TestTask", task);

    task.title = "New";

    expect(touched).toEqual([{ id: "t1", modelName: "TestTask" }]);
    // No transaction — the hook fires before any save().
    expect(manager.transactionQueue.pendingCount).toBe(0);
  });

  it("does not re-fire on subsequent edits while the model stays dirty", () => {
    const touched: string[] = [];
    manager = makeStoreManager({
      workspaceId: crypto.randomUUID(),
      bootstrapFetcher: vi.fn(async () => emptyBootstrapResponse),
      onModelTouched: (model) => touched.push(model.id),
    });

    const task = new TestTask();
    task.hydrate({ id: "t1", title: "Old", done: false });
    addToPool(manager, "TestTask", task);

    task.title = "A";
    task.title = "B";
    task.done = true;

    expect(touched).toEqual(["t1"]);
  });

  it("fires again after save() clears pending changes", () => {
    const touched: string[] = [];
    manager = makeStoreManager({
      workspaceId: crypto.randomUUID(),
      bootstrapFetcher: vi.fn(async () => emptyBootstrapResponse),
      onModelTouched: (model) => touched.push(model.id),
    });

    const task = new TestTask();
    task.hydrate({ id: "t1", title: "Old" });
    addToPool(manager, "TestTask", task);

    task.title = "New";
    task.save();
    task.title = "Newer";

    expect(touched).toEqual(["t1", "t1"]);
  });

  it("is suppressed during the engine's redirect replay", () => {
    const touched: string[] = [];
    manager = makeStoreManager({
      workspaceId: crypto.randomUUID(),
      bootstrapFetcher: vi.fn(async () => emptyBootstrapResponse),
      onModelTouched: (model) => touched.push(model.id),
      routeCommit: (op) => {
        if (op.kind !== "update" || op.model.id !== "t1") {
          return;
        }
        const before = op.previousData();
        const [clone] = manager.materializePoolOnly<TestTask>("TestTask", [
          { ...before, id: draftId(before.id as string), projectId: "draft" },
        ]);
        return { action: "redirect", modelId: clone.id, restoreOriginal: true };
      },
    });

    const t1 = new TestTask();
    t1.hydrate({ id: "t1", title: "Old", projectId: "default" });
    addToPool(manager, "TestTask", t1);

    t1.title = "New";
    t1.save();

    // Only the user's touch on t1 — the engine's assign() onto the draft
    // clone during replay must not surface as a user-facing first edit.
    expect(touched).toEqual(["t1"]);
    expect(
      manager.objectPool.getById<TestTask>("TestTask", "draft:t1")?.title,
    ).toBe("New");
  });

  it("routes a throwing handler through onError without breaking the setter", () => {
    const errors: Array<{ message: string; kind: string }> = [];
    manager = makeStoreManager({
      workspaceId: crypto.randomUUID(),
      bootstrapFetcher: vi.fn(async () => emptyBootstrapResponse),
      onModelTouched: () => {
        throw new Error("touch-boom");
      },
      onError: (err, ctx) => {
        errors.push({ message: err.message, kind: ctx.kind });
      },
    });

    const task = new TestTask();
    task.hydrate({ id: "t1", title: "Old" });
    addToPool(manager, "TestTask", task);

    task.title = "New";

    expect(task.title).toBe("New"); // setter still completed
    expect(errors).toEqual([{ message: "touch-boom", kind: "onModelTouched" }]);
  });

  it("composes: first touch materializes the draft scaffold, save() redirects onto it", () => {
    const a = new TestTask();
    a.hydrate({ id: "a", title: "A", projectId: "default" });
    const b = new TestTask();
    b.hydrate({ id: "b", title: "B", projectId: "default" });

    let scaffolded = false;
    manager = makeStoreManager({
      workspaceId: crypto.randomUUID(),
      bootstrapFetcher: vi.fn(async () => emptyBootstrapResponse),
      onModelTouched: (model) => {
        if (scaffolded || model.id.startsWith("draft:")) {
          return;
        }
        scaffolded = true;
        // Clone every default-layer object into the draft scaffold up front.
        manager.clonePoolOnly([a, b], (data) => ({
          ...data,
          id: draftId(data.id as string),
          projectId: "draft",
        }));
      },
      routeCommit: (op) => {
        if (op.kind !== "update" || op.model.id.startsWith("draft:")) {
          return;
        }
        return {
          action: "redirect",
          modelId: draftId(op.model.id),
          restoreOriginal: true,
        };
      },
    });
    addToPool(manager, "TestTask", a);
    addToPool(manager, "TestTask", b);

    a.title = "A-edited";
    a.save();

    // Scaffold exists for the whole default layer the instant `a` was touched.
    expect(
      manager.objectPool.getById<TestTask>("TestTask", "draft:a")?.title,
    ).toBe("A-edited");
    expect(
      manager.objectPool.getById<TestTask>("TestTask", "draft:b")?.title,
    ).toBe("B");
    // Original reverted, write landed on the draft only.
    expect(a.title).toBe("A");
    expect(manager.transactionQueue.pendingCount).toBe(1);
  });
});
