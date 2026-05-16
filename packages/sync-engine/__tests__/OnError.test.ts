/**
 * Verifies that every async failure point inside the engine routes to
 * `StoreManagerConfig.onError`. The contexts are tagged so adopters can
 * differentiate failure kinds in Sentry/Datadog/console.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeStoreManager } from "./helpers/storeManager";
import {
  StoreManager,
  type BootstrapResponse,
} from "@sync-engine/StoreManager";
import { MemoryAdapter } from "@sync-engine/MemoryAdapter";
import { ModelRegistry } from "@sync-engine/ModelRegistry";
import { BaseModel } from "@sync-engine/BaseModel";
import type { TestEagerOwner } from "./fixtures";
import "./fixtures"; // side-effect import — registers fixture models
import { controllableSSEClient, makeFactory } from "./helpers/sseClient";

const emptyBootstrap: BootstrapResponse = {
  lastSyncId: 0,
  subscribedSyncGroups: [],
  models: {},
};

let manager: StoreManager;

beforeEach(() => {
  BaseModel.storeManager = null;
});

afterEach(async () => {
  await manager?.teardown();
  BaseModel.storeManager = null;
});

describe("onError", () => {
  it("fires for eagerReferenceLoad when storeManager.getOrLoadById rejects", async () => {
    const onError = vi.fn();
    const onDemandFetcher = vi
      .fn()
      .mockRejectedValue(new Error("network down"));

    manager = makeStoreManager({
      workspaceId: crypto.randomUUID(),
      bootstrapFetcher: vi.fn().mockResolvedValue(emptyBootstrap),
      storageAdapter: new MemoryAdapter(),
      onDemandFetcher,
      onError,
    });
    await manager.bootstrap();

    // TestEagerHolder.refUserId is wired to TestUser via eager @Reference.
    // Hydrating a holder triggers getOrLoadById("TestUser", "u-missing"), which
    // routes to onDemandFetcher (rejects) → emitError fires.
    const meta = ModelRegistry.getModelMeta("TestEagerHolder")!;
    manager.objectPool.hydrateAndPut("TestEagerHolder", meta, {
      id: "h1",
      name: "holder",
      refUserId: "u-missing",
    });

    await vi.waitFor(() => expect(onError).toHaveBeenCalled());
    const [, ctx] = onError.mock.calls[0];
    expect(ctx).toEqual({
      kind: "eagerReferenceLoad",
      modelName: "TestUser",
      id: "u-missing",
    });
  });

  it("fires for eagerCollectionLoad when the loader rejects", async () => {
    const onError = vi.fn();
    const adapter = new MemoryAdapter();

    manager = makeStoreManager({
      workspaceId: crypto.randomUUID(),
      bootstrapFetcher: vi.fn().mockResolvedValue(emptyBootstrap),
      storageAdapter: adapter,
      onError,
    });
    await manager.bootstrap();

    // Force the IDB-side query to throw so the collection loader rejects.
    adapter.readModelsByIndex = vi
      .fn()
      .mockRejectedValue(new Error("idb fault"));

    const meta = ModelRegistry.getModelMeta("TestEagerOwner")!;
    const owner = manager.objectPool.hydrateAndPut("TestEagerOwner", meta, {
      id: "o1",
      name: "Acme",
    }) as TestEagerOwner;

    await owner.children.load();

    expect(onError).toHaveBeenCalled();
    const ctx = onError.mock.calls[0][1];
    expect(ctx.kind).toBe("eagerCollectionLoad");
    expect(ctx.modelName).toBe("TestEagerChild");
    expect(ctx.parentModelName).toBe("TestEagerOwner");
    expect(ctx.parentId).toBe("o1");
  });

  it("fires for transactionSend when the sender rejects", async () => {
    const onError = vi.fn();
    const transactionSender = vi.fn().mockRejectedValue(new Error("timeout"));

    manager = makeStoreManager({
      workspaceId: crypto.randomUUID(),
      bootstrapFetcher: vi.fn().mockResolvedValue(emptyBootstrap),
      storageAdapter: new MemoryAdapter(),
      transactionSender,
      onError,
    });
    await manager.bootstrap();

    manager.commitUpdate("t1", "TestTask", {
      title: { oldValue: "old", newValue: "new" },
    });

    await vi.waitFor(() => expect(onError).toHaveBeenCalled());
    const ctx = onError.mock.calls[0][1];
    expect(ctx.kind).toBe("transactionSend");
    expect(ctx.batchSize).toBeGreaterThan(0);
  });

  it("fires for onSyncGroupDelete when the adopter's callback throws", async () => {
    const onError = vi.fn();
    const onSyncGroupDelete = vi.fn().mockRejectedValue(new Error("boom"));

    manager = makeStoreManager({
      workspaceId: crypto.randomUUID(),
      bootstrapFetcher: vi.fn().mockResolvedValue({
        lastSyncId: 0,
        subscribedSyncGroups: ["layer-A"],
        models: {},
      }),
      storageAdapter: new MemoryAdapter(),
      onSyncGroupDelete,
      onError,
    });
    await manager.database.connect();
    await manager.database.saveMeta({
      lastSyncId: 0,
      subscribedSyncGroups: ["layer-A"],
      schemaHash: "test",
      dbVersion: 1,
      backendDatabaseVersion: 0,
    });

    await manager.deactivateSyncGroup("layer-A");

    expect(onError).toHaveBeenCalled();
    const ctx = onError.mock.calls[0][1];
    expect(ctx).toEqual({ kind: "onSyncGroupDelete", groupId: "layer-A" });
  });

  it("fires for ssePacketParse when the message handler throws", async () => {
    const onError = vi.fn();
    const sseClient = controllableSSEClient();

    manager = makeStoreManager({
      workspaceId: crypto.randomUUID(),
      bootstrapFetcher: vi.fn().mockResolvedValue(emptyBootstrap),
      storageAdapter: new MemoryAdapter(),
      syncUrl: "http://test/events",
      sseClientFactory: makeFactory(sseClient),
      onError,
    });
    await manager.bootstrap();

    // Send something that's not even valid JSON to force a parse error.
    sseClient.onmessage?.({ data: "not json {" } as MessageEvent);

    await vi.waitFor(() => expect(onError).toHaveBeenCalled());
    const ctx = onError.mock.calls[0][1];
    expect(ctx.kind).toBe("ssePacketParse");
    expect(ctx.url).toContain("http://test/events");
    expect(ctx.raw).toBe("not json {");
  });

  it("fires for sseConstruction when the SSE factory throws", async () => {
    const onError = vi.fn();
    const factory = vi.fn(() => {
      throw new Error("EventSource refused");
    });

    manager = makeStoreManager({
      workspaceId: crypto.randomUUID(),
      bootstrapFetcher: vi.fn().mockResolvedValue(emptyBootstrap),
      storageAdapter: new MemoryAdapter(),
      syncUrl: "http://test/events",
      sseClientFactory: factory,
      onError,
    });
    await manager.bootstrap();

    expect(onError).toHaveBeenCalled();
    const ctx = onError.mock.calls[0][1];
    expect(ctx.kind).toBe("sseConstruction");
  });

  it("fires for syncGroupFetch when bootstrapFetcher with syncGroups rejects", async () => {
    const onError = vi.fn();
    const bootstrapFetcher = vi
      .fn()
      .mockImplementation(async (_type, options) => {
        if (options?.syncGroups != null) {
          throw new Error("group fetch failed");
        }
        return emptyBootstrap;
      });

    manager = makeStoreManager({
      workspaceId: crypto.randomUUID(),
      bootstrapFetcher,
      storageAdapter: new MemoryAdapter(),
      onError,
    });
    await manager.database.connect();
    await manager.database.saveMeta({
      lastSyncId: 0,
      subscribedSyncGroups: [],
      schemaHash: "test",
      dbVersion: 1,
      backendDatabaseVersion: 0,
    });

    await expect(manager.activateSyncGroup("layer-A")).rejects.toThrow(
      "group fetch failed",
    );

    expect(onError).toHaveBeenCalled();
    const ctx = onError.mock.calls[0][1];
    expect(ctx).toEqual({ kind: "syncGroupFetch", groups: ["layer-A"] });
  });

  it("fires for deferredBootstrap when phase-2 fetch rejects", async () => {
    const onError = vi.fn();
    const bootstrapFetcher = vi
      .fn()
      .mockImplementation(async (_type, options) => {
        // Phase 2 specifies the deferred model names via onlyModels.
        if (options?.onlyModels?.includes("TestNote")) {
          throw new Error("phase 2 down");
        }
        return emptyBootstrap;
      });

    manager = makeStoreManager({
      workspaceId: crypto.randomUUID(),
      bootstrapFetcher,
      storageAdapter: new MemoryAdapter(),
      deferredModels: ["TestNote"],
      onError,
    });
    await manager.bootstrap();

    await vi.waitFor(() => expect(onError).toHaveBeenCalled());
    const ctx = onError.mock.calls[0][1];
    expect(ctx.kind).toBe("deferredBootstrap");
    expect(ctx.modelNames).toEqual(["TestNote"]);
  });

  it("swallows errors thrown from the onError handler itself", async () => {
    const onError = vi.fn(() => {
      throw new Error("logger broke");
    });
    const onDemandFetcher = vi.fn().mockRejectedValue(new Error("network"));

    manager = makeStoreManager({
      workspaceId: crypto.randomUUID(),
      bootstrapFetcher: vi.fn().mockResolvedValue(emptyBootstrap),
      storageAdapter: new MemoryAdapter(),
      onDemandFetcher,
      onError,
    });
    await manager.bootstrap();

    // Trigger a failure; the engine should NOT crash even though onError throws.
    const meta = ModelRegistry.getModelMeta("TestEagerHolder")!;
    expect(() =>
      manager.objectPool.hydrateAndPut("TestEagerHolder", meta, {
        id: "h1",
        name: "holder",
        refUserId: "u-missing",
      }),
    ).not.toThrow();

    await vi.waitFor(() => expect(onError).toHaveBeenCalled());
  });

  it("is a no-op when onError isn't configured", async () => {
    // Same failure setup as the eagerReferenceLoad test, but without onError.
    const onDemandFetcher = vi.fn().mockRejectedValue(new Error("network"));

    manager = makeStoreManager({
      workspaceId: crypto.randomUUID(),
      bootstrapFetcher: vi.fn().mockResolvedValue(emptyBootstrap),
      storageAdapter: new MemoryAdapter(),
      onDemandFetcher,
    });
    await manager.bootstrap();

    // Should not throw even without an onError handler.
    const meta = ModelRegistry.getModelMeta("TestEagerHolder")!;
    expect(() =>
      manager.objectPool.hydrateAndPut("TestEagerHolder", meta, {
        id: "h1",
        name: "holder",
        refUserId: "u-missing",
      }),
    ).not.toThrow();

    // Wait a tick to let the async getOrLoadById reject without affecting anything.
    await new Promise((r) => setTimeout(r, 5));
  });
});
