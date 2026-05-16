import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeStoreManager } from "./helpers/storeManager";
import { StoreManager } from "@sync-engine/StoreManager";
import { ModelRegistry } from "@sync-engine/ModelRegistry";
import { RefCollection } from "@sync-engine/LazyCollection";
import {
  TestScopedAlert,
  TestProject,
} from "./fixtures";

let manager: StoreManager;

beforeEach(async () => {
  manager = makeStoreManager({
    workspaceId: crypto.randomUUID(),
    bootstrapFetcher: vi.fn(),
  });
  await manager.database.connect();
});

afterEach(async () => {
  await manager.teardown();
});

describe("Covering index values on @LazyReferenceCollection", () => {
  it("returns one query per covering axis plus the inverse FK", () => {
    const meta = ModelRegistry.getModelMeta("TestScopedAlert")!;
    const alert = manager.objectPool.hydrateAndPut("TestScopedAlert", meta, {
      id: "a1",
      title: "Outage",
      groupId: "g-eng",
    }) as TestScopedAlert;

    const queries = (alert.notes as RefCollection).getCoveringPartialIndexValues();
    expect(queries).toEqual([
      { key: "alertId", value: "a1" },
      { key: "groupId", value: "g-eng" },
    ]);
  });

  it("skips covering axes whose value is missing or empty on the parent", () => {
    const meta = ModelRegistry.getModelMeta("TestScopedAlert")!;
    const alert = manager.objectPool.hydrateAndPut("TestScopedAlert", meta, {
      id: "a2",
      title: "Quiet alert",
      // groupId omitted → defaults to "" → covering axis is dropped
    }) as TestScopedAlert;

    const queries = (alert.notes as RefCollection).getCoveringPartialIndexValues();
    expect(queries).toEqual([{ key: "alertId", value: "a2" }]);
  });

  it("falls back to the single FK query when no coveringIndexes were declared", () => {
    // TestProject.tasks has no coveringIndexes — verify default is unchanged.
    const meta = ModelRegistry.getModelMeta("TestProject")!;
    const project = manager.objectPool.hydrateAndPut("TestProject", meta, {
      id: "p1",
      title: "Migration",
      workspaceId: "w1",
    }) as TestProject;

    const queries = (project.tasks as RefCollection).getCoveringPartialIndexValues();
    expect(queries).toEqual([{ key: "projectId", value: "p1" }]);
  });

  it("loads each axis as a separate getOrLoadCollection call to pre-warm the pool", async () => {
    const getOrLoadCollection = vi.spyOn(manager, "getOrLoadCollection");

    // Seed IDB with two TestAlertNotes — one matches alertId, the other matches
    // only the covering groupId. The covering load brings the second into the
    // pool even though it doesn't belong to alert.notes.items.
    await manager.database.writeModels("TestAlertNote", [
      { id: "n-by-alert", alertId: "a1", groupId: "other-group", body: "x" },
      { id: "n-by-group", alertId: "other-alert", groupId: "g-eng", body: "y" },
    ]);

    const meta = ModelRegistry.getModelMeta("TestScopedAlert")!;
    const alert = manager.objectPool.hydrateAndPut("TestScopedAlert", meta, {
      id: "a1",
      title: "Outage",
      groupId: "g-eng",
    }) as TestScopedAlert;

    await alert.notes.load();

    // One getOrLoadCollection call per covering value.
    const calls = getOrLoadCollection.mock.calls.map(
      ([modelName, indexKey, value]) => ({ modelName, indexKey, value }),
    );
    expect(calls).toContainEqual({
      modelName: "TestAlertNote",
      indexKey: "alertId",
      value: "a1",
    });
    expect(calls).toContainEqual({
      modelName: "TestAlertNote",
      indexKey: "groupId",
      value: "g-eng",
    });

    // Both records land in the pool — pre-warming siblings.
    expect(
      manager.objectPool.getById("TestAlertNote", "n-by-alert"),
    ).toBeDefined();
    expect(
      manager.objectPool.getById("TestAlertNote", "n-by-group"),
    ).toBeDefined();

    // …but only the alertId-matching record attaches to alert.notes.items.
    // Inverse-link semantics are unchanged — coveringIndexes governs what's
    // loaded, not what's filtered into the parent's collection.
    expect(alert.notes.items.map((n) => n.id)).toEqual(["n-by-alert"]);
  });
});
