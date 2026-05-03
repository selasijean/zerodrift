import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Database, BootstrapType } from "@sync-engine/Database";
import { ModelRegistry } from "@sync-engine/ModelRegistry";

// Each test gets an isolated DB via crypto.randomUUID() as workspaceId
// (fake-indexeddb is reset per test in setup.ts).

let db: Database;

beforeEach(async () => {
  db = new Database(crypto.randomUUID());
  await db.connect();
});

afterEach(async () => {
  await db.destroy();
});

describe("Database", () => {
  // ── connection ─────────────────────────────────────────────────────────────

  describe("connect()", () => {
    it("is connected after connect()", () => {
      expect(db.isConnected).toBe(true);
    });

    it("creates model stores for all registered fixtures", async () => {
      // All fixture models are registered — we can write to their stores
      await expect(db.writeModels("TestTask", [])).resolves.not.toThrow();
      await expect(db.writeModels("TestProject", [])).resolves.not.toThrow();
      await expect(db.writeModels("TestUser", [])).resolves.not.toThrow();
    });
  });

  // ── model data ─────────────────────────────────────────────────────────────

  describe("writeModels / readAllModels / readModel", () => {
    it("writes and reads back a single record", async () => {
      await db.writeModels("TestTask", [
        { id: "t1", title: "Hello", done: false },
      ]);
      const all = await db.readAllModels("TestTask");
      expect(all).toHaveLength(1);
      expect(all[0]).toMatchObject({ id: "t1", title: "Hello" });
    });

    it("writes multiple records in one call", async () => {
      await db.writeModels("TestTask", [
        { id: "a", title: "Alpha" },
        { id: "b", title: "Beta" },
      ]);
      expect(await db.readAllModels("TestTask")).toHaveLength(2);
    });

    it("overwrites an existing record with the same id", async () => {
      await db.writeModels("TestTask", [{ id: "t1", title: "First" }]);
      await db.writeModels("TestTask", [{ id: "t1", title: "Second" }]);
      const records = await db.readAllModels("TestTask");
      expect(records).toHaveLength(1);
      expect(records[0].title).toBe("Second");
    });
  });

  describe("writeModelsIfAbsent", () => {
    it("writes a record when no record with that id exists", async () => {
      await db.writeModelsIfAbsent("TestTask", [{ id: "t1", title: "New" }]);
      const record = await db.readModel("TestTask", "t1");
      expect(record).toMatchObject({ title: "New" });
    });

    it("does not overwrite an existing record", async () => {
      await db.writeModels("TestTask", [{ id: "t1", title: "Original" }]);
      await db.writeModelsIfAbsent("TestTask", [
        { id: "t1", title: "Should not apply" },
      ]);
      const record = await db.readModel("TestTask", "t1");
      expect(record!.title).toBe("Original");
    });

    it("writes new records and skips existing ones in the same call", async () => {
      await db.writeModels("TestTask", [{ id: "existing", title: "Keep me" }]);
      await db.writeModelsIfAbsent("TestTask", [
        { id: "existing", title: "Overwrite attempt" },
        { id: "new", title: "Write me" },
      ]);
      expect((await db.readModel("TestTask", "existing"))!.title).toBe(
        "Keep me",
      );
      expect((await db.readModel("TestTask", "new"))!.title).toBe("Write me");
    });
  });

  describe("readModel", () => {
    it("readModel returns the record by id", async () => {
      await db.writeModels("TestTask", [{ id: "t1", title: "Found" }]);
      const record = await db.readModel("TestTask", "t1");
      expect(record).not.toBeNull();
      expect(record!.title).toBe("Found");
    });

    it("readModel returns null for a non-existent id", async () => {
      const result = await db.readModel("TestTask", "ghost");
      expect(result).toBeNull();
    });

    it("readAllModels returns [] for an unknown store name", async () => {
      expect(await db.readAllModels("UnknownModel")).toEqual([]);
    });
  });

  // ── deleteModel / deleteModels / clearModelStore ──────────────────────────

  describe("deleteModel / deleteModels / clearModelStore", () => {
    it("deleteModel removes the record", async () => {
      await db.writeModels("TestTask", [{ id: "t1", title: "Deletable" }]);
      await db.deleteModel("TestTask", "t1");
      expect(await db.readModel("TestTask", "t1")).toBeNull();
    });

    it("deleteModel is safe for a non-existent id", async () => {
      await expect(db.deleteModel("TestTask", "ghost")).resolves.not.toThrow();
    });

    it("deleteModels removes multiple records in one call", async () => {
      await db.writeModels("TestTask", [
        { id: "a", title: "A" },
        { id: "b", title: "B" },
        { id: "c", title: "C" },
      ]);
      await db.deleteModels("TestTask", ["a", "c"]);
      expect(await db.readModel("TestTask", "a")).toBeNull();
      expect(await db.readModel("TestTask", "b")).not.toBeNull();
      expect(await db.readModel("TestTask", "c")).toBeNull();
    });

    it("deleteModels is safe for an empty id list", async () => {
      await db.writeModels("TestTask", [{ id: "t1", title: "Keep" }]);
      await expect(db.deleteModels("TestTask", [])).resolves.not.toThrow();
      expect(await db.readModel("TestTask", "t1")).not.toBeNull();
    });

    it("clearModelStore removes all records", async () => {
      await db.writeModels("TestTask", [{ id: "a" }, { id: "b" }, { id: "c" }]);
      await db.clearModelStore("TestTask");
      expect(await db.readAllModels("TestTask")).toHaveLength(0);
    });
  });

  // ── deleteModelsByIndex ────────────────────────────────────────────────────

  describe("deleteModelsByIndex()", () => {
    it("deletes records matching the index value (IDB index path)", async () => {
      // TestLayeredDriver.layerId has indexed: true → real IDB index exists
      await db.writeModels("TestLayeredDriver", [
        { id: "d1", layerId: "layer-A", name: "Alpha" },
        { id: "d2", layerId: "layer-A", name: "Beta" },
        { id: "d3", layerId: "layer-B", name: "Gamma" },
      ]);

      await db.deleteModelsByIndex("TestLayeredDriver", "layerId", "layer-A");

      expect(await db.readModel("TestLayeredDriver", "d1")).toBeNull();
      expect(await db.readModel("TestLayeredDriver", "d2")).toBeNull();
      expect(await db.readModel("TestLayeredDriver", "d3")).not.toBeNull();
    });

    it("deletes records matching the value via full-scan fallback (no IDB index)", async () => {
      // TestTask.title has no IDB index — exercises the cursor full-scan path
      await db.writeModels("TestTask", [
        { id: "t1", title: "keep" },
        { id: "t2", title: "remove" },
        { id: "t3", title: "remove" },
      ]);

      await db.deleteModelsByIndex("TestTask", "title", "remove");

      expect(await db.readModel("TestTask", "t1")).not.toBeNull();
      expect(await db.readModel("TestTask", "t2")).toBeNull();
      expect(await db.readModel("TestTask", "t3")).toBeNull();
    });

    it("is safe when no records match", async () => {
      await db.writeModels("TestLayeredDriver", [
        { id: "d1", layerId: "layer-A", name: "Alpha" },
      ]);

      await expect(
        db.deleteModelsByIndex("TestLayeredDriver", "layerId", "layer-Z"),
      ).resolves.not.toThrow();

      expect(await db.readModel("TestLayeredDriver", "d1")).not.toBeNull();
    });

    it("is safe for an unknown store", async () => {
      await expect(
        db.deleteModelsByIndex("UnknownModel", "layerId", "x"),
      ).resolves.not.toThrow();
    });
  });

  // ── readModelsByIndex ──────────────────────────────────────────────────────

  describe("readModelsByIndex()", () => {
    it("returns records matching the index value (full-scan fallback)", async () => {
      // TestTask has no indexed properties in its fixture definition,
      // so this exercises the full-scan fallback path.
      await db.writeModels("TestTask", [
        { id: "t1", projectId: "proj-A" },
        { id: "t2", projectId: "proj-B" },
        { id: "t3", projectId: "proj-A" },
      ]);

      const results = await db.readModelsByIndex(
        "TestTask",
        "projectId",
        "proj-A",
      );
      expect(results).toHaveLength(2);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(results.map((r: any) => r.id).sort()).toEqual(["t1", "t3"]);
    });

    it("returns [] for an unknown store", async () => {
      const results = await db.readModelsByIndex(
        "UnknownModel",
        "field",
        "value",
      );
      expect(results).toEqual([]);
    });

    it("returns [] when no records match", async () => {
      await db.writeModels("TestTask", [{ id: "t1", projectId: "other" }]);
      const results = await db.readModelsByIndex(
        "TestTask",
        "projectId",
        "proj-Z",
      );
      expect(results).toHaveLength(0);
    });
  });

  // ── meta ───────────────────────────────────────────────────────────────────

  describe("saveMeta / loadMeta", () => {
    it("round-trips meta", async () => {
      const meta = {
        lastSyncId: 42,
        subscribedSyncGroups: ["group-A"],
        schemaHash: "abc123",
        dbVersion: 1,
        backendDatabaseVersion: 0,
      };
      await db.saveMeta(meta);
      const loaded = await db.loadMeta();
      // saveMeta auto-fills modelSchemaVersions from the live registry.
      expect(loaded).toMatchObject(meta);
      expect(loaded?.modelSchemaVersions).toBeDefined();
    });

    it("loadMeta returns null when nothing has been saved", async () => {
      const result = await db.loadMeta();
      expect(result).toBeNull();
    });

    it("currentMeta reflects the last saved value", async () => {
      const meta = {
        lastSyncId: 5,
        subscribedSyncGroups: [],
        schemaHash: "h1",
        dbVersion: 1,
        backendDatabaseVersion: 0,
      };
      await db.saveMeta(meta);
      expect(db.currentMeta).toMatchObject(meta);
    });

    it("overwrites meta on subsequent saves", async () => {
      await db.saveMeta({
        lastSyncId: 1,
        subscribedSyncGroups: [],
        schemaHash: "a",
        dbVersion: 1,
        backendDatabaseVersion: 0,
      });
      await db.saveMeta({
        lastSyncId: 99,
        subscribedSyncGroups: ["g"],
        schemaHash: "b",
        dbVersion: 1,
        backendDatabaseVersion: 0,
      });
      const loaded = await db.loadMeta();
      expect(loaded!.lastSyncId).toBe(99);
    });
  });

  // ── transaction cache ──────────────────────────────────────────────────────

  describe("transaction cache", () => {
    it("cacheTransaction returns an auto-increment key", async () => {
      const key1 = await db.cacheTransaction({ action: "U", modelId: "t1" });
      const key2 = await db.cacheTransaction({ action: "I", modelId: "t2" });
      expect(key1).toBeGreaterThan(0);
      expect(key2 as number).toBeGreaterThan(key1 as number);
    });

    it("getCachedTransactions returns all cached entries", async () => {
      await db.cacheTransaction({ action: "U", modelId: "t1" });
      await db.cacheTransaction({ action: "I", modelId: "t2" });
      const cached = await db.getCachedTransactions();
      expect(cached).toHaveLength(2);
    });

    it("clearCachedTransactions removes all entries", async () => {
      await db.cacheTransaction({ action: "U" });
      await db.cacheTransaction({ action: "I" });
      await db.clearCachedTransactions();
      expect(await db.getCachedTransactions()).toHaveLength(0);
    });

    it("getCachedTransactions returns [] when cache is empty", async () => {
      expect(await db.getCachedTransactions()).toEqual([]);
    });
  });

  // ── determineBootstrapType ─────────────────────────────────────────────────

  describe("determineBootstrapType()", () => {
    it("returns Full when no meta has been saved (first connect)", async () => {
      const type = await db.determineBootstrapType();
      expect(type).toBe(BootstrapType.Full);
    });

    it("returns Partial when lastSyncId > 0", async () => {
      await db.saveMeta({
        lastSyncId: 10,
        subscribedSyncGroups: [],
        schemaHash: ModelRegistry.schemaHash,
        dbVersion: 1,
        backendDatabaseVersion: 0,
      });
      const type = await db.determineBootstrapType();
      expect(type).toBe(BootstrapType.Partial);
    });

    it("returns Local when meta exists but lastSyncId === 0", async () => {
      await db.saveMeta({
        lastSyncId: 0,
        subscribedSyncGroups: [],
        schemaHash: ModelRegistry.schemaHash,
        dbVersion: 1,
        backendDatabaseVersion: 0,
      });
      const type = await db.determineBootstrapType();
      expect(type).toBe(BootstrapType.Local);
    });
  });
});
