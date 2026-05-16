import { describe, it, expect, afterEach, vi } from "vitest";
import { makeStoreManager } from "./helpers/storeManager";
import {
  StoreManager,
  type NormalizedConfig,
} from "@sync-engine/StoreManager";
import type { UndoableAction } from "@sync-engine/Transaction";
import type { EngineErrorContext } from "@sync-engine/types";
import { TestTask, addToPool } from "./fixtures";

/** A handler that returns a compensating action with a "compensating:" prefix
 *  on the changeLogId — lets tests assert which side of the cycle ran. */
const trackingHandler = () =>
  vi.fn(
    async (a: UndoableAction): Promise<UndoableAction> => ({
      ...a,
      changeLogId: `compensating:${a.changeLogId}`,
    }),
  );

const makeManager = async (opts?: Partial<NormalizedConfig>) => {
  const manager = makeStoreManager({
    workspaceId: crypto.randomUUID(),
    bootstrapFetcher: vi.fn(),
    ...opts,
  });
  await manager.database.connect();
  return manager;
};

let manager: StoreManager;

afterEach(async () => {
  await manager.teardown();
});

describe("StoreManager.runUndoable", () => {
  describe("happy path", () => {
    it("records an action on the undo stack and returns fn's value", async () => {
      manager = await makeManager({
        undoableActions: { undo: trackingHandler(), redo: trackingHandler() },
      });
      const result = await manager.runUndoable(async () => "cl-1");
      expect(result).toBe("cl-1");
      expect(manager.transactionQueue.undoDepth).toBe(1);
    });

    it("passes the full response back when fn returns an object", async () => {
      manager = await makeManager({
        undoableActions: { undo: trackingHandler() },
      });
      const result = await manager.runUndoable(async () => ({
        changeLogId: "cl-2",
        archivedCount: 5,
      }));
      expect(result).toEqual({ changeLogId: "cl-2", archivedCount: 5 });
      expect(manager.transactionQueue.undoDepth).toBe(1);
    });

    it("undo invokes the consumer's handler with the recorded changeLogId", async () => {
      const undo = vi.fn(async (_a: UndoableAction) => undefined);
      manager = await makeManager({ undoableActions: { undo } });
      await manager.runUndoable(async () => "cl-3", { actionType: "bulkMove" });
      await manager.undo();

      expect(undo).toHaveBeenCalledTimes(1);
      const called = undo.mock.calls[0][0];
      expect(called.changeLogId).toBe("cl-3");
      expect(called.actionType).toBe("bulkMove");
    });

    it("undo then redo invokes both handlers; depth shifts back", async () => {
      const undo = trackingHandler();
      const redo = trackingHandler();
      manager = await makeManager({ undoableActions: { undo, redo } });

      await manager.runUndoable(async () => "cl-4");
      await manager.undo();
      expect(manager.transactionQueue.undoDepth).toBe(0);
      expect(manager.transactionQueue.redoDepth).toBe(1);

      await manager.redo();
      expect(undo).toHaveBeenCalledTimes(1);
      expect(redo).toHaveBeenCalledTimes(1);
      // Redo receives the compensating action returned by undo (prefixed).
      expect(redo.mock.calls[0][0].changeLogId).toBe("compensating:cl-4");
      expect(manager.transactionQueue.undoDepth).toBe(1);
      expect(manager.transactionQueue.redoDepth).toBe(0);
    });

    it("forwards actionType + metadata to the recorded action", async () => {
      const undo = vi.fn(async (_a: UndoableAction) => undefined);
      manager = await makeManager({ undoableActions: { undo } });
      await manager.runUndoable(async () => "cl-meta", {
        actionType: "purge",
        metadata: { teamId: "t-1", count: 12 },
      });
      await manager.undo();
      const got = undo.mock.calls[0][0];
      expect(got.actionType).toBe("purge");
      expect(got.metadata).toEqual({ teamId: "t-1", count: 12 });
    });
  });

  describe("failure semantics", () => {
    it("does not record an entry when fn throws", async () => {
      manager = await makeManager({
        undoableActions: { undo: vi.fn() },
      });
      await expect(
        manager.runUndoable(async () => {
          throw new Error("api blew up");
        }),
      ).rejects.toThrow("api blew up");
      expect(manager.transactionQueue.undoDepth).toBe(0);
    });

    it("undo handler throw routes to onError and keeps redo depth incremented", async () => {
      const captured: { err: Error; ctx: EngineErrorContext }[] = [];
      manager = await makeManager({
        onError: (err, ctx) => captured.push({ err, ctx }),
        undoableActions: {
          undo: async () => {
            throw new Error("server unreachable");
          },
        },
      });
      await manager.runUndoable(async () => "cl-fail", { actionType: "bulk" });
      const result = await manager.undo();
      // Undo "succeeded" from the engine's perspective — handler failure was
      // reported, the entry still moves to redo so the user can try again.
      expect(result).not.toBeNull();
      expect(captured).toHaveLength(1);
      expect(captured[0].ctx).toMatchObject({
        kind: "undoableAction",
        phase: "undo",
        changeLogId: "cl-fail",
        actionType: "bulk",
      });
      expect(captured[0].err.message).toBe("server unreachable");
      expect(manager.transactionQueue.redoDepth).toBe(1);
    });
  });

  describe("redo handler omitted", () => {
    it("redo of an action entry routes through onError when no redo handler exists", async () => {
      const captured: EngineErrorContext[] = [];
      manager = await makeManager({
        onError: (_err, ctx) => captured.push(ctx),
        undoableActions: { undo: async () => undefined },
      });
      await manager.runUndoable(async () => "cl-noredo");
      await manager.undo();
      await manager.redo();
      expect(captured).toHaveLength(1);
      expect(captured[0]).toMatchObject({
        kind: "undoableAction",
        phase: "redo",
      });
    });
  });

  describe("mixed batches (model edits + actions)", () => {
    it("undoes a model edit and an action together in reverse insertion order", async () => {
      const calls: string[] = [];
      manager = await makeManager({
        undoableActions: {
          undo: async (a) => {
            calls.push(`action-undo:${a.changeLogId}`);
            return undefined;
          },
        },
      });

      const task = new TestTask();
      task.hydrate({ id: "t-1", title: "Old" });
      addToPool(manager, "TestTask", task);

      await manager.batch(async () => {
        task.title = "New";
        task.save();
        await manager.runUndoable(async () => "cl-mixed");
      });

      expect(manager.transactionQueue.undoDepth).toBe(1);

      await manager.undo();
      // Action was inserted after the tx → undo runs it first (reverse order).
      expect(calls).toEqual(["action-undo:cl-mixed"]);
      // Model edit was reverted.
      expect(task.title).toBe("Old");
    });

    it("redo of a mixed batch replays in original order", async () => {
      const order: string[] = [];
      manager = await makeManager({
        undoableActions: {
          undo: async (a) => {
            order.push(`undo:${a.changeLogId}`);
            return undefined;
          },
          redo: async (a) => {
            order.push(`redo:${a.changeLogId}`);
            return undefined;
          },
        },
      });

      const task = new TestTask();
      task.hydrate({ id: "t-2", title: "Initial" });
      addToPool(manager, "TestTask", task);

      await manager.batch(async () => {
        task.title = "Edited";
        task.save();
        await manager.runUndoable(async () => "cl-batch");
      });

      await manager.undo();
      await manager.redo();

      expect(order).toEqual(["undo:cl-batch", "redo:cl-batch"]);
      expect(task.title).toBe("Edited");
    });
  });

  describe("re-entry guard", () => {
    it("compensating action returned by undo handler does not re-enter undo stack", async () => {
      // The handler returns a fresh UndoableAction. Without suppressUndoStack,
      // a buggy handler that tracked the compensating change as an action
      // could re-enter the undo stack mid-undo. The engine guards against this
      // by suppressing during the revert window.
      manager = await makeManager({
        undoableActions: {
          undo: async (a) => ({
            ...a,
            changeLogId: `cmp:${a.changeLogId}`,
          }),
          redo: async (_a) => undefined,
        },
      });

      await manager.runUndoable(async () => "cl-original");
      await manager.undo();

      // Exactly one entry on redo (the compensating one) and undo is empty.
      expect(manager.transactionQueue.undoDepth).toBe(0);
      expect(manager.transactionQueue.redoDepth).toBe(1);
    });
  });
});
