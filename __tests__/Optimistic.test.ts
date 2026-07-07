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
import {
  TestTask,
  TestProject,
  TestGeo,
  codecFaults,
  addToPool,
} from "./fixtures";

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

  // ── Regression coverage for the high-effort code review ─────────────────────
  describe("settlement hardening", () => {
    it("commits into an already-open batch instead of throwing", async () => {
      const task = pooledTask({ id: "t1", title: "Old" });

      const d = deferred();
      // A batch held open across the persist window (async batch / undo-redo).
      const batchId = manager.beginBatch();
      const op = manager.optimistic(
        () => task.assign({ title: "New" }),
        () => d.promise,
      );
      d.resolve();
      await op; // must not throw or roll back
      manager.endBatch(batchId);

      expect(task.title).toBe("New");
      expect(task.hasUnsavedChanges).toBe(false);
      expect(manager.transactionQueue.pendingCount).toBe(1);
    });

    it("an optimistic commit landing during a parked atomic() doesn't join its scope", async () => {
      const task = pooledTask({ id: "t1", title: "T", done: false });
      // Plain staged edit made before any scope opens.
      task.assign({ done: true });
      expect(task.hasUnsavedChanges).toBe(true);

      const d = deferred();
      const op = manager.optimistic(
        () => task.assign({ title: "T2" }),
        () => d.promise,
      );

      const barrier = deferred();
      const atomicP = manager.atomic(async () => {
        await barrier.promise;
        throw new Error("abort");
      });

      // Commit fires while the atomic is parked — its updatedAt stamp must not
      // enroll task into the atomic scope.
      d.resolve();
      await op;

      barrier.resolve();
      await expect(atomicP).rejects.toThrow("abort");

      // The atomic's discard must not have wiped task's unrelated staged edit.
      expect(task.done).toBe(true);
    });
  });

  describe("same-field overlap settles in any order", () => {
    it("both ops rejecting (forward order) revert to the saved value, clean", async () => {
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

      d1.reject(new Error("boom1"));
      await expect(a).rejects.toThrow("boom1");
      d2.reject(new Error("boom2"));
      await expect(b).rejects.toThrow("boom2");

      expect(task.title).toBe("A");
      expect(task.hasUnsavedChanges).toBe(false);
      expect(manager.transactionQueue.pendingCount).toBe(0);
    });

    it("earlier op resolving then later rejecting keeps the saved value, clean", async () => {
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

      d1.resolve();
      await a; // op1's "B" reached the server (superseded locally by "C")
      d2.reject(new Error("boom"));
      await expect(b).rejects.toThrow("boom");

      // Land on op1's server-accepted value, clean, with A→B recorded locally.
      expect(task.title).toBe("B");
      expect(task.hasUnsavedChanges).toBe(false);
      expect(manager.transactionQueue.pendingCount).toBe(1);
    });

    it("both ops resolving commits both writes, final writer wins", async () => {
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

      d1.resolve();
      await a;
      d2.resolve();
      await b;

      expect(task.title).toBe("C");
      expect(task.hasUnsavedChanges).toBe(false);
      expect(manager.transactionQueue.pendingCount).toBe(2);
    });
  });

  describe("object-valued serializers", () => {
    it("commits and reverts a field whose serializer returns a fresh object", async () => {
      const geo = new TestGeo();
      geo.hydrate({ id: "g1", point: { lat: 1, lng: 2 }, label: "start" });
      addToPool(manager, "TestGeo", geo);

      const d1 = deferred();
      const op1 = manager.optimistic(
        () => geo.assign({ point: { lat: 3, lng: 4 } }),
        () => d1.promise,
      );
      d1.resolve();
      await op1;
      expect(geo.point).toEqual({ lat: 3, lng: 4 });
      expect(geo.hasUnsavedChanges).toBe(false);
      expect(manager.transactionQueue.pendingCount).toBe(1);

      const d2 = deferred();
      const op2 = manager.optimistic(
        () => geo.assign({ point: { lat: 9, lng: 9 } }),
        () => d2.promise,
      );
      expect(geo.point).toEqual({ lat: 9, lng: 9 });
      d2.reject(new Error("boom"));
      await expect(op2).rejects.toThrow("boom");
      expect(geo.point).toEqual({ lat: 3, lng: 4 });
      expect(geo.hasUnsavedChanges).toBe(false);
    });
  });

  describe("created models", () => {
    it("a successfully created model is clean, not phantom-dirty", async () => {
      const task = new TestTask();
      task.hydrate({ id: "t-new", projectId: "p1" });
      task.makeModelObservable();

      await manager.optimistic(
        () => task.assign({ title: "Created" }),
        async () => {},
      );

      expect(manager.objectPool.getById("TestTask", "t-new")).toBe(task);
      expect(task.hasUnsavedChanges).toBe(false);
      expect(manager.transactionQueue.pendingCount).toBe(1);
    });

    it("a plain save() of a new model leaves it clean", () => {
      const task = new TestTask();
      task.hydrate({ id: "t-plain" });
      task.makeModelObservable();
      task.assign({ title: "X" });
      task.save();
      expect(task.hasUnsavedChanges).toBe(false);
    });

    it("rolls a rejected unpooled create back to clean (no leftover dirt)", async () => {
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
      expect(task.title).toBe("");
      expect(task.hasUnsavedChanges).toBe(false);
      expect(manager.transactionQueue.pendingCount).toBe(0);
    });
  });

  describe("guards and link maintenance", () => {
    it("optimistic() opened inside an atomic() scope rejects without exfiltrating writes", async () => {
      const a = pooledTask({ id: "t1", title: "A" });
      const b = pooledTask({ id: "t2", title: "B" });

      let inner: Promise<unknown> | undefined;
      expect(() =>
        manager.atomic(() => {
          a.assign({ title: "A2" });
          inner = manager.optimistic(
            () => b.assign({ title: "B2" }),
            async () => {},
          );
          throw new Error("abort");
        }),
      ).toThrow("abort");

      await expect(inner).rejects.toThrow(/inside an atomic/);
      // atomic threw → a reverted; b's mutate never ran (guard fired first).
      expect(a.title).toBe("A");
      expect(b.title).toBe("B");
      expect(a.hasUnsavedChanges).toBe(false);
      expect(b.hasUnsavedChanges).toBe(false);
    });

    it("rolling back an optimistic FK change re-routes inverse links", async () => {
      const task = pooledTask({ id: "t1", title: "T", projectId: "p1" });
      const spy = vi.spyOn(manager.objectPool, "notifyReferenceChange");

      const d = deferred();
      const op = manager.optimistic(
        () => task.assign({ projectId: "p2" }),
        () => d.promise,
      );
      expect(spy).toHaveBeenCalledWith(task, "TestTask", "projectId", "p1", "p2");
      spy.mockClear();

      d.reject(new Error("boom"));
      await expect(op).rejects.toThrow("boom");

      // The revert must re-route p2 → p1 (the bug: it never fired).
      expect(spy).toHaveBeenCalledWith(task, "TestTask", "projectId", "p2", "p1");
      expect(task.projectId).toBe("p1");
    });

    it("plain discardUnsavedChanges() also re-routes inverse links on an FK revert", () => {
      // The fix lives in the shared discardField primitive, so the long-standing
      // discardUnsavedChanges() path picks it up too — not just optimistic().
      const task = pooledTask({ id: "t1", title: "T", projectId: "p1" });
      task.assign({ projectId: "p2" });

      const spy = vi.spyOn(manager.objectPool, "notifyReferenceChange");
      task.discardUnsavedChanges();

      expect(spy).toHaveBeenCalledWith(task, "TestTask", "projectId", "p2", "p1");
      expect(task.projectId).toBe("p1");
      expect(task.hasUnsavedChanges).toBe(false);
    });

    it("a deserializer throw during rollback isolates other models and preserves the persist error", async () => {
      const geo = new TestGeo();
      geo.hydrate({ id: "g1", code: "ok", label: "L" });
      addToPool(manager, "TestGeo", geo);
      const task = pooledTask({ id: "t1", title: "T" });

      const emitSpy = vi.spyOn(manager, "emitError");
      codecFaults.deserThrowsOn = "ok"; // arm: reverting code deserializes "ok" → throws
      try {
        const d = deferred();
        const op = manager.optimistic(() => {
          geo.assign({ code: "changed" });
          task.assign({ title: "T2" });
        }, () => d.promise);

        d.reject(new Error("persist failed"));
        await expect(op).rejects.toThrow("persist failed"); // not "deserializer boom"

        // The second model still reverted despite geo's throw.
        expect(task.title).toBe("T");
        expect(task.hasUnsavedChanges).toBe(false);
        expect(emitSpy).toHaveBeenCalledWith(
          expect.any(Error),
          expect.objectContaining({ kind: "optimisticSettle", phase: "rollback" }),
        );
      } finally {
        codecFaults.deserThrowsOn = null;
      }
    });
  });
});
