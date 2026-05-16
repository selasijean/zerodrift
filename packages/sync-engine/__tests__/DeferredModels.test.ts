/**
 * Tests for the deferred models (phase 2) bootstrap behavior.
 *
 * Specifically verifies:
 *   1. bootstrapFetcher is called with Full type + currentMeta for phase 2
 *   2. Snapshot records are upserted into IDB (no clearModelStore)
 *   3. res.deletedIds are evicted from IDB after the upsert
 *   4. Records already in IDB (e.g. from SSE) are not wiped before writing
 *   5. lastSyncId is advanced if the server returns a higher value
 *
 * Uses TestNote (LoadStrategy.Eager) as the deferred model fixture —
 * full bootstrap only ever ships Instant models, so the deferred phase-2
 * list must consist of Instant models too.
 * All tests trigger a Full bootstrap (no pre-existing meta) so that
 * fetchDeferredModels runs as phase 2.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { StoreManager } from "@sync-engine/StoreManager";
import { BootstrapType } from "@sync-engine/Database";
import { MemoryAdapter } from "@sync-engine/MemoryAdapter";
import { BaseModel } from "@sync-engine/BaseModel";

// ── helpers ───────────────────────────────────────────────────────────────────

type Phase1Response = {
  lastSyncId: number;
  subscribedSyncGroups: string[];
  models: Record<string, unknown[]>;
};

type Phase2Response = Phase1Response & {
  deletedIds?: Record<string, string[]>;
};

/**
 * Build a StoreManager backed by MemoryAdapter with TestNote deferred.
 * Does NOT pre-seed meta so bootstrap() triggers a Full bootstrap.
 * If seedBeforeBootstrap is provided, it seeds IDB after connect() but
 * before bootstrap() to simulate records written by SSE from a prior session.
 */
async function makeManager(
  phase1Response: Phase1Response,
  phase2Response: Phase2Response,
  opts: {
    seedBeforeBootstrap?: Record<string, Record<string, unknown>[]>;
  } = {},
) {
  const adapter = new MemoryAdapter();
  const bootstrapFetcher = vi
    .fn()
    .mockResolvedValueOnce(phase1Response)
    .mockResolvedValueOnce(phase2Response);

  const manager = new StoreManager({
    workspaceId: crypto.randomUUID(),
    bootstrapFetcher,
    storageAdapter: adapter,
    deferredModels: ["TestNote"],
  });

  // Connect so we can seed IDB before bootstrap runs
  await manager.database.connect();

  if (opts.seedBeforeBootstrap != null) {
    for (const [name, records] of Object.entries(opts.seedBeforeBootstrap)) {
      await manager.database.writeModels(name, records);
    }
  }

  return { manager, bootstrapFetcher };
}

/** Wait for phase 2 to complete by polling for a condition. */
async function waitForPhase2(
  bootstrapFetcher: ReturnType<typeof vi.fn>,
  condition?: () => boolean,
) {
  await vi.waitUntil(
    () => bootstrapFetcher.mock.calls.length >= 2 && (condition?.() ?? true),
    { timeout: 3000, interval: 50 },
  );
}

// ── setup / teardown ──────────────────────────────────────────────────────────

let manager: StoreManager;

beforeEach(() => {
  BaseModel.storeManager = null;
});

afterEach(async () => {
  await manager?.teardown();
  BaseModel.storeManager = null;
});

// ── tests ─────────────────────────────────────────────────────────────────────

describe("deferred models — phase 2 fetch", () => {
  it("calls bootstrapFetcher with Full type for the deferred fetch", async () => {
    const { manager: m, bootstrapFetcher } = await makeManager(
      { lastSyncId: 10, subscribedSyncGroups: [], models: {} },
      {
        lastSyncId: 10,
        subscribedSyncGroups: [],
        models: { TestNote: [] },
      },
    );
    manager = m;
    await manager.bootstrap();
    await waitForPhase2(bootstrapFetcher);

    const [type, options] = bootstrapFetcher.mock.calls[1];
    expect(type).toBe(BootstrapType.Full);
    expect(options).toMatchObject({ onlyModels: ["TestNote"] });
    // No `sinceSyncId` for Full snapshots — that flag is only meaningful for
    // BootstrapType.Partial. The in-flight merge (writeModelsIfAbsent +
    // delete tombstones) handles SSE deltas during the window.
    expect(options?.sinceSyncId).toBeUndefined();
  });

  it("upserts snapshot records into IDB without wiping existing records first", async () => {
    const { manager: m, bootstrapFetcher } = await makeManager(
      { lastSyncId: 10, subscribedSyncGroups: [], models: {} },
      {
        lastSyncId: 10,
        subscribedSyncGroups: [],
        models: {
          TestNote: [{ id: "a1", text: "From snapshot", taskId: "t1" }],
        },
      },
      {
        // Simulate a record already in IDB (e.g. written by SSE before phase 2)
        seedBeforeBootstrap: {
          TestNote: [{ id: "sse-written", text: "From SSE", taskId: "t1" }],
        },
      },
    );
    manager = m;
    await manager.bootstrap();
    await waitForPhase2(bootstrapFetcher);

    // Snapshot record is written
    expect(
      await manager.database.readModel("TestNote", "a1"),
    ).toMatchObject({ text: "From snapshot" });

    // Pre-existing SSE-written record is NOT wiped
    expect(
      await manager.database.readModel("TestNote", "sse-written"),
    ).not.toBeNull();
  });

  it("evicts deletedIds from IDB after upserting snapshot records", async () => {
    const { manager: m, bootstrapFetcher } = await makeManager(
      { lastSyncId: 10, subscribedSyncGroups: [], models: {} },
      {
        lastSyncId: 10,
        subscribedSyncGroups: [],
        models: {
          TestNote: [{ id: "a1", text: "Kept", taskId: "t1" }],
        },
        deletedIds: { TestNote: ["a-deleted"] },
      },
      {
        seedBeforeBootstrap: {
          TestNote: [{ id: "a-deleted", text: "Stale", taskId: "t1" }],
        },
      },
    );
    manager = m;
    await manager.bootstrap();
    await waitForPhase2(bootstrapFetcher);

    expect(
      await manager.database.readModel("TestNote", "a1"),
    ).not.toBeNull();
    expect(
      await manager.database.readModel("TestNote", "a-deleted"),
    ).toBeNull();
  });

  it("handles missing deletedIds gracefully (no error)", async () => {
    const { manager: m, bootstrapFetcher } = await makeManager(
      { lastSyncId: 10, subscribedSyncGroups: [], models: {} },
      {
        lastSyncId: 10,
        subscribedSyncGroups: [],
        models: {
          TestNote: [{ id: "a1", text: "OK", taskId: "t1" }],
        },
        // no deletedIds field
      },
    );
    manager = m;
    await manager.bootstrap();
    await waitForPhase2(bootstrapFetcher);

    expect(
      await manager.database.readModel("TestNote", "a1"),
    ).not.toBeNull();
  });

  it("advances lastSyncId when phase 2 returns a higher value", async () => {
    const { manager: m, bootstrapFetcher } = await makeManager(
      { lastSyncId: 10, subscribedSyncGroups: [], models: {} },
      {
        lastSyncId: 20,
        subscribedSyncGroups: [],
        models: { TestNote: [] },
      },
    );
    manager = m;
    await manager.bootstrap();
    await waitForPhase2(
      bootstrapFetcher,
      () => (manager.database.currentMeta?.lastSyncId ?? 0) >= 20,
    );

    expect(manager.database.currentMeta?.lastSyncId).toBe(20);
  });

  it("does not regress lastSyncId when phase 2 returns equal or lower value", async () => {
    const { manager: m, bootstrapFetcher } = await makeManager(
      { lastSyncId: 10, subscribedSyncGroups: [], models: {} },
      {
        lastSyncId: 10,
        subscribedSyncGroups: [],
        models: { TestNote: [] },
      },
    );
    manager = m;
    await manager.bootstrap();
    await waitForPhase2(bootstrapFetcher);

    expect(manager.database.currentMeta?.lastSyncId).toBe(10);
  });
});
