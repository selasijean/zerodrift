import { describe, it, expect, vi } from "vitest";
import { makeStoreManager } from "./helpers/storeManager";
import { MemoryAdapter } from "@sync-engine/MemoryAdapter";
import { ModelRegistry } from "@sync-engine/ModelRegistry";
import { BootstrapType, currentModelVersions } from "@sync-engine/Database";
import { BaseModel } from "@sync-engine/BaseModel";
import "./fixtures";

/**
 * Phase 6: per-model schemaVersion bumps clear that model's IDB rows + partial
 * index coverage so the next bootstrap re-fetches against the new shape.
 *
 * MemoryAdapter mirrors the same compare/clear semantics as the IDB-backed
 * Database, so adopters running headless (Node, agents) get the same behavior.
 */

/** Build a `modelSchemaVersions` snapshot covering every registered model
 * EXCEPT the named one — useful for simulating a session that ran before
 * `name` was added to the registry. */
function versionsWithout(name: string): Record<string, number> {
  const versions = { ...currentModelVersions() };
  delete versions[name];
  return versions;
}

describe("Per-model schemaVersion migration", () => {
  it("clears rows + partial-index coverage when a model's schemaVersion bumps", async () => {
    const adapter = new MemoryAdapter();

    // Session 1: save meta + data while TestActivity is at its original
    // schemaVersion. saveMeta auto-fills modelSchemaVersions from the live
    // registry, capturing the pre-bump snapshot.
    await adapter.connect();
    await adapter.writeModels("TestActivity", [
      { id: "a1", taskId: "t1", text: "x" },
    ]);
    await adapter.recordPartialIndex("TestActivity", "taskId", "t1", 0);
    await adapter.saveMeta({
      lastSyncId: 100,
      subscribedSyncGroups: [],
      schemaHash: "any",
      dbVersion: 1,
      backendDatabaseVersion: 0,
    });

    // Now bump TestActivity's schemaVersion in the registry — simulating an
    // engine upgrade where the model's serialization changed.
    const activity = ModelRegistry.getModelMeta("TestActivity")!;
    const original = activity.schemaVersion;
    activity.schemaVersion = original + 1;
    try {
      // Session 2: re-connect against the same adapter. The saved meta still
      // carries the pre-bump version; connect() detects the diff and clears.
      await adapter.connect();

      expect(await adapter.readAllModels("TestActivity")).toEqual([]);
      const coverage = await adapter.loadPartialIndexes();
      expect(
        coverage.find((e) => e.modelName === "TestActivity"),
      ).toBeUndefined();

      // Force Full so the cleared rows refill — partial bootstrap can't.
      expect(await adapter.determineBootstrapType()).toBe(BootstrapType.Full);
    } finally {
      activity.schemaVersion = original;
    }
  });

  it("leaves other models untouched when only one bumps", async () => {
    const adapter = new MemoryAdapter();
    await adapter.saveMeta({
      lastSyncId: 100,
      subscribedSyncGroups: [],
      schemaHash: "any",
      dbVersion: 1,
      backendDatabaseVersion: 0,
    });
    await adapter.writeModels("TestActivity", [
      { id: "a1", taskId: "t1", text: "x" },
    ]);
    await adapter.writeModels("TestComment", [
      { id: "c1", taskId: "t1", text: "y" },
    ]);

    const activity = ModelRegistry.getModelMeta("TestActivity")!;
    const original = activity.schemaVersion;
    activity.schemaVersion = original + 1;
    try {
      await adapter.connect();
      expect(await adapter.readAllModels("TestActivity")).toEqual([]);
      // TestComment's rows survive — its version didn't change.
      expect(await adapter.readAllModels("TestComment")).toHaveLength(1);
    } finally {
      activity.schemaVersion = original;
    }
  });

  it("clears partial-index coverage for models removed from the registry", async () => {
    const adapter = new MemoryAdapter();
    // Stored versions include a model that no longer exists in the registry.
    await adapter.saveMeta({
      lastSyncId: 100,
      subscribedSyncGroups: [],
      schemaHash: "any",
      dbVersion: 1,
      backendDatabaseVersion: 0,
      modelSchemaVersions: { Removed: 1, TestActivity: 1 },
    });
    await adapter.recordPartialIndex("Removed", "ownerId", "o1", 0);
    await adapter.recordPartialIndex("TestActivity", "taskId", "t1", 0);

    await adapter.connect();

    const remaining = await adapter.loadPartialIndexes();
    // Orphan coverage for the removed model is gone; live model's stays.
    expect(remaining.find((e) => e.modelName === "Removed")).toBeUndefined();
    expect(
      remaining.find((e) => e.modelName === "TestActivity"),
    ).toBeDefined();
  });

  it("resets migrationClearedModels on each connect so reconnects don't force Full forever", async () => {
    const adapter = new MemoryAdapter();
    await adapter.saveMeta({
      lastSyncId: 100,
      subscribedSyncGroups: [],
      schemaHash: "any",
      dbVersion: 1,
      backendDatabaseVersion: 0,
    });
    await adapter.writeModels("TestActivity", [
      { id: "a1", taskId: "t1", text: "x" },
    ]);

    const activity = ModelRegistry.getModelMeta("TestActivity")!;
    const original = activity.schemaVersion;
    activity.schemaVersion = original + 1;
    try {
      await adapter.connect();
      expect(await adapter.determineBootstrapType()).toBe(BootstrapType.Full);

      // Save the post-clear meta — modelSchemaVersions now reflects the bump.
      await adapter.saveMeta({
        lastSyncId: 100,
        subscribedSyncGroups: [],
        schemaHash: "any",
        dbVersion: 1,
        backendDatabaseVersion: 0,
      });

      // Reconnect with no further changes. The flag should reset and the
      // adapter should report Partial again.
      await adapter.connect();
      expect(await adapter.determineBootstrapType()).toBe(
        BootstrapType.Partial,
      );
    } finally {
      activity.schemaVersion = original;
    }
  });

  it("flags newly added models on connect (when stored versions are non-empty)", async () => {
    const adapter = new MemoryAdapter();
    // Simulate a session that ran before TestActivity was added.
    await adapter.saveMeta({
      lastSyncId: 100,
      subscribedSyncGroups: [],
      schemaHash: "any",
      dbVersion: 1,
      backendDatabaseVersion: 0,
      modelSchemaVersions: versionsWithout("TestActivity"),
    });

    await adapter.connect();

    expect(adapter.newlyAddedModels).toEqual(["TestActivity"]);
  });

  it("does not flag any models as 'new' on legacy meta (no stored versions at all)", async () => {
    // Adopter upgrading the engine for the first time: meta exists from a
    // prior session but `modelSchemaVersions` is undefined. We trust the
    // existing data and don't trigger a wholesale re-fetch.
    const adapter = new MemoryAdapter();
    await adapter.saveMeta({
      lastSyncId: 100,
      subscribedSyncGroups: [],
      schemaHash: "any",
      dbVersion: 1,
      backendDatabaseVersion: 0,
      modelSchemaVersions: {},
    });

    await adapter.connect();

    expect(adapter.newlyAddedModels).toEqual([]);
  });

  it("StoreManager runs a targeted full fetch for newly added Instant models after partial bootstrap", async () => {
    BaseModel.storeManager = null;
    const adapter = new MemoryAdapter();
    // Persist meta as if a previous session knew about every registered model
    // EXCEPT TestNote — only that one should trigger the targeted fetch.
    await adapter.saveMeta({
      lastSyncId: 100,
      subscribedSyncGroups: [],
      schemaHash: "any",
      dbVersion: 1,
      backendDatabaseVersion: 0,
      modelSchemaVersions: versionsWithout("TestNote"),
    });

    const calls: Array<{ type: string; onlyModels?: string[] }> = [];
    const bootstrapFetcher = vi.fn(async (type, options) => {
      calls.push({ type, onlyModels: options?.onlyModels });
      // Partial returns no deltas; targeted full returns a TestNote row.
      const models: Record<string, Record<string, unknown>[]> =
        options?.onlyModels?.includes("TestNote")
          ? { TestNote: [{ id: "n1", text: "fetched" }] }
          : {};
      return { lastSyncId: 100, subscribedSyncGroups: [], models };
    });

    const manager = makeStoreManager({
      workspaceId: crypto.randomUUID(),
      bootstrapFetcher,
      storageAdapter: adapter,
    });
    try {
      await manager.bootstrap();

      // Bootstrap: one Partial call + one targeted Full for TestNote.
      expect(calls).toEqual([
        expect.objectContaining({ type: BootstrapType.Partial }),
        expect.objectContaining({
          type: BootstrapType.Full,
          onlyModels: ["TestNote"],
        }),
      ]);
      // The fetched row landed in IDB.
      const row = await adapter.readModel("TestNote", "n1");
      expect(row?.text).toBe("fetched");
    } finally {
      await manager.teardown();
      BaseModel.storeManager = null;
    }
  });

  it("StoreManager skips the targeted fetch for newly added non-Instant models", async () => {
    BaseModel.storeManager = null;
    const adapter = new MemoryAdapter();
    // TestActivity is LoadStrategy.Partial — it loads on demand, not during
    // bootstrap. Adding it to the registry should NOT trigger a Full fetch.
    await adapter.saveMeta({
      lastSyncId: 100,
      subscribedSyncGroups: [],
      schemaHash: "any",
      dbVersion: 1,
      backendDatabaseVersion: 0,
      modelSchemaVersions: versionsWithout("TestActivity"),
    });

    const calls: Array<{ type: string }> = [];
    const bootstrapFetcher = vi.fn(async (type) => {
      calls.push({ type });
      return { lastSyncId: 100, subscribedSyncGroups: [], models: {} };
    });

    const manager = makeStoreManager({
      workspaceId: crypto.randomUUID(),
      bootstrapFetcher,
      storageAdapter: adapter,
    });
    try {
      await manager.bootstrap();
      // Only the Partial call — no follow-up Full for TestActivity.
      expect(calls).toEqual([
        expect.objectContaining({ type: BootstrapType.Partial }),
      ]);
    } finally {
      await manager.teardown();
      BaseModel.storeManager = null;
    }
  });

  it("first-time field (no stored version for a model) is left alone", async () => {
    // An adopter who upgrades the engine for the first time has rows in IDB
    // but no `modelSchemaVersions` recorded. We treat that as "trust the
    // existing data" — bumping doesn't trigger clearing because we have
    // nothing to compare against.
    const adapter = new MemoryAdapter();
    await adapter.saveMeta({
      lastSyncId: 100,
      subscribedSyncGroups: [],
      schemaHash: "any",
      dbVersion: 1,
      backendDatabaseVersion: 0,
      // modelSchemaVersions intentionally omitted (legacy meta).
    });
    await adapter.writeModels("TestActivity", [
      { id: "a1", taskId: "t1", text: "x" },
    ]);

    await adapter.connect();
    expect(await adapter.readAllModels("TestActivity")).toHaveLength(1);
  });
});
