/**
 * Phase C3 — compound coverage caching with derive-on-read.
 *
 * When the compound-fetch wrapper rewrites a batch into one
 * `Comment[taskId.projectId=P1]` query, the engine:
 *
 *   1. Writes the FULL response bag to IDB (not just per-waiter slices —
 *      otherwise records for tasks that weren't in the original batch
 *      get dropped, and a future direct load can't find them).
 *   2. Records the compound key in `partialIndexCoverage` and the
 *      adapter's persistent index so the coverage survives reload.
 *   3. Derives direct-coverage at read time: a subsequent
 *      `loadCollection("Comment", "taskId", T_new)` short-circuits when
 *      T_new's parent FK matches an existing compound covering's value.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { StoreManager } from "@sync-engine/StoreManager";
import { MemoryAdapter } from "@sync-engine/MemoryAdapter";
import { BaseModel } from "@sync-engine/BaseModel";
import { TestTask } from "./fixtures";
import "./fixtures";

let manager: StoreManager;

beforeEach(() => {
  BaseModel.storeManager = null;
});

afterEach(async () => {
  await manager?.teardown();
  BaseModel.storeManager = null;
});

/** Hydrate a Task into the pool with the given projectId. */
function hydrateTask(sm: StoreManager, id: string, projectId: string): void {
  const t = new TestTask();
  t.hydrate({ id, projectId });
  t.makeModelObservable();
  sm.objectPool.put("TestTask", t);
}

describe("compound coverage caching", () => {
  it("collapses to compound, writes the full bag to IDB, then satisfies a direct load locally", async () => {
    const adapter = new MemoryAdapter();
    const fetcher = vi.fn(async (queries) => {
      // Server returns every TestActivity for project P1 — including some
      // tasks that weren't in the per-waiter batch. The full bag must
      // still land in IDB.
      if (
        queries.length === 1 &&
        queries[0].indexKey === "taskId.projectId" &&
        queries[0].value === "P1"
      ) {
        return {
          TestActivity: [
            { id: "a1", taskId: "t1", text: "for t1" },
            { id: "a2", taskId: "t2", text: "for t2" },
            { id: "a3", taskId: "t3", text: "for t3" },
            { id: "a4", taskId: "t4", text: "for t4" },
            { id: "a5", taskId: "t5", text: "for t5" },
            // t6 was NOT in the batch; its row is here because the server's
            // join returned every Activity for P1.
            { id: "a6", taskId: "t6", text: "for t6" },
          ],
        };
      }
      return { TestActivity: [] };
    });

    manager = new StoreManager({
      workspaceId: crypto.randomUUID(),
      bootstrapFetcher: vi.fn().mockResolvedValue({
        lastSyncId: 0,
        subscribedSyncGroups: [],
        models: {},
      }),
      onDemandIndexBatchFetcher: fetcher,
      serverSupportsCompoundIndexKeys: true,
      storageAdapter: adapter,
    });
    await manager.bootstrap();

    // Pre-populate the pool with 5 tasks all in project P1, plus t6 which
    // we'll query AFTER the compound fetch (also in P1).
    for (let i = 1; i <= 6; i++) {
      hydrateTask(manager, `t${i}`, "P1");
    }

    // Five concurrent direct loads — collapses to one compound query.
    const results = await Promise.all([
      manager.loadCollection("TestActivity", "taskId", "t1"),
      manager.loadCollection("TestActivity", "taskId", "t2"),
      manager.loadCollection("TestActivity", "taskId", "t3"),
      manager.loadCollection("TestActivity", "taskId", "t4"),
      manager.loadCollection("TestActivity", "taskId", "t5"),
    ]);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toEqual([
      {
        modelName: "TestActivity",
        indexKey: "taskId.projectId",
        value: "P1",
      },
    ]);

    // Each waiter gets only its own slice.
    expect(results.map((r) => r.length)).toEqual([1, 1, 1, 1, 1]);

    // The compound key is recorded in coverage.
    expect(
      manager.isCollectionLoaded("TestActivity", "taskId.projectId", "P1"),
    ).toBe(true);

    // The full bag landed in IDB — including t6's record, which no waiter
    // requested.
    const idbForT6 = await adapter.readModelsByIndex(
      "TestActivity",
      "taskId",
      "t6",
    );
    expect(idbForT6).toEqual([
      { id: "a6", taskId: "t6", text: "for t6" },
    ]);

    // Direct load for t6 short-circuits (covered by the compound key);
    // the fetcher is NOT called a second time.
    const t6Result = await manager.loadCollection(
      "TestActivity",
      "taskId",
      "t6",
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(t6Result.map((r) => r.id)).toEqual(["a6"]);
  });

  it("does not short-circuit when the parent isn't in the pool", async () => {
    const adapter = new MemoryAdapter();
    const fetcher = vi.fn(async () => ({
      TestActivity: [{ id: "a", taskId: "lonely", text: "x" }],
    }));

    manager = new StoreManager({
      workspaceId: crypto.randomUUID(),
      bootstrapFetcher: vi.fn().mockResolvedValue({
        lastSyncId: 0,
        subscribedSyncGroups: [],
        models: {},
      }),
      onDemandIndexBatchFetcher: fetcher,
      serverSupportsCompoundIndexKeys: true,
      storageAdapter: adapter,
    });
    await manager.bootstrap();

    // Pre-record a compound covering for `taskId.projectId=P1`, but never
    // put a Task `lonely` in the pool. The derive-on-read can't resolve
    // its projectId, so the load falls through to the fetcher.
    await adapter.recordPartialIndex(
      "TestActivity",
      "taskId.projectId",
      "P1",
      0,
    );
    // Force the in-memory cache to pick up the persistent record.
    await manager.teardown();
    manager = new StoreManager({
      workspaceId: crypto.randomUUID(),
      bootstrapFetcher: vi.fn().mockResolvedValue({
        lastSyncId: 0,
        subscribedSyncGroups: [],
        models: {},
      }),
      onDemandIndexBatchFetcher: fetcher,
      serverSupportsCompoundIndexKeys: true,
      storageAdapter: adapter,
    });
    await manager.bootstrap();

    await manager.loadCollection("TestActivity", "taskId", "lonely");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not short-circuit when no compound covers the parent's FK value", async () => {
    const adapter = new MemoryAdapter();
    const fetcher = vi.fn(async () => ({
      TestActivity: [{ id: "a", taskId: "t-other", text: "x" }],
    }));

    manager = new StoreManager({
      workspaceId: crypto.randomUUID(),
      bootstrapFetcher: vi.fn().mockResolvedValue({
        lastSyncId: 0,
        subscribedSyncGroups: [],
        models: {},
      }),
      onDemandIndexBatchFetcher: fetcher,
      serverSupportsCompoundIndexKeys: true,
      storageAdapter: adapter,
    });
    await manager.bootstrap();

    // Pre-record coverage for project P1, but the task we're loading is
    // in P2 — no derived hit, so the fetcher must be called.
    await adapter.recordPartialIndex(
      "TestActivity",
      "taskId.projectId",
      "P1",
      0,
    );
    await manager.teardown();
    manager = new StoreManager({
      workspaceId: crypto.randomUUID(),
      bootstrapFetcher: vi.fn().mockResolvedValue({
        lastSyncId: 0,
        subscribedSyncGroups: [],
        models: {},
      }),
      onDemandIndexBatchFetcher: fetcher,
      serverSupportsCompoundIndexKeys: true,
      storageAdapter: adapter,
    });
    await manager.bootstrap();
    hydrateTask(manager, "t-other", "P2");

    await manager.loadCollection("TestActivity", "taskId", "t-other");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
