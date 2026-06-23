/**
 * Compound coverage must NOT be recorded for Ephemeral models.
 *
 * The non-ephemeral path (see CompoundIndexCoverage.test.ts) writes the full
 * compound bag to IDB and records `taskId.projectId=P1` coverage, so a later
 * direct `getOrLoadCollection("...","taskId", T_new)` short-circuits via
 * `isCoveredByCompound`. Ephemeral models never write the bag to IDB and only
 * the original waiters' slices land in the pool — so recording compound
 * coverage would make direct loads for never-materialized scopes short-circuit
 * and return empty. `absorbCompoundResponse` skips coverage for Ephemeral;
 * this verifies that direct loads still reach the server.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeStoreManager } from "./helpers/storeManager";
import { StoreManager } from "@zerodrift/StoreManager";
import { MemoryAdapter } from "@zerodrift/MemoryAdapter";
import { BaseModel } from "@zerodrift/BaseModel";
import { ClientModel, Property, LazyReference } from "@zerodrift/decorators";
import { LoadStrategy } from "@zerodrift/types";
import { TestTask } from "./fixtures";
import "./fixtures";

// Ephemeral child of TestTask (which carries the `projectId` FK), so the
// compound key `taskId.projectId` can form — mirrors TestActivity but pool-only.
@ClientModel({ name: "EphemeralActivity", loadStrategy: LoadStrategy.Ephemeral })
class EphemeralActivity extends BaseModel {
  @Property()
  public text = "";

  @Property({ indexed: true })
  public taskId = "";

  @LazyReference("TestTask")
  public task!: TestTask;
}

let manager: StoreManager;

beforeEach(() => {
  BaseModel.storeManager = null;
});

afterEach(async () => {
  await manager?.teardown();
  BaseModel.storeManager = null;
});

function hydrateTask(sm: StoreManager, id: string, projectId: string): void {
  const t = new TestTask();
  t.hydrate({ id, projectId });
  t.makeModelObservable();
  sm.objectPool.put("TestTask", t);
}

describe("compound coverage for Ephemeral models", () => {
  it("does not record compound coverage, so direct loads still hit the server", async () => {
    const adapter = new MemoryAdapter();
    const fetcher = vi.fn(async (queries: { indexKey: string; value: string }[]) => {
      // Collapsed compound query: server joins every activity for project P1,
      // including t6's, which no waiter requested.
      if (
        queries.length === 1 &&
        queries[0].indexKey === "taskId.projectId" &&
        queries[0].value === "P1"
      ) {
        return {
          EphemeralActivity: [
            { id: "a1", taskId: "t1", text: "for t1" },
            { id: "a2", taskId: "t2", text: "for t2" },
            { id: "a3", taskId: "t3", text: "for t3" },
            { id: "a4", taskId: "t4", text: "for t4" },
            { id: "a5", taskId: "t5", text: "for t5" },
            { id: "a6", taskId: "t6", text: "for t6" },
          ],
        };
      }
      // Direct fallback for a single scope (e.g. t6 after the compound fetch).
      if (queries.length === 1 && queries[0].indexKey === "taskId") {
        const v = queries[0].value;
        return { EphemeralActivity: [{ id: `a-${v}`, taskId: v, text: `for ${v}` }] };
      }
      return { EphemeralActivity: [] };
    });

    manager = makeStoreManager({
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

    // Parents must be resident so the compound wrapper can read their projectId.
    for (let i = 1; i <= 6; i++) {
      hydrateTask(manager, `t${i}`, "P1");
    }

    // Five concurrent loads collapse into one compound query.
    const results = await Promise.all([
      manager.getOrLoadCollection("EphemeralActivity", "taskId", "t1"),
      manager.getOrLoadCollection("EphemeralActivity", "taskId", "t2"),
      manager.getOrLoadCollection("EphemeralActivity", "taskId", "t3"),
      manager.getOrLoadCollection("EphemeralActivity", "taskId", "t4"),
      manager.getOrLoadCollection("EphemeralActivity", "taskId", "t5"),
    ]);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toEqual([
      { modelName: "EphemeralActivity", indexKey: "taskId.projectId", value: "P1" },
    ]);
    // Each waiter still gets its own slice hydrated into the pool.
    expect(results.map((r) => r.length)).toEqual([1, 1, 1, 1, 1]);

    // P2b: compound coverage must NOT be recorded for an Ephemeral model.
    expect(
      manager.isCollectionLoaded("EphemeralActivity", "taskId.projectId", "P1"),
    ).toBe(false);
    // And the bag was never written to IDB (Ephemeral is pool-only).
    expect(
      await adapter.readModelsByIndex("EphemeralActivity", "taskId", "t6"),
    ).toEqual([]);

    // A direct load for t6 (never a waiter) is NOT short-circuited — with no
    // compound coverage and no IDB, it must re-fetch from the server.
    const t6 = await manager.getOrLoadCollection<EphemeralActivity>(
      "EphemeralActivity",
      "taskId",
      "t6",
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(t6.map((r) => r.id)).toEqual(["a-t6"]);
  });
});
