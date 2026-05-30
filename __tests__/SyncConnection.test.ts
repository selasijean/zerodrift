import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SyncConnection } from "@zerodrift/SyncConnection";
import { Database } from "@zerodrift/Database";
import { ObjectPool } from "@zerodrift/ObjectPool";
import { TransactionQueue } from "@zerodrift/TransactionQueue";
import { BaseModel } from "@zerodrift/BaseModel";
import { TestTask, TestProject, TestNote, TestActivity } from "./fixtures";
import type {
  DeltaPacket,
  SyncMessageTransform,
} from "@zerodrift/SyncConnection";
import {
  controllableSSEClient,
  makeFactory,
  sendMessage,
} from "./helpers/sseClient";
import { makeSyncConnection } from "./helpers/makeSyncConnection";

// We test processDeltaPacket directly (private) to avoid needing a real EventSource.
const process = (conn: SyncConnection, packet: DeltaPacket) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (conn as any).processDeltaPacket(packet);

let db: Database;
let pool: ObjectPool;
let queue: TransactionQueue;
let conn: SyncConnection;

beforeEach(async () => {
  BaseModel.storeManager = null;
  db = new Database(crypto.randomUUID());
  await db.connect();

  // SyncConnection reads currentMeta; save a baseline so it doesn't bail early.
  await db.saveMeta({
    lastSyncId: 0,
    subscribedSyncGroups: [],
    schemaHash: "test",
    dbVersion: 1,
    backendDatabaseVersion: 0,
  });

  pool = new ObjectPool();
  queue = new TransactionQueue(db, pool);
  conn = makeSyncConnection({ db, pool, queue });
});

afterEach(async () => {
  BaseModel.storeManager = null;
  conn.disconnect();
  await db.destroy();
});

describe("SyncConnection", () => {
  // ── Insert action (I) ──────────────────────────────────────────────────────

  describe("action: I (insert)", () => {
    it("adds a new model to the pool", async () => {
      await process(conn, {
        syncId: 1,
        syncActions: [
          {
            action: "I",
            modelName: "TestTask",
            modelId: "t1",
            data: { title: "New task", done: false },
          },
        ],
      });

      const task = pool.getById("TestTask", "t1");
      expect(task).toBeDefined();
      expect((task as TestTask).title).toBe("New task");
    });

    it("writes the record to IndexedDB", async () => {
      await process(conn, {
        syncId: 1,
        syncActions: [
          {
            action: "I",
            modelName: "TestTask",
            modelId: "t2",
            data: { title: "Persisted" },
          },
        ],
      });

      const record = await db.readModel("TestTask", "t2");
      expect(record).not.toBeNull();
      expect(record!.title).toBe("Persisted");
    });

    it("updates an existing in-memory model rather than replacing it", async () => {
      const existing = new TestTask();
      existing.hydrate({ id: "t1", title: "Old title" });
      existing.makeModelObservable();
      pool.put("TestTask", existing);

      await process(conn, {
        syncId: 1,
        syncActions: [
          {
            action: "I",
            modelName: "TestTask",
            modelId: "t1",
            data: { title: "Updated by server" },
          },
        ],
      });

      // Same object reference — not replaced
      expect(pool.getById("TestTask", "t1")).toBe(existing);
      expect(existing.title).toBe("Updated by server");
    });

    it("advances lastSyncId in meta", async () => {
      await process(conn, {
        syncId: 42,
        syncActions: [
          {
            action: "I",
            modelName: "TestTask",
            modelId: "t1",
            data: { title: "x" },
          },
        ],
      });

      const meta = await db.loadMeta();
      expect(meta!.lastSyncId).toBe(42);
    });

    it("skips saveMeta on replay packets that neither advance syncId nor change groups", async () => {
      const baseline = await db.loadMeta();
      baseline!.lastSyncId = 50;
      await db.saveMeta(baseline!);

      const saveSpy = vi.spyOn(db, "saveMeta");

      await process(conn, {
        syncId: 10,
        syncActions: [
          {
            action: "I",
            modelName: "TestTask",
            modelId: "t-replay",
            data: { title: "replay" },
          },
        ],
      });

      expect(saveSpy).not.toHaveBeenCalled();
      saveSpy.mockRestore();
    });
  });

  // ── Stale packet handling ─────────────────────────────────────────────────

  describe("stale packets (replay)", () => {
    beforeEach(async () => {
      const baseline = await db.loadMeta();
      baseline!.lastSyncId = 50;
      await db.saveMeta(baseline!);
    });

    it("does not apply syncActions to the in-memory pool", async () => {
      const existing = new TestTask();
      existing.hydrate({ id: "t1", title: "Newer state" });
      existing.makeModelObservable();
      pool.put("TestTask", existing);

      await process(conn, {
        syncId: 10,
        syncActions: [
          {
            action: "U",
            modelName: "TestTask",
            modelId: "t1",
            data: { title: "Older state — would clobber" },
          },
        ],
      });

      expect(existing.title).toBe("Newer state");
    });

    it("does not write stale syncActions to IndexedDB", async () => {
      await db.writeModels("TestTask", [{ id: "t1", title: "Newer" }]);

      await process(conn, {
        syncId: 10,
        syncActions: [
          {
            action: "U",
            modelName: "TestTask",
            modelId: "t1",
            data: { title: "Older — would clobber" },
          },
        ],
      });

      const record = await db.readModel("TestTask", "t1");
      expect(record!.title).toBe("Newer");
    });

    it("still processes sync-group changes on a stale packet", async () => {
      const onSyncGroupsChanged = vi.fn().mockResolvedValue(undefined);
      const c = makeSyncConnection({ db, pool, queue, onSyncGroupsChanged });

      await process(c, {
        syncId: 10,
        syncActions: [],
        addedSyncGroups: ["team-new"],
      });

      expect(onSyncGroupsChanged).toHaveBeenCalledWith(["team-new"], []);
      const meta = await db.loadMeta();
      expect(meta!.subscribedSyncGroups).toContain("team-new");
      expect(meta!.lastSyncId).toBe(50); // not advanced
      c.disconnect();
    });

    it("still fires onPacket and resolveBySync on a stale packet", async () => {
      const resolveSpy = vi.spyOn(queue, "resolveBySync");
      const onPacket = vi.fn();
      const c = makeSyncConnection({ db, pool, queue, onPacket });

      const stalePacket: DeltaPacket = {
        syncId: 10,
        syncActions: [
          {
            action: "I",
            modelName: "TestTask",
            modelId: "t-stale",
            data: { title: "ignored" },
          },
        ],
      };
      await process(c, stalePacket);

      expect(resolveSpy).toHaveBeenCalledWith(10);
      expect(onPacket).toHaveBeenCalledWith(stalePacket);
      c.disconnect();
    });
  });

  // ── Update action (U) ──────────────────────────────────────────────────────

  describe("action: U (update)", () => {
    it("updates an in-memory model's properties", async () => {
      const task = new TestTask();
      task.hydrate({ id: "t1", title: "Before" });
      task.makeModelObservable();
      pool.put("TestTask", task);

      await process(conn, {
        syncId: 2,
        syncActions: [
          {
            action: "U",
            modelName: "TestTask",
            modelId: "t1",
            data: { title: "After" },
          },
        ],
      });

      expect(task.title).toBe("After");
    });

    it("updates the IndexedDB record", async () => {
      await db.writeModels("TestTask", [{ id: "t1", title: "Before" }]);

      await process(conn, {
        syncId: 2,
        syncActions: [
          {
            action: "U",
            modelName: "TestTask",
            modelId: "t1",
            data: { title: "After" },
          },
        ],
      });

      const record = await db.readModel("TestTask", "t1");
      expect(record!.title).toBe("After");
    });

    it("does nothing for a model not currently in the pool", async () => {
      await expect(
        process(conn, {
          syncId: 2,
          syncActions: [
            {
              action: "U",
              modelName: "TestTask",
              modelId: "ghost",
              data: { title: "Whatever" },
            },
          ],
        }),
      ).resolves.not.toThrow();
    });
  });

  // ── Delete action (D) ──────────────────────────────────────────────────────

  describe("action: D (delete)", () => {
    it("removes the model from the pool", async () => {
      const task = new TestTask();
      task.hydrate({ id: "t1" });
      task.makeModelObservable();
      pool.put("TestTask", task);

      await process(conn, {
        syncId: 3,
        syncActions: [
          {
            action: "D",
            modelName: "TestTask",
            modelId: "t1",
          },
        ],
      });

      expect(pool.getById("TestTask", "t1")).toBeUndefined();
    });

    it("removes the record from IndexedDB", async () => {
      await db.writeModels("TestTask", [{ id: "t1", title: "Gone" }]);

      await process(conn, {
        syncId: 3,
        syncActions: [
          {
            action: "D",
            modelName: "TestTask",
            modelId: "t1",
          },
        ],
      });

      const record = await db.readModel("TestTask", "t1");
      expect(record).toBeNull();
    });

    it("is safe when the model is not in the pool", async () => {
      await expect(
        process(conn, {
          syncId: 3,
          syncActions: [
            {
              action: "D",
              modelName: "TestTask",
              modelId: "ghost",
            },
          ],
        }),
      ).resolves.not.toThrow();
    });
  });

  // ── Cascade delete via BackReference ──────────────────────────────────────

  describe("cascade delete (BackReference)", () => {
    it("removes TestNote instances whose taskId matches the deleted TestTask", async () => {
      // TestNote has @BackReference("TestTask", "taskId")
      // → when TestTask is deleted, TestNotes with matching taskId are removed.
      const task = new TestTask();
      task.hydrate({ id: "task-1" });
      task.makeModelObservable();
      pool.put("TestTask", task);

      const note1 = new TestNote();
      note1.hydrate({ id: "note-1", taskId: "task-1" });
      note1.makeModelObservable();
      pool.put("TestNote", note1);

      const note2 = new TestNote();
      note2.hydrate({ id: "note-2", taskId: "task-1" });
      note2.makeModelObservable();
      pool.put("TestNote", note2);

      await process(conn, {
        syncId: 4,
        syncActions: [
          {
            action: "D",
            modelName: "TestTask",
            modelId: "task-1",
          },
        ],
      });

      expect(pool.getById("TestNote", "note-1")).toBeUndefined();
      expect(pool.getById("TestNote", "note-2")).toBeUndefined();
    });

    it("does not remove notes that belong to a different task", async () => {
      const task = new TestTask();
      task.hydrate({ id: "task-1" });
      task.makeModelObservable();
      pool.put("TestTask", task);

      const noteOther = new TestNote();
      noteOther.hydrate({ id: "note-other", taskId: "task-999" });
      noteOther.makeModelObservable();
      pool.put("TestNote", noteOther);

      await process(conn, {
        syncId: 4,
        syncActions: [
          {
            action: "D",
            modelName: "TestTask",
            modelId: "task-1",
          },
        ],
      });

      expect(pool.getById("TestNote", "note-other")).toBeDefined();
    });
  });

  // ── Cascade delete via Reference onDelete: cascade ────────────────────────

  describe("cascade delete (Reference onDelete: cascade)", () => {
    it("removes TestTasks whose projectId matches the deleted TestProject", async () => {
      const project = new TestProject();
      project.hydrate({ id: "proj-1" });
      project.makeModelObservable();
      pool.put("TestProject", project);

      const task = new TestTask();
      task.hydrate({ id: "t1", projectId: "proj-1" });
      task.makeModelObservable();
      pool.put("TestTask", task);

      await process(conn, {
        syncId: 5,
        syncActions: [
          {
            action: "D",
            modelName: "TestProject",
            modelId: "proj-1",
          },
        ],
      });

      expect(pool.getById("TestTask", "t1")).toBeUndefined();
    });
  });

  // ── resolveBySync ──────────────────────────────────────────────────────────

  describe("resolveBySync", () => {
    it("resolves awaiting transactions when the delta syncId matches", async () => {
      const sender = vi
        .fn()
        .mockResolvedValue({ success: true, lastSyncId: 7 });
      queue.setSender(sender);

      await queue.enqueueUpdate("t1", "TestTask", {
        title: { oldValue: "A", newValue: "B" },
      });
      // Flush directly rather than via setTimeout to avoid fake-timer issues
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (queue as any).flush();
      expect(queue.awaitingSyncCount).toBe(1);

      const task = new TestTask();
      task.hydrate({ id: "t1" });
      task.makeModelObservable();
      pool.put("TestTask", task);

      // A delta packet with syncId 7 should call resolveBySync(7) → clear awaitingSync
      await process(conn, {
        syncId: 7,
        syncActions: [
          {
            action: "U",
            modelName: "TestTask",
            modelId: "t1",
            data: { title: "B" },
          },
        ],
      });

      expect(queue.awaitingSyncCount).toBe(0);
    });
  });

  // ── shouldHydrateInsert — on-demand model gating ──────────────────────────

  describe("shouldHydrateInsert (on-demand model gating)", () => {
    let loadedCollections: Set<string>;
    let connWithChecker: SyncConnection;

    beforeEach(() => {
      loadedCollections = new Set<string>();
      connWithChecker = makeSyncConnection({
        db,
        pool,
        queue,
        isCollectionLoaded: (modelName, indexKey, value) =>
          loadedCollections.has(`${modelName}:${indexKey}:${value}`),
      });
    });

    afterEach(() => {
      connWithChecker.disconnect();
    });

    it("does not hydrate a Partial model insert when its collection has not been loaded", async () => {
      await process(connWithChecker, {
        syncId: 1,
        syncActions: [
          {
            action: "I",
            modelName: "TestActivity",
            modelId: "act-1",
            data: { taskId: "t1", text: "hello" },
          },
        ],
      });

      expect(pool.getById("TestActivity", "act-1")).toBeUndefined();
    });

    it("still writes the record to IDB even when not hydrating into pool", async () => {
      await process(connWithChecker, {
        syncId: 1,
        syncActions: [
          {
            action: "I",
            modelName: "TestActivity",
            modelId: "act-1",
            data: { taskId: "t1", text: "hello" },
          },
        ],
      });

      const record = await db.readModel("TestActivity", "act-1");
      expect(record).not.toBeNull();
    });

    it("hydrates a Partial model insert when its parent collection has been loaded", async () => {
      loadedCollections.add("TestActivity:taskId:t1");

      await process(connWithChecker, {
        syncId: 1,
        syncActions: [
          {
            action: "I",
            modelName: "TestActivity",
            modelId: "act-1",
            data: { taskId: "t1", text: "hello" },
          },
        ],
      });

      expect(pool.getById("TestActivity", "act-1")).toBeDefined();
    });

    it("does not hydrate when a different parent's collection is loaded", async () => {
      loadedCollections.add("TestActivity:taskId:t2"); // t2, not t1

      await process(connWithChecker, {
        syncId: 1,
        syncActions: [
          {
            action: "I",
            modelName: "TestActivity",
            modelId: "act-1",
            data: { taskId: "t1", text: "hello" },
          },
        ],
      });

      expect(pool.getById("TestActivity", "act-1")).toBeUndefined();
    });

    it("always hydrates Instant model inserts regardless of loaded collections", async () => {
      // loadedCollections is empty — but TestTask is Instant so it always hydrates
      await process(connWithChecker, {
        syncId: 1,
        syncActions: [
          {
            action: "I",
            modelName: "TestTask",
            modelId: "t-new",
            data: { title: "instant task" },
          },
        ],
      });

      expect(pool.getById("TestTask", "t-new")).toBeDefined();
    });

    it("updates an existing Partial model in the pool regardless of loaded state", async () => {
      // The model is already in pool (e.g. loaded previously) — update should always apply
      const existing = new TestActivity();
      existing.hydrate({ id: "act-1", taskId: "t1", text: "old" });
      existing.makeModelObservable();
      pool.put("TestActivity", existing);

      await process(connWithChecker, {
        syncId: 1,
        syncActions: [
          {
            action: "I",
            modelName: "TestActivity",
            modelId: "act-1",
            data: { taskId: "t1", text: "updated" },
          },
        ],
      });

      expect(existing.text).toBe("updated");
    });

    it("hydrates a Partial model on update when the new FK lands in a loaded scope", async () => {
      // Phase 5 — dependents loader. The model isn't in the pool, but a U
      // delta gives it a parent we already track. Read the merged record from
      // IDB and hydrate so the parent's RefCollection picks it up.
      // Pre-existing record in IDB pointing at t-other (uninteresting scope).
      await db.writeModels("TestActivity", [
        { id: "act-1", taskId: "t-other", text: "before" },
      ]);
      // We track t1's activities — but not t-other's — so the model isn't in pool.
      loadedCollections.add("TestActivity:taskId:t1");
      expect(pool.getById("TestActivity", "act-1")).toBeUndefined();

      await process(connWithChecker, {
        syncId: 1,
        syncActions: [
          {
            action: "U",
            modelName: "TestActivity",
            modelId: "act-1",
            data: { taskId: "t1" },
          },
        ],
      });

      const hydrated = pool.getById("TestActivity", "act-1") as TestActivity;
      expect(hydrated).toBeDefined();
      expect(hydrated.taskId).toBe("t1");
    });

    it("ignores a Partial model update when the new FK still isn't in scope", async () => {
      await db.writeModels("TestActivity", [
        { id: "act-1", taskId: "t-other", text: "before" },
      ]);
      loadedCollections.add("TestActivity:taskId:t1"); // we care about t1 only
      expect(pool.getById("TestActivity", "act-1")).toBeUndefined();

      await process(connWithChecker, {
        syncId: 1,
        syncActions: [
          {
            action: "U",
            modelName: "TestActivity",
            modelId: "act-1",
            data: { taskId: "t-still-other" },
          },
        ],
      });

      expect(pool.getById("TestActivity", "act-1")).toBeUndefined();
    });

    it("hydrates a Partial model insert when the model is `*`-fully-loaded", async () => {
      // `getOrLoadAll(TestActivity)` records `*`-coverage. Per-FK
      // `isCollectionLoaded` doesn't see that, so without the
      // `isModelFullyLoaded` callback the new comment would land in IDB
      // only — observers via `useRecords(TestActivity)` would miss it.
      const fullyLoaded = new Set<string>(["TestActivity"]);
      const connWithFullCheck = makeSyncConnection({
        db,
        pool,
        queue,
        isCollectionLoaded: () => false, // no per-FK coverage at all
        isModelFullyLoaded: (m) => fullyLoaded.has(m),
      });
      await process(connWithFullCheck, {
        syncId: 1,
        syncActions: [
          {
            action: "I",
            modelName: "TestActivity",
            modelId: "act-1",
            data: { taskId: "t1", text: "hello" },
          },
        ],
      });
      expect(pool.getById("TestActivity", "act-1")).toBeDefined();
      connWithFullCheck.disconnect();
    });
  });

  // ── transform ─────────────────────────────────────────────────────────────

  describe("transform", () => {
    it("converts a non-canonical envelope into a DeltaPacket", async () => {
      const transform: SyncMessageTransform = (raw) => {
        const m = raw as {
          sync_id: number;
          type: string;
          entity: string;
          entity_id: string;
          payload: Record<string, unknown>;
        };
        const action = m.type === "delete" ? "D" : "I";
        return {
          syncId: m.sync_id,
          syncActions: [
            {
              action,
              modelName: m.entity,
              modelId: m.entity_id,
              data: m.payload,
            },
          ],
        };
      };

      const client = controllableSSEClient();
      const c = makeSyncConnection({
        db,
        pool,
        queue,
        sseClientFactory: makeFactory(client),
        transform,
      });
      c.connect();

      sendMessage(client, {
        sync_id: 5,
        type: "insert",
        entity: "TestTask",
        entity_id: "t-transform",
        payload: { title: "Transformed" },
      });

      await vi.waitFor(() => {
        expect(
          (pool.getById("TestTask", "t-transform") as TestTask)?.title,
        ).toBe("Transformed");
      });

      c.disconnect();
    });

    it("transforms a batch envelope into a DeltaPacket", async () => {
      const transform: SyncMessageTransform = (raw) => {
        const items = raw as Array<{
          sync_id: number;
          entity_id: string;
          title: string;
        }>;
        return {
          syncId: Math.max(...items.map((m) => m.sync_id)),
          syncActions: items.map((m) => ({
            action: "I" as const,
            modelName: "TestTask",
            modelId: m.entity_id,
            data: { title: m.title },
          })),
        };
      };

      const client = controllableSSEClient();
      const c = makeSyncConnection({
        db,
        pool,
        queue,
        sseClientFactory: makeFactory(client),
        transform,
      });
      c.connect();

      sendMessage(client, [
        { sync_id: 1, entity_id: "ta", title: "A" },
        { sync_id: 2, entity_id: "tb", title: "B" },
      ]);

      await vi.waitFor(() => {
        expect(pool.getById("TestTask", "ta")).toBeDefined();
        expect(pool.getById("TestTask", "tb")).toBeDefined();
      });

      c.disconnect();
    });

    it("accepts a DeltaPacket envelope", async () => {
      const transform: SyncMessageTransform = (raw) => raw as DeltaPacket;

      const client = controllableSSEClient();
      const c = makeSyncConnection({
        db,
        pool,
        queue,
        sseClientFactory: makeFactory(client),
        transform,
      });
      c.connect();

      const packet: DeltaPacket = {
        syncId: 9,
        syncActions: [
          {
            action: "I",
            modelName: "TestTask",
            modelId: "t-packet",
            data: { title: "Packet" },
          },
        ],
      };
      sendMessage(client, packet);

      await vi.waitFor(() => {
        expect(pool.getById("TestTask", "t-packet")).toBeDefined();
      });

      c.disconnect();
    });

    it("drops the message when the transform returns null", async () => {
      const transform: SyncMessageTransform = () => null;

      const client = controllableSSEClient();
      const c = makeSyncConnection({
        db,
        pool,
        queue,
        sseClientFactory: makeFactory(client),
        transform,
      });
      c.connect();

      sendMessage(client, {
        id: 1,
        action: "I",
        modelName: "TestTask",
        modelId: "t-dropped",
        data: { title: "nope" },
      });

      await new Promise((r) => setTimeout(r, 10));
      expect(pool.getById("TestTask", "t-dropped")).toBeUndefined();

      c.disconnect();
    });
  });

  // ── multiple actions in one packet ────────────────────────────────────────

  describe("multiple actions in one packet", () => {
    it("processes all actions and uses the max syncId", async () => {
      await process(conn, {
        syncId: 12,
        syncActions: [
          {
            action: "I",
            modelName: "TestTask",
            modelId: "t10",
            data: { title: "A" },
          },
          {
            action: "I",
            modelName: "TestTask",
            modelId: "t11",
            data: { title: "B" },
          },
          {
            action: "I",
            modelName: "TestProject",
            modelId: "p1",
            data: { title: "P" },
          },
        ],
      });

      expect(pool.getById("TestTask", "t10")).toBeDefined();
      expect(pool.getById("TestTask", "t11")).toBeDefined();
      expect(pool.getById("TestProject", "p1")).toBeDefined();

      const meta = await db.loadMeta();
      expect(meta!.lastSyncId).toBe(12);
    });
  });

  describe("thunk URL", () => {
    it("re-evaluates the URL thunk on every (re)connect so dynamic state flows in", () => {
      vi.useFakeTimers();
      let connectCount = 0;
      const urlThunk = vi.fn(
        () => `http://x.test/events?cursor=${++connectCount}`,
      );
      const client = controllableSSEClient();
      const factory = vi.fn(makeFactory(client));
      const dynConn = makeSyncConnection({
        db,
        pool,
        queue,
        url: urlThunk,
        sseClientFactory: factory,
      });
      try {
        dynConn.connect();
        expect(factory).toHaveBeenCalledTimes(1);
        expect(factory.mock.calls[0][0]).toContain("cursor=1");
        // Engine appends its own query params using `&` when the thunk
        // already returned a URL with `?`.
        expect(factory.mock.calls[0][0]).toMatch(/cursor=1&lastSyncId=/);

        client.triggerError(); // schedules reconnect via setTimeout(3000)
        vi.runAllTimers();

        expect(factory).toHaveBeenCalledTimes(2);
        expect(factory.mock.calls[1][0]).toContain("cursor=2");
        expect(urlThunk.mock.calls.length).toBeGreaterThanOrEqual(2);
      } finally {
        dynConn.disconnect();
        vi.useRealTimers();
      }
    });

    it("reports a thunk throw via onError and schedules a reconnect instead of dying silently", () => {
      vi.useFakeTimers();
      let calls = 0;
      const urlThunk = vi.fn(() => {
        calls++;
        if (calls === 1) {
          throw new Error("cursor read failed");
        }
        return "http://x.test/events";
      });
      const reportError = vi.fn();
      const client = controllableSSEClient();
      const dynConn = makeSyncConnection({
        db,
        pool,
        queue,
        url: urlThunk,
        sseClientFactory: makeFactory(client),
        reportError,
      });
      try {
        dynConn.connect();
        expect(reportError).toHaveBeenCalledTimes(1);
        expect(reportError.mock.calls[0][1]).toMatchObject({
          kind: "sseConstruction",
          url: "<endpoint-thunk-threw>",
        });
        expect(dynConn.isConnected).toBe(false);

        vi.runAllTimers();
        expect(dynConn.isConnected).toBe(true);
        expect(urlThunk).toHaveBeenCalledTimes(2);
      } finally {
        dynConn.disconnect();
        vi.useRealTimers();
      }
    });
  });
});
