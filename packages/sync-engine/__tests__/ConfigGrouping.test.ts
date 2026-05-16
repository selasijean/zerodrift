import { describe, it, expect, vi } from "vitest";
import { normalizeConfig } from "@sync-engine/StoreManager";

/**
 * `normalizeConfig` (grouped public config → flat internal config) is the one
 * place the discriminated `onDemand` union is expanded by hand — TypeScript
 * can't catch a regression in that mapping. These assertions are that guard;
 * the rest of the grouping is compiler-enforced via the derived
 * `NormalizedConfig` type.
 */
describe("normalizeConfig — grouped → flat", () => {
  const bootstrapFetcher = vi.fn();

  it("flattens passthrough fields from each group", () => {
    const storageAdapter = {} as never;
    const onError = vi.fn();
    const identifierFn = vi.fn();
    const flat = normalizeConfig({
      workspaceId: "ws",
      transport: { bootstrapFetcher, syncUrl: "/e" },
      persistence: { storageAdapter, undoLimit: 7 },
      loading: { transientIndexDepth: 2, deferredModels: ["X"] },
      hooks: { onError },
      advanced: { identifierFn },
    });
    expect(flat.workspaceId).toBe("ws");
    expect(flat.bootstrapFetcher).toBe(bootstrapFetcher);
    expect(flat.syncUrl).toBe("/e");
    expect(flat.storageAdapter).toBe(storageAdapter);
    expect(flat.undoLimit).toBe(7);
    expect(flat.transientIndexDepth).toBe(2);
    expect(flat.deferredModels).toEqual(["X"]);
    expect(flat.onError).toBe(onError);
    expect(flat.identifierFn).toBe(identifierFn);
  });

  it("onDemand perKey → onDemandFetcher (+ optional batchFetch); no index/compound", () => {
    const fetch = vi.fn();
    const batchFetch = vi.fn();
    const flat = normalizeConfig({
      workspaceId: "ws",
      transport: { bootstrapFetcher },
      loading: { onDemand: { mode: "perKey", fetch, batchFetch } },
    });
    expect(flat.onDemandFetcher).toBe(fetch);
    expect(flat.onDemandBatchFetcher).toBe(batchFetch);
    expect(flat.onDemandIndexBatchFetcher).toBeUndefined();
    expect(flat.serverSupportsCompoundIndexKeys).toBeUndefined();
    expect(flat.compoundIndexFetchThreshold).toBeUndefined();
  });

  it("onDemand perKey with only batchFetch leaves onDemandFetcher undefined", () => {
    const batchFetch = vi.fn();
    const flat = normalizeConfig({
      workspaceId: "ws",
      transport: { bootstrapFetcher },
      loading: { onDemand: { mode: "perKey", batchFetch } },
    });
    expect(flat.onDemandFetcher).toBeUndefined();
    expect(flat.onDemandBatchFetcher).toBe(batchFetch);
  });

  it("onDemand indexBatch without compound → serverSupportsCompoundIndexKeys false", () => {
    const fetch = vi.fn();
    const flat = normalizeConfig({
      workspaceId: "ws",
      transport: { bootstrapFetcher },
      loading: { onDemand: { mode: "indexBatch", fetch } },
    });
    expect(flat.onDemandIndexBatchFetcher).toBe(fetch);
    expect(flat.serverSupportsCompoundIndexKeys).toBe(false);
    expect(flat.compoundIndexFetchThreshold).toBeUndefined();
    expect(flat.onDemandFetcher).toBeUndefined();
  });

  it("onDemand indexBatch with compound presence → opted in (threshold optional)", () => {
    const fetch = vi.fn();
    const optedInDefault = normalizeConfig({
      workspaceId: "ws",
      transport: { bootstrapFetcher },
      loading: { onDemand: { mode: "indexBatch", fetch, compound: {} } },
    });
    expect(optedInDefault.serverSupportsCompoundIndexKeys).toBe(true);
    expect(optedInDefault.compoundIndexFetchThreshold).toBeUndefined();

    const withThreshold = normalizeConfig({
      workspaceId: "ws",
      transport: { bootstrapFetcher },
      loading: {
        onDemand: { mode: "indexBatch", fetch, compound: { threshold: 5 } },
      },
    });
    expect(withThreshold.serverSupportsCompoundIndexKeys).toBe(true);
    expect(withThreshold.compoundIndexFetchThreshold).toBe(5);
  });

  it("no onDemand → every flat onDemand* field is undefined", () => {
    const flat = normalizeConfig({
      workspaceId: "ws",
      transport: { bootstrapFetcher },
    });
    expect(flat.onDemandFetcher).toBeUndefined();
    expect(flat.onDemandBatchFetcher).toBeUndefined();
    expect(flat.onDemandIndexBatchFetcher).toBeUndefined();
    expect(flat.serverSupportsCompoundIndexKeys).toBeUndefined();
    expect(flat.compoundIndexFetchThreshold).toBeUndefined();
  });
});
