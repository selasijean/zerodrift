/**
 * Remote-delta undo (`advanced.remoteUndo`).
 *
 * When an SSE delta arrives, the consumer's `evaluate` decides whether the
 * server-pushed edit is user-undoable. Accepted actions capture their
 * pre-delta state; `undo()` reverts pool + IDB optimistically and submits
 * the server-side revert via the consumer's `undo` handler, keyed by syncId.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SyncConnection } from "@zerodrift/SyncConnection";
import { Database } from "@zerodrift/Database";
import { ObjectPool } from "@zerodrift/ObjectPool";
import { TransactionQueue } from "@zerodrift/TransactionQueue";
import { BaseModel } from "@zerodrift/BaseModel";
import type { SyncAction } from "@zerodrift/SyncConnection";
import type {
  RemoteUndoAction,
  RemoteUndoContext,
} from "@zerodrift/Transaction";
import type { EngineErrorContext } from "@zerodrift/types";
import {
  makeSyncConnection,
  processPacket as process,
} from "./helpers/makeSyncConnection";
import { makeStoreManager } from "./helpers/storeManager";
import { TestTask, TestProject } from "./fixtures";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const update = (
  modelId: string,
  data: Record<string, unknown>,
  modelName = "TestTask",
): SyncAction => ({ action: "U", modelName, modelId, data });

let db: Database;
let pool: ObjectPool;
let queue: TransactionQueue;
let conn: SyncConnection;
let errors: { err: Error; ctx: EngineErrorContext }[];

const setup = (opts: {
  evaluate?: (ctx: RemoteUndoContext) => boolean;
  undo?: (a: RemoteUndoAction) => Promise<{ compensatingSyncId?: number } | void>;
  redo?: (a: RemoteUndoAction) => Promise<{ compensatingSyncId?: number } | void>;
}) => {
  conn = makeSyncConnection({
    db,
    pool,
    queue,
    remoteUndoEvaluate: opts.evaluate ?? (() => true),
    reportError: (err, ctx) => errors.push({ err, ctx }),
  });
  if (opts.undo != null || opts.redo != null) {
    queue.setRemoteUndoHandlers({ undo: opts.undo!, redo: opts.redo });
  }
};

const poolTask = (id: string, data: Record<string, unknown>): TestTask => {
  const task = new TestTask();
  task.hydrate({ id, ...data });
  task.makeModelObservable();
  pool.put("TestTask", task);
  return task;
};

beforeEach(async () => {
  BaseModel.storeManager = null;
  db = new Database(crypto.randomUUID());
  await db.connect();
  await db.saveMeta({
    lastSyncId: 0,
    subscribedSyncGroups: [],
    schemaHash: "test",
    dbVersion: 1,
    backendDatabaseVersion: 0,
  });
  pool = new ObjectPool();
  queue = new TransactionQueue(db, pool);
  errors = [];
  queue.setErrorReporter((err, ctx) => errors.push({ err, ctx }));
});

afterEach(async () => {
  BaseModel.storeManager = null;
  conn?.disconnect();
  queue.destroy();
  await db.destroy();
});

describe("remote-undo capture", () => {
  it("does not track when evaluate returns false; delta still applies", async () => {
    const task = poolTask("t1", { title: "Old" });
    setup({ evaluate: () => false, undo: vi.fn() });

    await process(conn, {
      syncId: 1,
      syncActions: [update("t1", { title: "Agent edit" })],
    });

    expect(task.title).toBe("Agent edit");
    expect(queue.undoDepth).toBe(0);
    expect(queue.remoteUndoDepth).toBe(0);
  });

  it("passes syncId, action fields, and lazy previousData to evaluate", async () => {
    poolTask("t1", { title: "Old" });
    const seen: (RemoteUndoContext & { previousTitle?: unknown })[] = [];
    setup({
      evaluate: (ctx) => {
        // previousData is only pre-delta while evaluate runs — read it here.
        seen.push({ ...ctx, previousTitle: ctx.previousData()?.title });
        return false;
      },
    });

    await process(conn, {
      syncId: 5,
      syncActions: [update("t1", { title: "New" })],
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      syncId: 5,
      action: "U",
      modelName: "TestTask",
      modelId: "t1",
      data: { title: "New" },
      previousTitle: "Old",
    });
  });

  it("offers V actions to evaluate — echo detection is the consumer's call", async () => {
    // A V is only *this* client's echo if the engine's own-syncId gate says
    // so; for any other client the same broadcast is a remote edit. The
    // consumer tells them apart via server metadata (e.g. an actor id).
    const task = poolTask("t1", { title: "Old" });
    const evaluate = vi.fn(
      (ctx: RemoteUndoContext) => ctx.data?.actorId === "agent",
    );
    setup({ evaluate, undo: vi.fn() });

    await process(conn, {
      syncId: 2,
      syncActions: [
        { ...update("t1", { title: "Mine", actorId: "me" }), action: "V" },
      ],
    });
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(evaluate.mock.calls[0][0].action).toBe("V");
    expect(queue.remoteUndoDepth).toBe(0); // consumer said: my own echo

    await process(conn, {
      syncId: 3,
      syncActions: [
        { ...update("t1", { title: "Agent edit", actorId: "agent" }), action: "V" },
      ],
    });
    expect(queue.remoteUndoDepth).toBe(1); // consumer said: remote edit

    await queue.undo();
    expect(task.title).toBe("Mine");
  });

  it("skips the echo of this client's own write (awaitingSync syncId match)", async () => {
    poolTask("t1", { title: "a" });
    const evaluate = vi.fn(() => true);
    setup({ evaluate, undo: vi.fn() });
    queue.setSender(async () => ({ success: true, lastSyncId: 42 }));

    await queue.enqueueUpdate("t1", "TestTask", {
      title: { oldValue: "a", newValue: "b" },
    });
    await sleep(80); // flush debounce → server ACK → awaitingSync

    await process(conn, {
      syncId: 42,
      syncActions: [update("t1", { title: "b" })],
    });

    expect(evaluate).not.toHaveBeenCalled();
    expect(queue.remoteUndoDepth).toBe(0);
  });

  it("does not track no-op deltas (server data matches local state)", async () => {
    poolTask("t1", { title: "Same" });
    setup({ undo: vi.fn() });

    await process(conn, {
      syncId: 3,
      syncActions: [update("t1", { title: "Same" })],
    });

    expect(queue.remoteUndoDepth).toBe(0);
  });

  it("routes a throwing evaluate to onError and still applies the delta", async () => {
    const task = poolTask("t1", { title: "Old" });
    setup({
      evaluate: () => {
        throw new Error("evaluator bug");
      },
      undo: vi.fn(),
    });

    await process(conn, {
      syncId: 4,
      syncActions: [update("t1", { title: "New" })],
    });

    expect(task.title).toBe("New");
    expect(queue.remoteUndoDepth).toBe(0);
    expect(errors[0].ctx).toMatchObject({
      kind: "remoteUndo",
      phase: "evaluate",
      syncId: 4,
    });
  });

  it("does not clear the redo stack when a remote entry is recorded", async () => {
    poolTask("t1", { title: "a" });
    setup({ undo: vi.fn() });

    await queue.enqueueUpdate("t1", "TestTask", {
      title: { oldValue: "a", newValue: "b" },
    });
    await queue.undo(); // user edit → redo stack
    expect(queue.redoDepth).toBe(1);

    await process(conn, {
      syncId: 6,
      syncActions: [update("t1", { title: "agent" })],
    });

    expect(queue.remoteUndoDepth).toBe(1);
    expect(queue.redoDepth).toBe(1);
  });
});

describe("undo of a tracked update", () => {
  it("reverts pool + IDB optimistically and calls the undo handler with the syncId", async () => {
    const task = poolTask("t1", { title: "Old", done: false });
    const undo = vi.fn(async (_a: RemoteUndoAction) => undefined);
    setup({ undo });

    await process(conn, {
      syncId: 7,
      syncActions: [update("t1", { title: "Agent edit", done: true })],
    });
    expect(task.title).toBe("Agent edit");
    expect(queue.remoteUndoDepth).toBe(1);

    const result = await queue.undo();

    expect(task.title).toBe("Old");
    expect(task.done).toBe(false);
    const record = await db.readModel("TestTask", "t1");
    expect(record!.title).toBe("Old");
    expect(undo).toHaveBeenCalledTimes(1);
    expect(undo.mock.calls[0][0].syncId).toBe(7);
    expect(result?.remote?.[0].syncId).toBe(7);
    expect(queue.undoDepth).toBe(0);
    expect(queue.redoDepth).toBe(1);
    expect(queue.remoteUndoDepth).toBe(0);
  });

  it("undoes all actions of one packet atomically", async () => {
    const task = poolTask("t1", { title: "Task old" });
    const project = new TestProject();
    project.hydrate({ id: "p1", title: "Project old" });
    project.makeModelObservable();
    pool.put("TestProject", project);
    setup({ undo: vi.fn() });

    await process(conn, {
      syncId: 8,
      syncActions: [
        update("t1", { title: "Task new" }),
        update("p1", { title: "Project new" }, "TestProject"),
      ],
    });
    expect(queue.remoteUndoDepth).toBe(1); // one entry, not two

    await queue.undo();
    expect(task.title).toBe("Task old");
    expect(project.title).toBe("Project old");
  });

  it("rolls the revert forward again and keeps the entry when the handler throws", async () => {
    const task = poolTask("t1", { title: "Old" });
    setup({
      undo: async () => {
        throw new Error("server unreachable");
      },
    });

    await process(conn, {
      syncId: 9,
      syncActions: [update("t1", { title: "Agent edit" })],
    });

    const result = await queue.undo();

    expect(result).toBeNull();
    // Local state matches the server again (the revert was rolled back).
    expect(task.title).toBe("Agent edit");
    const record = await db.readModel("TestTask", "t1");
    expect(record!.title).toBe("Agent edit");
    // Entry stayed on the undo stack for retry.
    expect(queue.remoteUndoDepth).toBe(1);
    expect(queue.redoDepth).toBe(0);
    expect(errors[0].ctx).toMatchObject({
      kind: "remoteUndo",
      phase: "undo",
      syncId: 9,
    });
  });
});

describe("undo of tracked inserts and deletes", () => {
  it("undo of a tracked insert removes the model from pool + IDB; redo restores it", async () => {
    setup({ undo: vi.fn(), redo: vi.fn() });

    await process(conn, {
      syncId: 10,
      syncActions: [
        {
          action: "I",
          modelName: "TestTask",
          modelId: "t-new",
          data: { title: "Agent created" },
        },
      ],
    });
    expect(pool.getById("TestTask", "t-new")).toBeDefined();

    await queue.undo();
    expect(pool.getById("TestTask", "t-new")).toBeUndefined();
    expect(await db.readModel("TestTask", "t-new")).toBeNull();

    await queue.redo();
    const restored = pool.getById("TestTask", "t-new") as TestTask;
    expect(restored?.title).toBe("Agent created");
    expect((await db.readModel("TestTask", "t-new"))!.title).toBe(
      "Agent created",
    );
  });

  it("undo of a tracked delete restores the snapshot into pool + IDB", async () => {
    poolTask("t1", { title: "Keep me", done: true });
    await db.writeModels("TestTask", [
      { id: "t1", title: "Keep me", done: true },
    ]);
    setup({ undo: vi.fn() });

    await process(conn, {
      syncId: 11,
      syncActions: [{ action: "D", modelName: "TestTask", modelId: "t1" }],
    });
    expect(pool.getById("TestTask", "t1")).toBeUndefined();

    await queue.undo();
    const restored = pool.getById("TestTask", "t1") as TestTask;
    expect(restored?.title).toBe("Keep me");
    expect(restored?.done).toBe(true);
    expect((await db.readModel("TestTask", "t1"))!.title).toBe("Keep me");
  });
});

describe("redo", () => {
  it("re-applies the delta and calls the redo handler", async () => {
    const task = poolTask("t1", { title: "Old" });
    const redo = vi.fn(async (_a: RemoteUndoAction) => undefined);
    setup({ undo: vi.fn(), redo });

    await process(conn, {
      syncId: 12,
      syncActions: [update("t1", { title: "Agent edit" })],
    });
    await queue.undo();
    expect(task.title).toBe("Old");

    await queue.redo();
    expect(task.title).toBe("Agent edit");
    expect(redo).toHaveBeenCalledTimes(1);
    expect(redo.mock.calls[0][0].syncId).toBe(12);
    expect(queue.remoteUndoDepth).toBe(1);
  });

  it("reports and keeps the entry on the redo stack when no redo handler exists", async () => {
    const task = poolTask("t1", { title: "Old" });
    setup({ undo: vi.fn() });

    await process(conn, {
      syncId: 13,
      syncActions: [update("t1", { title: "Agent edit" })],
    });
    await queue.undo();
    errors = [];

    const result = await queue.redo();

    expect(result).toBeNull();
    expect(task.title).toBe("Old"); // local untouched
    expect(queue.redoDepth).toBe(1);
    expect(errors[0].ctx).toMatchObject({ kind: "remoteUndo", phase: "redo" });
  });
});

describe("compensation suppression", () => {
  it("skips capture for the compensating delta reported by the undo handler", async () => {
    const task = poolTask("t1", { title: "Old" });
    const evaluate = vi.fn(() => true);
    setup({
      evaluate,
      undo: async () => ({ compensatingSyncId: 99 }),
    });

    await process(conn, {
      syncId: 14,
      syncActions: [update("t1", { title: "Agent edit" })],
    });
    await queue.undo();
    expect(task.title).toBe("Old");
    evaluate.mockClear();

    // The server's compensating delta echoes back with the promised syncId.
    await process(conn, {
      syncId: 99,
      syncActions: [update("t1", { title: "Old" })],
    });

    expect(evaluate).not.toHaveBeenCalled();
    expect(queue.remoteUndoDepth).toBe(0);
  });
});

describe("supersession rebasing", () => {
  it("a foreign untracked edit prunes the superseded field; other fields still revert", async () => {
    const task = poolTask("t1", { title: "A", done: false });
    let track = true;
    const undo = vi.fn(async (_a: RemoteUndoAction) => undefined);
    setup({ evaluate: () => track, undo });

    await process(conn, {
      syncId: 40,
      syncActions: [update("t1", { title: "B", done: true })], // tracked
    });
    track = false;
    await process(conn, {
      syncId: 41,
      syncActions: [update("t1", { title: "C" })], // foreign, untracked
    });

    await queue.undo();
    expect(task.title).toBe("C"); // superseded — undo must not clobber
    expect(task.done).toBe(false); // untouched field still reverts
    expect(undo).toHaveBeenCalledTimes(1); // server-side revert still fires
  });

  it("a failed undo's rollback cannot resurrect a superseded value", async () => {
    const task = poolTask("t1", { title: "A" });
    let track = true;
    setup({
      evaluate: () => track,
      undo: async () => {
        throw new Error("server unreachable");
      },
    });

    await process(conn, {
      syncId: 42,
      syncActions: [update("t1", { title: "B" })],
    });
    track = false;
    await process(conn, {
      syncId: 43,
      syncActions: [update("t1", { title: "C" })],
    });

    await queue.undo(); // handler fails → rollback
    expect(task.title).toBe("C"); // not "B" — the stale after was pruned
    expect(queue.remoteUndoDepth).toBe(1);
  });

  it("tracked chains are exempt: two tracked edits unwind LIFO to the original", async () => {
    const task = poolTask("t1", { title: "A" });
    setup({ undo: vi.fn() });

    await process(conn, {
      syncId: 44,
      syncActions: [update("t1", { title: "B" })],
    });
    await process(conn, {
      syncId: 45,
      syncActions: [update("t1", { title: "C" })],
    });

    await queue.undo();
    expect(task.title).toBe("B");
    await queue.undo();
    expect(task.title).toBe("A");
  });

  it("the compensation echo does not prune the redo entry", async () => {
    const task = poolTask("t1", { title: "A" });
    const redo = vi.fn(async (_a: RemoteUndoAction) => undefined);
    setup({
      undo: async () => ({ compensatingSyncId: 99 }),
      redo,
    });

    await process(conn, {
      syncId: 46,
      syncActions: [update("t1", { title: "B" })],
    });
    await queue.undo();
    expect(task.title).toBe("A");

    // Server's compensating delta echoes the reverted value back.
    await process(conn, {
      syncId: 99,
      syncActions: [update("t1", { title: "A" })],
    });

    await queue.redo();
    expect(task.title).toBe("B"); // redo kept its optimistic local replay
    expect(redo).toHaveBeenCalledTimes(1);
  });

  it("a foreign re-insert drops a tracked delete's snapshot restore", async () => {
    poolTask("t1", { title: "Original", done: true });
    await db.writeModels("TestTask", [
      { id: "t1", title: "Original", done: true },
    ]);
    let track = true;
    const undo = vi.fn(async (_a: RemoteUndoAction) => undefined);
    setup({ evaluate: () => track, undo });

    await process(conn, {
      syncId: 47,
      syncActions: [{ action: "D", modelName: "TestTask", modelId: "t1" }],
    });
    expect(pool.getById("TestTask", "t1")).toBeUndefined();

    track = false;
    await process(conn, {
      syncId: 48,
      syncActions: [
        {
          action: "I",
          modelName: "TestTask",
          modelId: "t1",
          data: { title: "Recreated" },
        },
      ],
    });

    await queue.undo();
    const model = pool.getById("TestTask", "t1") as TestTask;
    expect(model?.title).toBe("Recreated"); // stale snapshot not restored
    expect(undo).toHaveBeenCalledTimes(1); // server revert still submitted
  });
});

describe("storage failure resilience", () => {
  it("a capture-time IDB failure is reported and never stalls the packet queue", async () => {
    // Not pooled → capture falls back to an IDB read, which we make reject.
    setup({ undo: vi.fn() });
    vi.spyOn(db, "readModel").mockRejectedValueOnce(new Error("idb closed"));

    await process(conn, {
      syncId: 30,
      syncActions: [update("t-unpooled", { title: "x" })],
    });

    expect(errors[0].ctx).toMatchObject({
      kind: "remoteUndo",
      phase: "evaluate",
      syncId: 30,
    });
    expect(queue.remoteUndoDepth).toBe(0);

    // The pipeline must keep draining: the next packet still applies.
    await process(conn, {
      syncId: 31,
      syncActions: [
        { action: "I", modelName: "TestTask", modelId: "t2", data: { title: "next" } },
      ],
    });
    expect(pool.getById("TestTask", "t2")).toBeDefined();
    expect((await db.loadMeta())!.lastSyncId).toBe(31);
  });

  it("an IDB failure during undo keeps the entry for retry instead of losing it", async () => {
    const task = poolTask("t1", { title: "Old" });
    const undo = vi.fn(async (_a: RemoteUndoAction) => undefined);
    setup({ undo });

    await process(conn, {
      syncId: 32,
      syncActions: [update("t1", { title: "Agent edit" })],
    });

    const spy = vi
      .spyOn(db, "writeModels")
      .mockRejectedValue(new Error("idb closed"));
    const result = await queue.undo();

    expect(result).toBeNull();
    expect(queue.remoteUndoDepth).toBe(1); // entry survived
    expect(task.title).toBe("Agent edit"); // pool rolled forward to server state
    expect(errors.some((e) => e.ctx.kind === "remoteUndo")).toBe(true);

    // Storage recovers → retrying the same entry succeeds.
    spy.mockRestore();
    await queue.undo();
    expect(task.title).toBe("Old");
    expect(undo).toHaveBeenCalledTimes(1);
    expect(queue.remoteUndoDepth).toBe(0);
  });
});

describe("StoreManager wiring", () => {
  it("advanced.remoteUndo handlers are reachable through StoreManager.undo()", async () => {
    const undo = vi.fn(async (_a: RemoteUndoAction) => undefined);
    const manager = makeStoreManager({
      workspaceId: crypto.randomUUID(),
      bootstrapFetcher: vi.fn(),
      remoteUndo: { evaluate: () => true, undo },
    });
    await manager.database.connect();

    manager.transactionQueue.recordRemoteEntry({
      source: "remote",
      id: crypto.randomUUID(),
      syncId: 21,
      changes: [],
      timestamp: Date.now(),
    });
    await manager.undo();

    expect(undo).toHaveBeenCalledTimes(1);
    expect(undo.mock.calls[0][0].syncId).toBe(21);
    await manager.teardown();
  });
});
