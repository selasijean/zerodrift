import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  type MockedFunction,
} from "vitest";
import {
  StoreManager,
  RestrictDeleteError,
  type BootstrapResponse,
} from "@sync-engine/StoreManager";
import { BootstrapPhase } from "@sync-engine/types";
import {
  TestTask,
  TestProject,
  TestUser,
  TestComment,
  TestActivity,
  TestMetric,
  addToPool,
} from "./fixtures";
import { controllableSSEClient, makeFactory } from "./helpers/sseClient";

const emptyBootstrapResponse: BootstrapResponse = {
  lastSyncId: 0,
  subscribedSyncGroups: [],
  models: {},
};

let manager: StoreManager;

beforeEach(async () => {
  manager = new StoreManager({
    workspaceId: crypto.randomUUID(),
    bootstrapFetcher: vi.fn(),
  });
  // Connect the database so the TransactionQueue can cache transactions.
  await manager.database.connect();
});

afterEach(async () => {
  await manager.teardown();
});

describe("StoreManager", () => {
  // ── commitUpdate ───────────────────────────────────────────────────────────

  describe("commitUpdate()", () => {
    it("enqueues an update and increments pendingCount", () => {
      manager.commitUpdate("t1", "TestTask", {
        title: { oldValue: "Old", newValue: "New" },
      });
      expect(manager.transactionQueue.pendingCount).toBe(1);
    });
  });

  // ── deleteModel — restrict ─────────────────────────────────────────────────

  describe("deleteModel() — onDelete: restrict", () => {
    it("throws RestrictDeleteError when a Comment references the Task", () => {
      const task = new TestTask();
      task.hydrate({ id: "task-1", title: "Do it" });
      addToPool(manager, "TestTask", task);

      const comment = new TestComment();
      comment.hydrate({ id: "c-1", taskId: "task-1", text: "hello" });
      addToPool(manager, "TestComment", comment);

      expect(() => manager.deleteModel(task)).toThrow(RestrictDeleteError);
    });

    it("RestrictDeleteError carries model and property names", () => {
      const task = new TestTask();
      task.hydrate({ id: "task-1" });
      addToPool(manager, "TestTask", task);

      const comment = new TestComment();
      comment.hydrate({ id: "c-1", taskId: "task-1" });
      addToPool(manager, "TestComment", comment);

      try {
        manager.deleteModel(task);
        throw new Error("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(RestrictDeleteError);
        const e = err as RestrictDeleteError;
        expect(e.deletedModelName).toBe("TestTask");
        expect(e.deletedModelId).toBe("task-1");
        expect(e.restrictedByModel).toBe("TestComment");
        expect(e.restrictedByProperty).toBe("taskId");
      }
    });

    it("does NOT throw when there are no restricting references", () => {
      const task = new TestTask();
      task.hydrate({ id: "task-1" });
      addToPool(manager, "TestTask", task);
      // No comments in pool → allowed
      expect(() => manager.deleteModel(task)).not.toThrow();
    });
  });

  // ── deleteModel — cascade ──────────────────────────────────────────────────

  describe("deleteModel() — onDelete: cascade", () => {
    it("removes dependent tasks from the pool when a project is deleted", () => {
      const project = new TestProject();
      project.hydrate({ id: "proj-1", title: "My Project" });
      addToPool(manager, "TestProject", project);

      const task1 = new TestTask();
      task1.hydrate({ id: "t1", projectId: "proj-1" });
      addToPool(manager, "TestTask", task1);

      const task2 = new TestTask();
      task2.hydrate({ id: "t2", projectId: "proj-1" });
      addToPool(manager, "TestTask", task2);

      manager.deleteModel(project);

      expect(manager.objectPool.getById("TestTask", "t1")).toBeUndefined();
      expect(manager.objectPool.getById("TestTask", "t2")).toBeUndefined();
      expect(
        manager.objectPool.getById("TestProject", "proj-1"),
      ).toBeUndefined();
    });

    it("does not remove unrelated tasks", () => {
      const project = new TestProject();
      project.hydrate({ id: "proj-1" });
      addToPool(manager, "TestProject", project);

      const taskInProject = new TestTask();
      taskInProject.hydrate({ id: "t-in", projectId: "proj-1" });
      addToPool(manager, "TestTask", taskInProject);

      const taskOther = new TestTask();
      taskOther.hydrate({ id: "t-out", projectId: "proj-other" });
      addToPool(manager, "TestTask", taskOther);

      manager.deleteModel(project);

      expect(manager.objectPool.getById("TestTask", "t-in")).toBeUndefined();
      expect(manager.objectPool.getById("TestTask", "t-out")).toBeDefined();
    });

    it("enqueues delete transactions for cascaded dependents", () => {
      const project = new TestProject();
      project.hydrate({ id: "proj-1" });
      addToPool(manager, "TestProject", project);

      const task = new TestTask();
      task.hydrate({ id: "t1", projectId: "proj-1" });
      addToPool(manager, "TestTask", task);

      manager.deleteModel(project);

      // project delete + task delete = 2 transactions, grouped in one batch
      expect(manager.transactionQueue.pendingCount).toBe(2);
    });

    it("groups all cascade operations in a single undo batch", () => {
      const project = new TestProject();
      project.hydrate({ id: "proj-1" });
      addToPool(manager, "TestProject", project);

      for (let i = 0; i < 3; i++) {
        const t = new TestTask();
        t.hydrate({ id: `t${i}`, projectId: "proj-1" });
        addToPool(manager, "TestTask", t);
      }

      manager.deleteModel(project);

      // All cascade + root delete grouped as 1 batch entry
      expect(manager.transactionQueue.undoDepth).toBe(1);
    });
  });

  // ── deleteModel — nullify ──────────────────────────────────────────────────

  describe("deleteModel() — onDelete: nullify", () => {
    it("sets the FK to null on tasks that reference the deleted user", () => {
      const user = new TestUser();
      user.hydrate({ id: "user-1", name: "Alice" });
      addToPool(manager, "TestUser", user);

      const task = new TestTask();
      task.hydrate({ id: "t1", assigneeId: "user-1" });
      addToPool(manager, "TestTask", task);

      manager.deleteModel(user);

      expect(task.assigneeId).toBeNull();
    });

    it("removes the deleted user from the pool", () => {
      const user = new TestUser();
      user.hydrate({ id: "user-1" });
      addToPool(manager, "TestUser", user);

      manager.deleteModel(user);

      expect(manager.objectPool.getById("TestUser", "user-1")).toBeUndefined();
    });

    it("only nullifies tasks that reference the specific user", () => {
      const userA = new TestUser();
      userA.hydrate({ id: "user-A" });
      addToPool(manager, "TestUser", userA);

      const userB = new TestUser();
      userB.hydrate({ id: "user-B" });
      addToPool(manager, "TestUser", userB);

      const taskA = new TestTask();
      taskA.hydrate({ id: "t-A", assigneeId: "user-A" });
      addToPool(manager, "TestTask", taskA);

      const taskB = new TestTask();
      taskB.hydrate({ id: "t-B", assigneeId: "user-B" });
      addToPool(manager, "TestTask", taskB);

      manager.deleteModel(userA);

      expect(taskA.assigneeId).toBeNull();
      expect(taskB.assigneeId).toBe("user-B"); // untouched
    });
  });

  // ── batch API ──────────────────────────────────────────────────────────────

  describe("batch()", () => {
    it("groups multiple commitUpdates into one undo entry", () => {
      manager.batch(() => {
        manager.commitUpdate("t1", "TestTask", {
          title: { oldValue: "A", newValue: "B" },
        });
        manager.commitUpdate("t2", "TestTask", {
          title: { oldValue: "C", newValue: "D" },
        });
      });
      expect(manager.transactionQueue.undoDepth).toBe(1);
      expect(manager.transactionQueue.pendingCount).toBe(2);
    });
  });

  // ── getOrLoadCollection — onDemandFetcher ──────────────────────────────────────

  describe("getOrLoadCollection() with onDemandFetcher", () => {
    type OnDemandFetcher = (
      modelName: string,
      indexKey: string,
      value: string,
    ) => Promise<Record<string, unknown>[]>;
    let onDemandFetcher: MockedFunction<OnDemandFetcher>;
    let managerWithFetcher: StoreManager;

    beforeEach(async () => {
      onDemandFetcher = vi.fn().mockResolvedValue([]);
      managerWithFetcher = new StoreManager({
        workspaceId: crypto.randomUUID(),
        bootstrapFetcher: vi.fn(),
        onDemandFetcher,
      });
      await managerWithFetcher.database.connect();
    });

    afterEach(async () => {
      await managerWithFetcher.teardown();
    });

    it("calls onDemandFetcher on first access and hydrates results into pool", async () => {
      onDemandFetcher.mockResolvedValueOnce([
        { id: "a1", taskId: "t1", text: "first" },
        { id: "a2", taskId: "t1", text: "second" },
      ]);

      const results = await managerWithFetcher.getOrLoadCollection(
        "TestActivity",
        "taskId",
        "t1",
      );

      expect(onDemandFetcher).toHaveBeenCalledWith(
        "TestActivity",
        "taskId",
        "t1",
      );
      expect(results).toHaveLength(2);
      expect(
        managerWithFetcher.objectPool.getById("TestActivity", "a1"),
      ).toBeDefined();
      expect(
        managerWithFetcher.objectPool.getById("TestActivity", "a2"),
      ).toBeDefined();
    });

    it("does not call onDemandFetcher again on repeat access to the same collection", async () => {
      onDemandFetcher.mockResolvedValue([
        { id: "a1", taskId: "t1", text: "x" },
      ]);

      await managerWithFetcher.getOrLoadCollection("TestActivity", "taskId", "t1");
      await managerWithFetcher.getOrLoadCollection("TestActivity", "taskId", "t1");

      expect(onDemandFetcher).toHaveBeenCalledTimes(1);
    });

    it("calls onDemandFetcher separately for different parent IDs", async () => {
      await managerWithFetcher.getOrLoadCollection("TestActivity", "taskId", "t1");
      await managerWithFetcher.getOrLoadCollection("TestActivity", "taskId", "t2");

      expect(onDemandFetcher).toHaveBeenCalledTimes(2);
      expect(onDemandFetcher).toHaveBeenCalledWith(
        "TestActivity",
        "taskId",
        "t1",
      );
      expect(onDemandFetcher).toHaveBeenCalledWith(
        "TestActivity",
        "taskId",
        "t2",
      );
    });

    it("skips onDemandFetcher for Instant models", async () => {
      await managerWithFetcher.getOrLoadCollection(
        "TestTask",
        "projectId",
        "proj-1",
      );

      expect(onDemandFetcher).not.toHaveBeenCalled();
    });

    it("persists server records to IDB so they survive pool eviction", async () => {
      onDemandFetcher.mockResolvedValueOnce([
        { id: "a1", taskId: "t1", text: "persisted" },
      ]);

      await managerWithFetcher.getOrLoadCollection("TestActivity", "taskId", "t1");

      const idbRecord = await managerWithFetcher.database.readModel(
        "TestActivity",
        "a1",
      );
      expect(idbRecord).not.toBeNull();
      expect(idbRecord!.text).toBe("persisted");
    });

    it("includes records already in the pool (e.g. from prior SSE inserts)", async () => {
      // Simulate a record that arrived via SSE before the collection was loaded
      const existing = new TestActivity();
      existing.hydrate({ id: "a-sse", taskId: "t1", text: "from sse" });
      addToPool(managerWithFetcher, "TestActivity", existing);

      onDemandFetcher.mockResolvedValueOnce([
        { id: "a-server", taskId: "t1", text: "from server" },
      ]);

      const results = await managerWithFetcher.getOrLoadCollection(
        "TestActivity",
        "taskId",
        "t1",
      );

      const ids = results.map((r) => r.id).sort();
      expect(ids).toEqual(["a-server", "a-sse"]);
    });

    it("picks up records written to IDB by SSE before the first load", async () => {
      // SSE wrote a record to IDB but didn't hydrate it (collection wasn't loaded yet)
      await managerWithFetcher.database.writeModels("TestActivity", [
        { id: "a-idb", taskId: "t1", text: "idb only" },
      ]);

      // onDemandFetcher returns nothing new — server has nothing beyond what SSE wrote
      onDemandFetcher.mockResolvedValueOnce([]);

      const results = await managerWithFetcher.getOrLoadCollection(
        "TestActivity",
        "taskId",
        "t1",
      );

      expect(results.map((r) => r.id)).toContain("a-idb");
      expect(
        managerWithFetcher.objectPool.getById("TestActivity", "a-idb"),
      ).toBeDefined();
    });

    it("merges IDB partial records with additional server records", async () => {
      // IDB already has one record (e.g. from a prior SSE insert)
      await managerWithFetcher.database.writeModels("TestActivity", [
        { id: "a-idb", taskId: "t1", text: "partial" },
      ]);

      // Server knows about two more that IDB doesn't have yet
      onDemandFetcher.mockResolvedValueOnce([
        { id: "a-server-1", taskId: "t1", text: "server 1" },
        { id: "a-server-2", taskId: "t1", text: "server 2" },
      ]);

      const results = await managerWithFetcher.getOrLoadCollection(
        "TestActivity",
        "taskId",
        "t1",
      );

      const ids = results.map((r) => r.id).sort();
      expect(ids).toEqual(["a-idb", "a-server-1", "a-server-2"]);
    });
  });

  // ── getOrLoadById — onDemandFetcher ─────────────────────────────────────────────

  describe("getOrLoadById() with onDemandFetcher", () => {
    type OnDemandFetcher = (
      modelName: string,
      indexKey: string,
      value: string,
    ) => Promise<Record<string, unknown>[]>;
    let onDemandFetcher: MockedFunction<OnDemandFetcher>;
    let managerWithFetcher: StoreManager;

    beforeEach(async () => {
      onDemandFetcher = vi.fn().mockResolvedValue([]);
      managerWithFetcher = new StoreManager({
        workspaceId: crypto.randomUUID(),
        bootstrapFetcher: vi.fn(),
        onDemandFetcher,
      });
      await managerWithFetcher.database.connect();
    });

    afterEach(async () => {
      await managerWithFetcher.teardown();
    });

    it("returns model from pool without calling fetcher", async () => {
      const activity = new TestActivity();
      activity.hydrate({ id: "a1", taskId: "t1", text: "in pool" });
      addToPool(managerWithFetcher, "TestActivity", activity);

      const result = await managerWithFetcher.getOrLoadById("TestActivity", "a1");

      expect(result).toBe(activity);
      expect(onDemandFetcher).not.toHaveBeenCalled();
    });

    it("calls onDemandFetcher with ('id', id) when not in pool or IDB", async () => {
      onDemandFetcher.mockResolvedValueOnce([
        { id: "a1", taskId: "t1", text: "from server" },
      ]);

      await managerWithFetcher.getOrLoadById("TestActivity", "a1");

      expect(onDemandFetcher).toHaveBeenCalledWith("TestActivity", "id", "a1");
    });

    it("hydrates the fetched record into the pool", async () => {
      onDemandFetcher.mockResolvedValueOnce([
        { id: "a1", taskId: "t1", text: "fetched" },
      ]);

      const result = await managerWithFetcher.getOrLoadById("TestActivity", "a1");

      expect(result).not.toBeNull();
      expect(result!.id).toBe("a1");
      expect(
        managerWithFetcher.objectPool.getById("TestActivity", "a1"),
      ).toBeDefined();
    });

    it("persists server record to IDB", async () => {
      onDemandFetcher.mockResolvedValueOnce([
        { id: "a1", taskId: "t1", text: "persisted" },
      ]);

      await managerWithFetcher.getOrLoadById("TestActivity", "a1");

      const idbRecord = await managerWithFetcher.database.readModel(
        "TestActivity",
        "a1",
      );
      expect(idbRecord).not.toBeNull();
      expect(idbRecord!.text).toBe("persisted");
    });

    it("does not call fetcher again on repeat access to the same ID", async () => {
      onDemandFetcher.mockResolvedValue([
        { id: "a1", taskId: "t1", text: "x" },
      ]);

      await managerWithFetcher.getOrLoadById("TestActivity", "a1");
      await managerWithFetcher.getOrLoadById("TestActivity", "a1");

      expect(onDemandFetcher).toHaveBeenCalledTimes(1);
    });

    it("calls fetcher separately for different IDs", async () => {
      await managerWithFetcher.getOrLoadById("TestActivity", "a1");
      await managerWithFetcher.getOrLoadById("TestActivity", "a2");

      expect(onDemandFetcher).toHaveBeenCalledTimes(2);
      expect(onDemandFetcher).toHaveBeenCalledWith("TestActivity", "id", "a1");
      expect(onDemandFetcher).toHaveBeenCalledWith("TestActivity", "id", "a2");
    });

    it("returns null when fetcher returns empty and record is not in IDB", async () => {
      onDemandFetcher.mockResolvedValueOnce([]);

      const result = await managerWithFetcher.getOrLoadById(
        "TestActivity",
        "missing",
      );

      expect(result).toBeNull();
    });

    it("returns record from IDB without calling fetcher if already fetched once", async () => {
      onDemandFetcher.mockResolvedValueOnce([
        { id: "a1", taskId: "t1", text: "initial" },
      ]);
      await managerWithFetcher.getOrLoadById("TestActivity", "a1");

      // Evict from pool to simulate memory pressure
      managerWithFetcher.objectPool.remove("TestActivity", "a1");

      const result = await managerWithFetcher.getOrLoadById("TestActivity", "a1");

      expect(result).not.toBeNull();
      expect(onDemandFetcher).toHaveBeenCalledTimes(1); // not called again
    });

    it("skips fetcher when record already exists in IDB from bootstrap or SSE", async () => {
      // Simulate a record written to IDB before getOrLoadById is ever called (e.g. bootstrap or SSE)
      await managerWithFetcher.database.writeModels("TestActivity", [
        { id: "a1", taskId: "t1", text: "pre-seeded" },
      ]);

      const result = await managerWithFetcher.getOrLoadById("TestActivity", "a1");

      expect(result).not.toBeNull();
      expect(onDemandFetcher).not.toHaveBeenCalled();
    });
  });

  // ── getOrLoadByIds — onDemandBatchFetcher ─────────────────────────────────────

  describe("getOrLoadByIds() with onDemandBatchFetcher", () => {
    type OnDemandBatchFetcher = (
      modelName: string,
      ids: string[],
    ) => Promise<Record<string, unknown>[]>;
    let onDemandBatchFetcher: MockedFunction<OnDemandBatchFetcher>;
    let managerWithFetcher: StoreManager;

    beforeEach(async () => {
      onDemandBatchFetcher = vi.fn().mockResolvedValue([]);
      managerWithFetcher = new StoreManager({
        workspaceId: crypto.randomUUID(),
        bootstrapFetcher: vi.fn(),
        onDemandBatchFetcher,
      });
      await managerWithFetcher.database.connect();
    });

    afterEach(async () => {
      await managerWithFetcher.teardown();
    });

    it("returns empty array for empty input", async () => {
      const results = await managerWithFetcher.getOrLoadByIds("TestActivity", []);
      expect(results).toHaveLength(0);
      expect(onDemandBatchFetcher).not.toHaveBeenCalled();
    });

    it("returns models from pool without calling fetcher", async () => {
      const a1 = new TestActivity();
      a1.hydrate({ id: "a1", taskId: "t1", text: "pooled" });
      addToPool(managerWithFetcher, "TestActivity", a1);

      const results = await managerWithFetcher.getOrLoadByIds("TestActivity", [
        "a1",
      ]);

      expect(results).toHaveLength(1);
      expect(results[0]).toBe(a1);
      expect(onDemandBatchFetcher).not.toHaveBeenCalled();
    });

    it("returns models from IDB without calling fetcher", async () => {
      await managerWithFetcher.database.writeModels("TestActivity", [
        { id: "a1", taskId: "t1", text: "idb-only" },
      ]);

      const results = await managerWithFetcher.getOrLoadByIds("TestActivity", [
        "a1",
      ]);

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe("a1");
      expect(onDemandBatchFetcher).not.toHaveBeenCalled();
    });

    it("makes a single batch server call for all missing IDs", async () => {
      onDemandBatchFetcher.mockResolvedValueOnce([
        { id: "a1", taskId: "t1", text: "one" },
        { id: "a2", taskId: "t1", text: "two" },
      ]);

      const results = await managerWithFetcher.getOrLoadByIds("TestActivity", [
        "a1",
        "a2",
      ]);

      expect(onDemandBatchFetcher).toHaveBeenCalledTimes(1);
      expect(onDemandBatchFetcher).toHaveBeenCalledWith("TestActivity", [
        "a1",
        "a2",
      ]);
      expect(results).toHaveLength(2);
    });

    it("only fetches IDs not already in pool or IDB", async () => {
      const a1 = new TestActivity();
      a1.hydrate({ id: "a1", taskId: "t1", text: "pooled" });
      addToPool(managerWithFetcher, "TestActivity", a1);

      await managerWithFetcher.database.writeModels("TestActivity", [
        { id: "a2", taskId: "t1", text: "idb" },
      ]);

      onDemandBatchFetcher.mockResolvedValueOnce([
        { id: "a3", taskId: "t1", text: "server" },
      ]);

      const results = await managerWithFetcher.getOrLoadByIds("TestActivity", [
        "a1",
        "a2",
        "a3",
      ]);

      expect(onDemandBatchFetcher).toHaveBeenCalledWith("TestActivity", ["a3"]);
      expect(results).toHaveLength(3);
    });

    it("hydrates server records into the pool", async () => {
      onDemandBatchFetcher.mockResolvedValueOnce([
        { id: "a1", taskId: "t1", text: "fetched" },
      ]);

      await managerWithFetcher.getOrLoadByIds("TestActivity", ["a1"]);

      expect(
        managerWithFetcher.objectPool.getById("TestActivity", "a1"),
      ).toBeDefined();
    });

    it("persists server records to IDB", async () => {
      onDemandBatchFetcher.mockResolvedValueOnce([
        { id: "a1", taskId: "t1", text: "persisted" },
      ]);

      await managerWithFetcher.getOrLoadByIds("TestActivity", ["a1"]);

      const idbRecord = await managerWithFetcher.database.readModel(
        "TestActivity",
        "a1",
      );
      expect(idbRecord).not.toBeNull();
      expect(idbRecord!.text).toBe("persisted");
    });

    it("does not call fetcher again for the same IDs on repeat calls", async () => {
      onDemandBatchFetcher.mockResolvedValue([
        { id: "a1", taskId: "t1", text: "x" },
      ]);

      await managerWithFetcher.getOrLoadByIds("TestActivity", ["a1"]);
      await managerWithFetcher.getOrLoadByIds("TestActivity", ["a1"]);

      expect(onDemandBatchFetcher).toHaveBeenCalledTimes(1);
    });

    it("omits IDs the server does not return", async () => {
      onDemandBatchFetcher.mockResolvedValueOnce([
        { id: "a1", taskId: "t1", text: "found" },
      ]);

      const results = await managerWithFetcher.getOrLoadByIds("TestActivity", [
        "a1",
        "a2",
      ]);

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe("a1");
    });
  });

  // ── getOrLoadByIds — fallback to onDemandFetcher ───────────────────────────────

  describe("getOrLoadByIds() fallback to onDemandFetcher", () => {
    type OnDemandFetcher = (
      modelName: string,
      indexKey: string,
      value: string,
    ) => Promise<Record<string, unknown>[]>;
    let onDemandFetcher: MockedFunction<OnDemandFetcher>;
    let managerWithFetcher: StoreManager;

    beforeEach(async () => {
      onDemandFetcher = vi.fn().mockResolvedValue([]);
      managerWithFetcher = new StoreManager({
        workspaceId: crypto.randomUUID(),
        bootstrapFetcher: vi.fn(),
        onDemandFetcher,
      });
      await managerWithFetcher.database.connect();
    });

    afterEach(async () => {
      await managerWithFetcher.teardown();
    });

    it("falls back to individual getOrLoadById calls when no batch fetcher is configured", async () => {
      onDemandFetcher
        .mockResolvedValueOnce([{ id: "a1", taskId: "t1", text: "one" }])
        .mockResolvedValueOnce([{ id: "a2", taskId: "t1", text: "two" }]);

      const results = await managerWithFetcher.getOrLoadByIds("TestActivity", [
        "a1",
        "a2",
      ]);

      expect(onDemandFetcher).toHaveBeenCalledTimes(2);
      expect(onDemandFetcher).toHaveBeenCalledWith("TestActivity", "id", "a1");
      expect(onDemandFetcher).toHaveBeenCalledWith("TestActivity", "id", "a2");
      expect(results).toHaveLength(2);
    });
  });

  // ── getOrLoadByIds — no fetcher ────────────────────────────────────────────────

  describe("getOrLoadByIds() without fetcher", () => {
    it("returns models present in pool", async () => {
      const a1 = new TestActivity();
      a1.hydrate({ id: "a1", taskId: "t1", text: "pooled" });
      addToPool(manager, "TestActivity", a1);

      const results = await manager.getOrLoadByIds("TestActivity", ["a1"]);

      expect(results).toHaveLength(1);
      expect(results[0]).toBe(a1);
    });

    it("returns models present in IDB", async () => {
      await manager.database.writeModels("TestActivity", [
        { id: "a1", taskId: "t1", text: "idb" },
      ]);

      const results = await manager.getOrLoadByIds("TestActivity", ["a1"]);

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe("a1");
    });

    it("omits IDs not found anywhere", async () => {
      const results = await manager.getOrLoadByIds("TestActivity", ["ghost"]);
      expect(results).toHaveLength(0);
    });

    it("preserves request order regardless of storage order", async () => {
      for (const id of ["a1", "a2", "a3"]) {
        await manager.database.writeModels("TestActivity", [
          { id, taskId: "t1", text: id },
        ]);
      }

      // Request in non-sequential order to prove results match request, not storage
      const results = await manager.getOrLoadByIds("TestActivity", [
        "a3",
        "a1",
        "a2",
      ]);

      expect(results.map((r) => r.id)).toEqual(["a3", "a1", "a2"]);
    });

    it("returns empty array for an unregistered model name", async () => {
      const results = await manager.getOrLoadByIds("UnknownModel", ["x1"]);
      expect(results).toHaveLength(0);
    });

    it("handles duplicate IDs by returning the model once per occurrence", async () => {
      await manager.database.writeModels("TestActivity", [
        { id: "a1", taskId: "t1", text: "dedup" },
      ]);

      const results = await manager.getOrLoadByIds("TestActivity", ["a1", "a1"]);

      expect(results).toHaveLength(2);
      expect(results[0]).toBe(results[1]);
    });
  });

  // ── getOrLoadById — no fetcher ───────────────────────────────────────────────────

  describe("getOrLoadById() without onDemandFetcher", () => {
    it("returns model from pool", async () => {
      const activity = new TestActivity();
      activity.hydrate({ id: "a1", taskId: "t1", text: "pooled" });
      addToPool(manager, "TestActivity", activity);

      const result = await manager.getOrLoadById("TestActivity", "a1");

      expect(result).toBe(activity);
    });

    it("returns model from IDB if not in pool", async () => {
      await manager.database.writeModels("TestActivity", [
        { id: "a1", taskId: "t1", text: "idb" },
      ]);

      const result = await manager.getOrLoadById("TestActivity", "a1");

      expect(result).not.toBeNull();
      expect(result!.id).toBe("a1");
    });

    it("returns null when not in pool or IDB", async () => {
      const result = await manager.getOrLoadById("TestActivity", "ghost");

      expect(result).toBeNull();
    });
  });

  // ── undo / redo delegation ─────────────────────────────────────────────────

  describe("undo() / redo() delegation", () => {
    it("undo reverts a pooled model update", async () => {
      const task = new TestTask();
      task.hydrate({ id: "t1", title: "Original" });
      addToPool(manager, "TestTask", task);

      task.title = "Updated";
      manager.commitUpdate("t1", "TestTask", {
        title: { oldValue: "Original", newValue: "Updated" },
      });

      await manager.undo();

      expect(task.title).toBe("Original");
    });

    it("undo returns null on an empty stack", async () => {
      expect(await manager.undo()).toBeNull();
    });

    it("redo returns null when nothing to redo", async () => {
      expect(await manager.redo()).toBeNull();
    });
  });

  // ── Refresh APIs ───────────────────────────────────────────────────────────

  describe("refreshCollection()", () => {
    type OnDemandFetcher = (
      modelName: string,
      indexKey: string,
      value: string,
    ) => Promise<Record<string, unknown>[]>;
    let onDemandFetcher: MockedFunction<OnDemandFetcher>;
    let sm: StoreManager;

    beforeEach(async () => {
      onDemandFetcher = vi.fn().mockResolvedValue([]);
      sm = new StoreManager({
        workspaceId: crypto.randomUUID(),
        bootstrapFetcher: vi.fn(),
        onDemandFetcher,
      });
      await sm.database.connect();
    });

    afterEach(async () => {
      await sm.teardown();
    });

    it("updates existing models in-place and preserves object identity", async () => {
      onDemandFetcher.mockResolvedValueOnce([
        { id: "a1", taskId: "t1", text: "original" },
      ]);
      await sm.getOrLoadCollection("TestActivity", "taskId", "t1");
      expect(onDemandFetcher).toHaveBeenCalledTimes(1);

      const originalRef = sm.objectPool.getById("TestActivity", "a1");

      onDemandFetcher.mockResolvedValueOnce([
        { id: "a1", taskId: "t1", text: "refreshed" },
        { id: "a2", taskId: "t1", text: "new" },
      ]);
      const results = await sm.refreshCollection(
        "TestActivity",
        "taskId",
        "t1",
      );

      expect(onDemandFetcher).toHaveBeenCalledTimes(2);
      expect(results).toHaveLength(2);
      expect(
        (sm.objectPool.getById("TestActivity", "a1") as TestActivity).text,
      ).toBe("refreshed");
      // Same object reference — not a new instance
      expect(sm.objectPool.getById("TestActivity", "a1")).toBe(originalRef);
      expect(sm.objectPool.getById("TestActivity", "a2")).toBeDefined();
    });

    it("removes models the server no longer returns", async () => {
      onDemandFetcher.mockResolvedValueOnce([
        { id: "a1", taskId: "t1", text: "x" },
        { id: "a2", taskId: "t1", text: "y" },
      ]);
      await sm.getOrLoadCollection("TestActivity", "taskId", "t1");
      expect(sm.objectPool.getAll("TestActivity")).toHaveLength(2);

      onDemandFetcher.mockResolvedValueOnce([
        { id: "a1", taskId: "t1", text: "x" },
      ]);
      const results = await sm.refreshCollection(
        "TestActivity",
        "taskId",
        "t1",
      );

      expect(results).toHaveLength(1);
      expect(sm.objectPool.getById("TestActivity", "a2")).toBeUndefined();
    });

    it("works with ephemeral models (skips IDB)", async () => {
      onDemandFetcher.mockResolvedValueOnce([
        { id: "m1", value: 10, label: "cpu" },
      ]);
      await sm.getOrLoadCollection("TestMetric", "label", "cpu");
      expect(
        (sm.objectPool.getById("TestMetric", "m1") as TestMetric).value,
      ).toBe(10);

      onDemandFetcher.mockResolvedValueOnce([
        { id: "m1", value: 99, label: "cpu" },
      ]);
      const results = await sm.refreshCollection("TestMetric", "label", "cpu");

      expect(results).toHaveLength(1);
      expect(
        (sm.objectPool.getById("TestMetric", "m1") as TestMetric).value,
      ).toBe(99);
    });
  });

  describe("refreshModels()", () => {
    type OnDemandBatchFetcher = (
      modelName: string,
      ids: string[],
    ) => Promise<Record<string, unknown>[]>;
    let onDemandFetcher: MockedFunction<
      (m: string, k: string, v: string) => Promise<Record<string, unknown>[]>
    >;
    let onDemandBatchFetcher: MockedFunction<OnDemandBatchFetcher>;
    let sm: StoreManager;

    beforeEach(async () => {
      onDemandFetcher = vi.fn().mockResolvedValue([]);
      onDemandBatchFetcher = vi.fn().mockResolvedValue([]);
      sm = new StoreManager({
        workspaceId: crypto.randomUUID(),
        bootstrapFetcher: vi.fn(),
        onDemandFetcher,
        onDemandBatchFetcher,
      });
      await sm.database.connect();
    });

    afterEach(async () => {
      await sm.teardown();
    });

    it("updates existing models in-place and preserves object identity", async () => {
      onDemandBatchFetcher.mockResolvedValueOnce([
        { id: "a1", taskId: "t1", text: "original" },
      ]);
      await sm.getOrLoadByIds("TestActivity", ["a1"]);
      const originalRef = sm.objectPool.getById("TestActivity", "a1");
      expect((originalRef as TestActivity).text).toBe("original");

      onDemandBatchFetcher.mockResolvedValueOnce([
        { id: "a1", taskId: "t1", text: "refreshed" },
      ]);
      const results = await sm.refreshModels("TestActivity", ["a1"]);

      expect(results).toHaveLength(1);
      expect(
        (sm.objectPool.getById("TestActivity", "a1") as TestActivity).text,
      ).toBe("refreshed");
      // Same object reference
      expect(sm.objectPool.getById("TestActivity", "a1")).toBe(originalRef);
    });

    it("returns empty array for empty ids", async () => {
      const results = await sm.refreshModels("TestActivity", []);
      expect(results).toEqual([]);
    });

    it("works with ephemeral models (skips IDB)", async () => {
      onDemandBatchFetcher.mockResolvedValueOnce([
        { id: "m1", value: 10, label: "cpu" },
      ]);
      await sm.getOrLoadByIds("TestMetric", ["m1"]);
      expect(
        (sm.objectPool.getById("TestMetric", "m1") as TestMetric).value,
      ).toBe(10);

      onDemandBatchFetcher.mockResolvedValueOnce([
        { id: "m1", value: 99, label: "cpu" },
      ]);
      const results = await sm.refreshModels("TestMetric", ["m1"]);

      expect(results).toHaveLength(1);
      expect(
        (sm.objectPool.getById("TestMetric", "m1") as TestMetric).value,
      ).toBe(99);
    });
  });

  describe("refreshAllOfModel()", () => {
    type OnDemandFetcher = (
      modelName: string,
      indexKey: string,
      value: string,
    ) => Promise<Record<string, unknown>[]>;
    let onDemandFetcher: MockedFunction<OnDemandFetcher>;
    let sm: StoreManager;

    beforeEach(async () => {
      onDemandFetcher = vi.fn().mockResolvedValue([]);
      sm = new StoreManager({
        workspaceId: crypto.randomUUID(),
        bootstrapFetcher: vi.fn(),
        onDemandFetcher,
      });
      await sm.database.connect();
    });

    afterEach(async () => {
      await sm.teardown();
    });

    it("re-fetches all previously loaded collections for a model", async () => {
      onDemandFetcher.mockResolvedValueOnce([
        { id: "a1", taskId: "t1", text: "first" },
      ]);
      await sm.getOrLoadCollection("TestActivity", "taskId", "t1");

      onDemandFetcher.mockResolvedValueOnce([
        { id: "a2", taskId: "t2", text: "second" },
      ]);
      await sm.getOrLoadCollection("TestActivity", "taskId", "t2");

      expect(onDemandFetcher).toHaveBeenCalledTimes(2);

      // Refresh — should re-fetch both collections
      onDemandFetcher.mockResolvedValueOnce([
        { id: "a1", taskId: "t1", text: "refreshed-1" },
      ]);
      onDemandFetcher.mockResolvedValueOnce([
        { id: "a2", taskId: "t2", text: "refreshed-2" },
      ]);
      await sm.refreshAllOfModel("TestActivity");

      expect(onDemandFetcher).toHaveBeenCalledTimes(4);
      expect(
        (sm.objectPool.getById("TestActivity", "a1") as TestActivity).text,
      ).toBe("refreshed-1");
      expect(
        (sm.objectPool.getById("TestActivity", "a2") as TestActivity).text,
      ).toBe("refreshed-2");
    });

    it("re-fetches individually loaded IDs not covered by collections", async () => {
      const onDemandBatchFetcher = vi.fn().mockResolvedValue([]);

      // Create a StoreManager with both fetchers
      const smWithBatch = new StoreManager({
        workspaceId: crypto.randomUUID(),
        bootstrapFetcher: vi.fn(),
        onDemandFetcher,
        onDemandBatchFetcher,
      });
      await smWithBatch.database.connect();

      // Load a collection
      onDemandFetcher.mockResolvedValueOnce([
        { id: "a1", taskId: "t1", text: "coll" },
      ]);
      await smWithBatch.getOrLoadCollection("TestActivity", "taskId", "t1");

      // Load an individual model by ID (not part of any collection)
      onDemandBatchFetcher.mockResolvedValueOnce([
        { id: "a9", taskId: "t9", text: "individual" },
      ]);
      await smWithBatch.getOrLoadByIds("TestActivity", ["a9"]);
      expect(
        smWithBatch.objectPool.getById("TestActivity", "a9"),
      ).toBeDefined();

      // Refresh all — should re-fetch both the collection and the individual ID
      onDemandFetcher.mockResolvedValueOnce([
        { id: "a1", taskId: "t1", text: "coll-refreshed" },
      ]);
      onDemandBatchFetcher.mockResolvedValueOnce([
        { id: "a9", taskId: "t9", text: "individual-refreshed" },
      ]);
      await smWithBatch.refreshAllOfModel("TestActivity");

      expect(
        (smWithBatch.objectPool.getById("TestActivity", "a1") as TestActivity)
          .text,
      ).toBe("coll-refreshed");
      expect(
        (smWithBatch.objectPool.getById("TestActivity", "a9") as TestActivity)
          .text,
      ).toBe("individual-refreshed");

      await smWithBatch.teardown();
    });

    it("removes models the server no longer returns", async () => {
      onDemandFetcher.mockResolvedValueOnce([
        { id: "a1", taskId: "t1", text: "x" },
        { id: "a2", taskId: "t1", text: "y" },
      ]);
      await sm.getOrLoadCollection("TestActivity", "taskId", "t1");
      expect(sm.objectPool.getAll("TestActivity")).toHaveLength(2);

      // Server now returns only one record (a2 was deleted)
      onDemandFetcher.mockResolvedValueOnce([
        { id: "a1", taskId: "t1", text: "x" },
      ]);
      await sm.refreshAllOfModel("TestActivity");

      expect(sm.objectPool.getAll("TestActivity")).toHaveLength(1);
      expect(sm.objectPool.getById("TestActivity", "a2")).toBeUndefined();
    });
  });

  // ── fullBootstrap — Instant-only onlyModels ──────────────────────────────
  //
  // Bootstrap payloads only ever carry Instant models. Lazy / Partial /
  // ExplicitlyRequested / Local / Ephemeral are loaded on demand or via SSE
  // — never via a full-bootstrap payload — regardless of whether the adopter
  // wired up an `onDemandFetcher`.

  describe("fullBootstrap() — Instant-only onlyModels", () => {
    it("restricts onlyModels to Instant strategies (excludes Partial/Lazy/Ephemeral/etc)", async () => {
      const bootstrapFetcher = vi
        .fn()
        .mockResolvedValue(emptyBootstrapResponse);
      const sm = new StoreManager({
        workspaceId: crypto.randomUUID(),
        bootstrapFetcher,
      });

      await sm.bootstrap();

      const [, options] = bootstrapFetcher.mock.calls[0];
      expect(options.onlyModels).toBeDefined();
      // TestActivity is Partial, TestMetric is Ephemeral — neither belongs.
      expect(options.onlyModels).not.toContain("TestActivity");
      expect(options.onlyModels).not.toContain("TestMetric");
      expect(options.onlyModels).toContain("TestTask"); // Instant

      await sm.teardown();
    });

    it("excludes deferred models from phase 1 (still Instant-only)", async () => {
      const bootstrapFetcher = vi
        .fn()
        .mockResolvedValue(emptyBootstrapResponse);
      const sm = new StoreManager({
        workspaceId: crypto.randomUUID(),
        bootstrapFetcher,
        // deferredModels is the user's explicit phase-2 list — its members
        // should be excluded from phase 1 even though they're Instant.
        deferredModels: ["TestNote"],
      });

      await sm.bootstrap();

      const [, options] = bootstrapFetcher.mock.calls[0];
      expect(options.onlyModels).not.toContain("TestNote"); // deferred
      expect(options.onlyModels).not.toContain("TestActivity"); // Partial
      expect(options.onlyModels).toContain("TestTask"); // Instant, not deferred

      await sm.teardown();
    });
  });

  // ── teardown / bootstrap race ─────────────────────────────────────────────
  //
  // Guards against the StrictMode-style remount where bootstrap() is in flight
  // when teardown() fires. Without the stopped flag, bootstrap could keep
  // walking past the await boundaries and open a SyncConnection no one will
  // ever close.

  describe("teardown / bootstrap race", () => {
    it("teardown before SSE connect doesn't open an EventSource", async () => {
      const client = controllableSSEClient();
      const factory = vi.fn(makeFactory(client));
      let resolveFetcher!: (v: BootstrapResponse) => void;
      let phase: BootstrapPhase = BootstrapPhase.Idle;

      const sm = new StoreManager({
        workspaceId: crypto.randomUUID(),
        bootstrapFetcher: () =>
          new Promise<BootstrapResponse>((r) => {
            resolveFetcher = r;
          }),
        syncUrl: "http://localhost/sync",
        sseClientFactory: factory,
        onPhaseChange: (p) => {
          phase = p;
        },
      });

      const bootP = sm.bootstrap();
      bootP.catch(() => {});

      // Wait until bootstrap is suspended at the fetcher boundary —
      // i.e. past database.connect() and determineBootstrapType() but
      // before SyncConnection construction.
      await vi.waitFor(() => expect(phase).toBe(BootstrapPhase.Fetching));

      await sm.teardown();

      // Fetcher resolves AFTER teardown — bootstrap resumes and the stopped
      // check should short-circuit before reaching ConnectingSync.
      resolveFetcher(emptyBootstrapResponse);
      await new Promise((r) => setTimeout(r, 0));

      expect(factory).not.toHaveBeenCalled();
    });

    it("teardown after SSE connect closes the EventSource exactly once", async () => {
      const client = controllableSSEClient();
      const factory = vi.fn(makeFactory(client));

      const sm = new StoreManager({
        workspaceId: crypto.randomUUID(),
        bootstrapFetcher: vi.fn().mockResolvedValue(emptyBootstrapResponse),
        syncUrl: "http://localhost/sync",
        sseClientFactory: factory,
      });

      await sm.bootstrap();
      expect(factory).toHaveBeenCalledTimes(1);
      expect(client.close).not.toHaveBeenCalled();

      await sm.teardown();
      expect(client.close).toHaveBeenCalledTimes(1);
    });

    it("bootstrap → teardown → new bootstrap opens exactly one EventSource", async () => {
      // Simulates React 18 StrictMode: mount → cleanup → mount.
      const client = controllableSSEClient();
      const factory = vi.fn(makeFactory(client));
      const workspaceId = crypto.randomUUID();

      let resolveFirst!: (v: BootstrapResponse) => void;
      let phase1: BootstrapPhase = BootstrapPhase.Idle;
      const sm1 = new StoreManager({
        workspaceId,
        bootstrapFetcher: () =>
          new Promise<BootstrapResponse>((r) => {
            resolveFirst = r;
          }),
        syncUrl: "http://localhost/sync",
        sseClientFactory: factory,
        onPhaseChange: (p) => {
          phase1 = p;
        },
      });

      const bootP1 = sm1.bootstrap();
      bootP1.catch(() => {});
      await vi.waitFor(() => expect(phase1).toBe(BootstrapPhase.Fetching));
      await sm1.teardown();
      resolveFirst(emptyBootstrapResponse);
      await new Promise((r) => setTimeout(r, 0));

      const sm2 = new StoreManager({
        workspaceId,
        bootstrapFetcher: vi.fn().mockResolvedValue(emptyBootstrapResponse),
        syncUrl: "http://localhost/sync",
        sseClientFactory: factory,
      });
      await sm2.bootstrap();

      expect(factory).toHaveBeenCalledTimes(1);

      await sm2.teardown();
    });
  });

  // ── identifierFn / setContext / mintId ────────────────────────────────────

  describe("identifierFn + context", () => {
    it("falls back to crypto.randomUUID() when no identifierFn is configured", () => {
      const id = manager.mintId(new TestTask());
      expect(typeof id).toBe("string");
      expect(id.length).toBeGreaterThan(10);
    });

    it("calls identifierFn with the model's meta and the live context", () => {
      type Ctx = { tenantId: string };
      const fn = vi.fn(
        (meta, ctx: Ctx | undefined) =>
          `${ctx?.tenantId ?? "anon"}:${meta.name}:fixed`,
      );
      const sm = new StoreManager<Ctx>({
        workspaceId: "ws",
        bootstrapFetcher: vi.fn(),
        identifierFn: fn,
      });
      sm.setContext({ tenantId: "acme" });

      // `new` triggers the id initializer, which routes through mintId.
      const task = new TestTask();

      expect(task.id).toBe("acme:TestTask:fixed");
      expect(fn).toHaveBeenCalledTimes(1);
      const [metaArg, ctxArg] = fn.mock.calls[0]!;
      expect(metaArg.name).toBe("TestTask");
      expect(ctxArg).toEqual({ tenantId: "acme" });
    });

    it("setContext updates what subsequent mintId calls see", () => {
      type Ctx = { user: string };
      const fn = vi.fn(
        (_meta, ctx: Ctx | undefined) => `${ctx?.user ?? "none"}-id`,
      );
      const sm = new StoreManager<Ctx>({
        workspaceId: "ws",
        bootstrapFetcher: vi.fn(),
        identifierFn: fn,
      });

      const before = sm.mintId(new TestTask());
      sm.setContext({ user: "alice" });
      const afterFirst = sm.mintId(new TestTask());
      sm.setContext({ user: "bob" });
      const afterSecond = sm.mintId(new TestTask());

      expect(before).toBe("none-id");
      expect(afterFirst).toBe("alice-id");
      expect(afterSecond).toBe("bob-id");
    });

    it("falls back to crypto.randomUUID() when the model isn't registered", () => {
      const fn = vi.fn(() => "should-not-be-called");
      const sm = new StoreManager({
        workspaceId: "ws",
        bootstrapFetcher: vi.fn(),
        identifierFn: fn,
      });

      class Unregistered {}
      const id = sm.mintId(new Unregistered() as unknown as TestTask);

      expect(fn).not.toHaveBeenCalled();
      expect(typeof id).toBe("string");
      expect(id.length).toBeGreaterThan(10);
    });
  });
});
