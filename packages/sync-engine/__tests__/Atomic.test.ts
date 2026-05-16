import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { StoreManager, type BootstrapResponse } from "@sync-engine/StoreManager";
import { TestTask, TestProject, addToPool } from "./fixtures";

const emptyBootstrapResponse: BootstrapResponse = {
  lastSyncId: 0,
  subscribedSyncGroups: [],
  models: {},
};

let manager: StoreManager;

beforeEach(async () => {
  manager = new StoreManager({
    workspaceId: crypto.randomUUID(),
    bootstrapFetcher: vi.fn(async () => emptyBootstrapResponse),
  });
  await manager.database.connect();
});

afterEach(async () => {
  await manager.teardown();
});

describe("StoreManager.atomic()", () => {
  describe("assign (no save)", () => {
    it("stages without enqueueing a transaction", () => {
      const task = new TestTask();
      task.hydrate({ id: "t1", title: "Old" });
      addToPool(manager, "TestTask", task);

      task.assign({ title: "New" });

      expect(task.title).toBe("New");
      expect(task.hasUnsavedChanges).toBe(true);
      expect(manager.transactionQueue.pendingCount).toBe(0);
    });
  });

  describe("commit path", () => {
    it("calls save() on every touched model when fn resolves", async () => {
      const task = new TestTask();
      task.hydrate({ id: "t1", title: "Old", done: false });
      addToPool(manager, "TestTask", task);

      const project = new TestProject();
      project.hydrate({ id: "p1", title: "Proj" });
      addToPool(manager, "TestProject", project);

      await manager.atomic(async () => {
        task.assign({ title: "New", done: true });
        project.assign({ title: "Proj2" });
        await Promise.resolve();
      });

      expect(task.hasUnsavedChanges).toBe(false);
      expect(project.hasUnsavedChanges).toBe(false);
      expect(manager.transactionQueue.pendingCount).toBe(2);
    });

    it("groups all saves into a single undo entry", async () => {
      const task = new TestTask();
      task.hydrate({ id: "t1", title: "Old" });
      addToPool(manager, "TestTask", task);

      const project = new TestProject();
      project.hydrate({ id: "p1", title: "Proj" });
      addToPool(manager, "TestProject", project);

      const undoDepthBefore = manager.transactionQueue.undoDepth;
      await manager.atomic(async () => {
        task.assign({ title: "New" });
        project.assign({ title: "Proj2" });
      });
      expect(manager.transactionQueue.undoDepth).toBe(undoDepthBefore + 1);
    });

    it("returns the value the callback returns (sync)", () => {
      const task = new TestTask();
      task.hydrate({ id: "t1", title: "Old" });
      addToPool(manager, "TestTask", task);

      const out = manager.atomic(() => {
        task.assign({ title: "New" });
        return 42;
      });
      expect(out).toBe(42);
    });

    it("returns the value the callback returns (async)", async () => {
      const task = new TestTask();
      task.hydrate({ id: "t1", title: "Old" });
      addToPool(manager, "TestTask", task);

      const out = await manager.atomic(async () => {
        task.assign({ title: "New" });
        return 42;
      });
      expect(out).toBe(42);
    });
  });

  describe("rollback path", () => {
    it("discards every touched model's pending changes when fn throws (sync)", () => {
      const task = new TestTask();
      task.hydrate({ id: "t1", title: "Old" });
      addToPool(manager, "TestTask", task);

      const project = new TestProject();
      project.hydrate({ id: "p1", title: "Proj" });
      addToPool(manager, "TestProject", project);

      expect(() =>
        manager.atomic(() => {
          task.assign({ title: "New" });
          project.assign({ title: "Proj2" });
          throw new Error("boom");
        }),
      ).toThrow("boom");

      expect(task.title).toBe("Old");
      expect(project.title).toBe("Proj");
      expect(task.hasUnsavedChanges).toBe(false);
      expect(project.hasUnsavedChanges).toBe(false);
      expect(manager.transactionQueue.pendingCount).toBe(0);
    });

    it("discards every touched model's pending changes when async fn rejects", async () => {
      const task = new TestTask();
      task.hydrate({ id: "t1", title: "Old" });
      addToPool(manager, "TestTask", task);

      await expect(
        manager.atomic(async () => {
          task.assign({ title: "New" });
          await Promise.resolve();
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");

      expect(task.title).toBe("Old");
      expect(task.hasUnsavedChanges).toBe(false);
      expect(manager.transactionQueue.pendingCount).toBe(0);
    });
  });

  describe("rebase under SSE during atomic", () => {
    it("a delta on a touched field rebases the discard baseline", async () => {
      const task = new TestTask();
      task.hydrate({ id: "t1", title: "Server-Old" });
      addToPool(manager, "TestTask", task);

      // Simulate an SSE delta arriving mid-await on a field we're optimistically editing.
      await expect(
        manager.atomic(async () => {
          task.assign({ title: "Optimistic" });
          // Optimistic value visible to the user
          expect(task.title).toBe("Optimistic");
          // Server pushes a different value
          task.hydrate({ title: "Server-New" });
          // Optimistic value still visible — server didn't clobber it
          expect(task.title).toBe("Optimistic");
          throw new Error("rollback");
        }),
      ).rejects.toThrow("rollback");

      // Discard landed on the rebased server value, not the stale "Server-Old"
      expect(task.title).toBe("Server-New");
    });

    it("an echo of our optimistic value is a no-op", async () => {
      const task = new TestTask();
      task.hydrate({ id: "t1", title: "Server-Old" });
      addToPool(manager, "TestTask", task);

      await expect(
        manager.atomic(async () => {
          task.assign({ title: "Same" });
          // SSE echoes our own value back
          task.hydrate({ title: "Same" });
          expect(task.title).toBe("Same");
          throw new Error("rollback");
        }),
      ).rejects.toThrow("rollback");

      // Echo didn't rebase — discard restores original baseline
      expect(task.title).toBe("Server-Old");
    });

    it("a delta on an untouched field of a touched model still applies", async () => {
      const task = new TestTask();
      task.hydrate({ id: "t1", title: "Old", done: false });
      addToPool(manager, "TestTask", task);

      await manager.atomic(async () => {
        task.assign({ title: "New" });
        // SSE updates a different field
        task.hydrate({ done: true });
        expect(task.done).toBe(true);
        expect(task.title).toBe("New");
      });

      expect(task.title).toBe("New");
      expect(task.done).toBe(true);
    });
  });

  describe("nesting", () => {
    it("throws when an atomic is opened inside another atomic", () => {
      expect(() =>
        manager.atomic(() => {
          manager.atomic(() => {});
        }),
      ).toThrow(/nested/i);
    });

    it("clears the active scope after a sync atomic resolves", () => {
      const task = new TestTask();
      task.hydrate({ id: "t1", title: "Old" });
      addToPool(manager, "TestTask", task);

      manager.atomic(() => {
        task.assign({ title: "A" });
      });
      // A second atomic should work — scope was cleared.
      manager.atomic(() => {
        task.assign({ title: "B" });
      });
      expect(task.title).toBe("B");
    });
  });

  describe("no-op atomic", () => {
    it("commits cleanly when fn touches nothing", async () => {
      await manager.atomic(async () => {
        // nothing
      });
      expect(manager.transactionQueue.pendingCount).toBe(0);
    });
  });
});
