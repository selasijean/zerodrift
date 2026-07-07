import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { makeStoreManager } from "./helpers/storeManager";
import { StoreManager, type BootstrapResponse } from "@zerodrift/StoreManager";
import { TestTask, TestProject, addToPool } from "./fixtures";

const emptyBootstrapResponse: BootstrapResponse = {
  lastSyncId: 0,
  subscribedSyncGroups: [],
  models: {},
};

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

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

function pooledTask(fields: Record<string, unknown>): TestTask {
  const task = new TestTask();
  task.hydrate(fields);
  addToPool(manager, "TestTask", task);
  return task;
}

function pooledProject(fields: Record<string, unknown>): TestProject {
  const project = new TestProject();
  project.hydrate(fields);
  addToPool(manager, "TestProject", project);
  return project;
}

describe("StoreManager.optimistic()", () => {
  describe("basic contract", () => {
    it("stages mutate synchronously and commits captured fields when persist resolves", async () => {
      const task = pooledTask({ id: "t1", title: "Old", done: false });

      const d = deferred();
      const op = manager.optimistic(
        () => task.assign({ title: "New" }),
        () => d.promise,
      );

      // Optimistic value visible immediately, staged not committed.
      expect(task.title).toBe("New");
      expect(task.hasUnsavedChanges).toBe(true);
      expect(manager.transactionQueue.pendingCount).toBe(0);

      d.resolve();
      await op;

      expect(task.title).toBe("New");
      expect(task.hasUnsavedChanges).toBe(false);
      expect(manager.transactionQueue.pendingCount).toBe(1);
    });

    it("passes mutate's return value to persist and resolves with persist's value", async () => {
      const task = pooledTask({ id: "t1", title: "Old" });

      const persist = vi.fn(async (payload: { title: string }) => {
        expect(payload).toEqual({ title: "New" });
        return 42;
      });
      const out = await manager.optimistic(() => {
        task.assign({ title: "New" });
        return { title: task.title };
      }, persist);

      expect(out).toBe(42);
      expect(persist).toHaveBeenCalledOnce();
    });

    it("reverts captured fields and re-throws when persist rejects", async () => {
      const task = pooledTask({ id: "t1", title: "Old", done: false });

      const d = deferred();
      const op = manager.optimistic(
        () => task.assign({ title: "New", done: true }),
        () => d.promise,
      );
      expect(task.title).toBe("New");

      d.reject(new Error("boom"));
      await expect(op).rejects.toThrow("boom");

      expect(task.title).toBe("Old");
      expect(task.done).toBe(false);
      expect(task.hasUnsavedChanges).toBe(false);
      expect(manager.transactionQueue.pendingCount).toBe(0);
    });

    it("reverts and never calls persist when mutate throws", async () => {
      const task = pooledTask({ id: "t1", title: "Old" });

      const persist = vi.fn(async () => {});
      await expect(
        manager.optimistic(() => {
          task.assign({ title: "New" });
          throw new Error("mutate-boom");
        }, persist),
      ).rejects.toThrow("mutate-boom");

      expect(persist).not.toHaveBeenCalled();
      expect(task.title).toBe("Old");
      expect(task.hasUnsavedChanges).toBe(false);
    });

    it("reverts when persist itself throws synchronously", async () => {
      const task = pooledTask({ id: "t1", title: "Old" });

      await expect(
        manager.optimistic(
          () => task.assign({ title: "New" }),
          () => {
            throw new Error("sync-boom");
          },
        ),
      ).rejects.toThrow("sync-boom");

      expect(task.title).toBe("Old");
      expect(task.hasUnsavedChanges).toBe(false);
    });

    it("collapses a multi-model commit into a single undo entry", async () => {
      const task = pooledTask({ id: "t1", title: "Old" });
      const project = pooledProject({ id: "p1", title: "Proj" });

      const undoDepthBefore = manager.transactionQueue.undoDepth;
      await manager.optimistic(() => {
        task.assign({ title: "New" });
        project.assign({ title: "Proj2" });
      }, async () => {});

      expect(manager.transactionQueue.undoDepth).toBe(undoDepthBefore + 1);
      expect(task.hasUnsavedChanges).toBe(false);
      expect(project.hasUnsavedChanges).toBe(false);
    });
  });

  describe("overlapping operations", () => {
    it("two overlapping operations touching different records both commit", async () => {
      const task = pooledTask({ id: "t1", title: "T-Old" });
      const project = pooledProject({ id: "p1", title: "P-Old" });

      const d1 = deferred();
      const d2 = deferred();
      const a = manager.optimistic(
        () => task.assign({ title: "T-New" }),
        () => d1.promise,
      );
      // Opening a second operation while the first persist is in flight
      // must not throw (the atomic() failure mode this API replaces).
      const b = manager.optimistic(
        () => project.assign({ title: "P-New" }),
        () => d2.promise,
      );

      expect(task.title).toBe("T-New");
      expect(project.title).toBe("P-New");

      d1.resolve();
      d2.resolve();
      await Promise.all([a, b]);

      expect(task.title).toBe("T-New");
      expect(project.title).toBe("P-New");
      expect(task.hasUnsavedChanges).toBe(false);
      expect(project.hasUnsavedChanges).toBe(false);
      expect(manager.transactionQueue.pendingCount).toBe(2);
    });

    it("rejecting one operation rolls back only its own records", async () => {
      const task = pooledTask({ id: "t1", title: "T-Old" });
      const project = pooledProject({ id: "p1", title: "P-Old" });

      const d1 = deferred();
      const d2 = deferred();
      const a = manager.optimistic(
        () => task.assign({ title: "T-New" }),
        () => d1.promise,
      );
      const b = manager.optimistic(
        () => project.assign({ title: "P-New" }),
        () => d2.promise,
      );

      d1.reject(new Error("boom"));
      await expect(a).rejects.toThrow("boom");
      d2.resolve();
      await b;

      expect(task.title).toBe("T-Old");
      expect(project.title).toBe("P-New");
      expect(project.hasUnsavedChanges).toBe(false);
    });

    it("overlapping operations on disjoint fields of the same record settle independently", async () => {
      const task = pooledTask({ id: "t1", title: "Old", done: false });

      const d1 = deferred();
      const d2 = deferred();
      const a = manager.optimistic(
        () => task.assign({ title: "New" }),
        () => d1.promise,
      );
      const b = manager.optimistic(
        () => task.assign({ done: true }),
        () => d2.promise,
      );

      d1.reject(new Error("boom"));
      await expect(a).rejects.toThrow("boom");

      // Only the first operation's field reverted; the second's is still staged.
      expect(task.title).toBe("Old");
      expect(task.done).toBe(true);
      expect(task.hasUnsavedChanges).toBe(true);

      d2.resolve();
      await b;
      expect(task.done).toBe(true);
      expect(task.hasUnsavedChanges).toBe(false);
    });

    it("same field: a later writer's value survives an earlier operation's rollback", async () => {
      const task = pooledTask({ id: "t1", title: "A" });

      const d1 = deferred();
      const d2 = deferred();
      const a = manager.optimistic(
        () => task.assign({ title: "B" }),
        () => d1.promise,
      );
      const b = manager.optimistic(
        () => task.assign({ title: "C" }),
        () => d2.promise,
      );

      d1.reject(new Error("boom"));
      await expect(a).rejects.toThrow("boom");
      // Operation b re-wrote the field — its value must not be clobbered.
      expect(task.title).toBe("C");

      d2.resolve();
      await b;
      expect(task.title).toBe("C");
      expect(task.hasUnsavedChanges).toBe(false);
    });

    it("same field: rollbacks unwind in reverse order like savepoints", async () => {
      const task = pooledTask({ id: "t1", title: "A" });

      const d1 = deferred();
      const d2 = deferred();
      const a = manager.optimistic(
        () => task.assign({ title: "B" }),
        () => d1.promise,
      );
      const b = manager.optimistic(
        () => task.assign({ title: "C" }),
        () => d2.promise,
      );

      d2.reject(new Error("boom-b"));
      await expect(b).rejects.toThrow("boom-b");
      // b reverts to a's staged value; the field stays dirty for a.
      expect(task.title).toBe("B");
      expect(task.hasUnsavedChanges).toBe(true);

      d1.reject(new Error("boom-a"));
      await expect(a).rejects.toThrow("boom-a");
      expect(task.title).toBe("A");
      expect(task.hasUnsavedChanges).toBe(false);
    });

    it("writes staged outside the operation during persist are not captured", async () => {
      const task = pooledTask({ id: "t1", title: "T-Old" });
      const project = pooledProject({ id: "p1", title: "P-Old" });

      const d = deferred();
      const op = manager.optimistic(
        () => task.assign({ title: "T-New" }),
        () => d.promise,
      );

      // A plain staged edit while persist is in flight — under the old
      // atomic()-held-across-await pattern this would have been swept into
      // the open scope and rolled back with it.
      project.assign({ title: "P-Staged" });

      d.reject(new Error("boom"));
      await expect(op).rejects.toThrow("boom");

      expect(project.title).toBe("P-Staged");
      expect(project.hasUnsavedChanges).toBe(true);
    });

    it("atomic() no longer throws while an optimistic persist is in flight", async () => {
      const task = pooledTask({ id: "t1", title: "T-Old" });
      const project = pooledProject({ id: "p1", title: "P-Old" });

      const d = deferred();
      const op = manager.optimistic(
        () => task.assign({ title: "T-New" }),
        () => d.promise,
      );

      manager.atomic(() => {
        project.assign({ title: "P-New" });
      });
      expect(project.title).toBe("P-New");
      expect(project.hasUnsavedChanges).toBe(false);

      d.resolve();
      await op;
      expect(task.hasUnsavedChanges).toBe(false);
    });
  });

  describe("pre-dirty fields", () => {
    it("a field already staged before mutate reverts to its staged value and stays dirty", async () => {
      const task = pooledTask({ id: "t1", title: "Saved" });
      task.assign({ title: "Staged" });

      const d = deferred();
      const op = manager.optimistic(
        () => task.assign({ title: "Optimistic" }),
        () => d.promise,
      );
      expect(task.title).toBe("Optimistic");

      d.reject(new Error("boom"));
      await expect(op).rejects.toThrow("boom");

      // Back to the pre-operation staged value, still dirty with the
      // original baseline.
      expect(task.title).toBe("Staged");
      expect(task.hasUnsavedChanges).toBe(true);
      task.discardUnsavedChanges();
      expect(task.title).toBe("Saved");
    });
  });

  describe("SSE rebase during persist", () => {
    it("a rollback lands on the rebased server value, not the stale pre-edit one", async () => {
      const task = pooledTask({ id: "t1", title: "Server-Old" });

      const d = deferred();
      const op = manager.optimistic(
        () => task.assign({ title: "Optimistic" }),
        () => d.promise,
      );

      // Server pushes a different value mid-flight; optimistic stays visible.
      task.hydrate({ title: "Server-New" });
      expect(task.title).toBe("Optimistic");

      d.reject(new Error("boom"));
      await expect(op).rejects.toThrow("boom");
      expect(task.title).toBe("Server-New");
    });
  });

  describe("updatedAt stamping", () => {
    it("commit stamps updatedAt into the same transaction and leaves the model clean", async () => {
      const task = pooledTask({ id: "t1", title: "Old" });
      const stampBefore = task.updatedAt;

      await manager.optimistic(
        () => task.assign({ title: "New" }),
        async () => {},
      );

      expect(task.updatedAt).not.toBe(stampBefore);
      expect(task.hasUnsavedChanges).toBe(false);
      expect(manager.transactionQueue.pendingCount).toBe(1);
    });
  });

  describe("created models", () => {
    it("an observable unpooled model built during mutate is committed whole on success", async () => {
      const task = new TestTask();
      task.hydrate({ id: "t-new", projectId: "p1" });
      task.makeModelObservable();

      await manager.optimistic(
        () => task.assign({ title: "Created" }),
        async () => {},
      );

      expect(manager.objectPool.getById("TestTask", "t-new")).toBe(task);
      expect(manager.transactionQueue.pendingCount).toBe(1);
    });

    it("an observable unpooled model is dropped on rollback", async () => {
      const task = new TestTask();
      task.hydrate({ id: "t-new" });
      task.makeModelObservable();

      await expect(
        manager.optimistic(
          () => task.assign({ title: "Created" }),
          async () => {
            throw new Error("boom");
          },
        ),
      ).rejects.toThrow("boom");

      expect(manager.objectPool.getById("TestTask", "t-new")).toBeUndefined();
      expect(manager.transactionQueue.pendingCount).toBe(0);
    });
  });

  describe("guards", () => {
    it("atomic() opened inside mutate throws and the operation reverts", async () => {
      const task = pooledTask({ id: "t1", title: "Old" });

      await expect(
        manager.optimistic(() => {
          task.assign({ title: "New" });
          manager.atomic(() => {});
        }, async () => {}),
      ).rejects.toThrow(/inside an optimistic/);

      expect(task.title).toBe("Old");
      expect(task.hasUnsavedChanges).toBe(false);
    });

    it("optimistic() opened inside mutate rejects", async () => {
      let inner: Promise<void> | null = null;
      await manager.optimistic(
        () => {
          inner = manager.optimistic(
            () => {},
            async () => {},
          );
        },
        async () => {},
      );
      await expect(inner!).rejects.toThrow(/cannot nest/);
    });
  });
});
