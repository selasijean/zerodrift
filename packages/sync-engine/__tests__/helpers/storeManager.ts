/**
 * Test factory: build a `StoreManager` from the legacy flat config shape.
 *
 * The public `StoreManagerConfig` is now grouped (transport / loading /
 * persistence / hooks / advanced). Tests overwhelmingly need only a handful
 * of fields, so rather than wrap every construction in nested objects this
 * accepts the flat `NormalizedConfig` and regroups it — the inverse of the
 * engine's internal `normalizeConfig`. Test infra only; not shipped.
 */
import {
  StoreManager,
  type NormalizedConfig,
  type OnDemandConfig,
  type StoreManagerConfig,
} from "@sync-engine/StoreManager";

function toGrouped<T>(f: NormalizedConfig<T>): StoreManagerConfig<T> {
  const onDemand: OnDemandConfig | undefined =
    f.onDemandIndexBatchFetcher != null
      ? {
          mode: "indexBatch",
          fetch: f.onDemandIndexBatchFetcher,
          compound:
            f.serverSupportsCompoundIndexKeys === true
              ? { threshold: f.compoundIndexFetchThreshold }
              : undefined,
        }
      : f.onDemandFetcher != null || f.onDemandBatchFetcher != null
        ? {
            mode: "perKey",
            fetch: f.onDemandFetcher,
            batchFetch: f.onDemandBatchFetcher,
          }
        : undefined;

  return {
    workspaceId: f.workspaceId,
    transport: {
      bootstrapFetcher: f.bootstrapFetcher,
      transactionSender: f.transactionSender,
      syncUrl: f.syncUrl,
      bootstrapSyncGroups: f.bootstrapSyncGroups,
      modelStreams: f.modelStreams,
      sseClientFactory: f.sseClientFactory,
      sseInit: f.sseInit,
      syncTransform: f.syncTransform,
    },
    loading: {
      transientIndexDepth: f.transientIndexDepth,
      deferredModels: f.deferredModels,
      onDemand,
    },
    persistence: { storageAdapter: f.storageAdapter, undoLimit: f.undoLimit },
    hooks: {
      onPhaseChange: f.onPhaseChange,
      onDeltaPacket: f.onDeltaPacket,
      onReady: f.onReady,
      onError: f.onError,
      onSyncGroupDelete: f.onSyncGroupDelete,
    },
    advanced: {
      identifierFn: f.identifierFn,
      applyFieldTransforms: f.applyFieldTransforms,
      routeCommit: f.routeCommit,
      onModelTouched: f.onModelTouched,
      undoableActions: f.undoableActions,
    },
  };
}

export function makeStoreManager<T = unknown>(
  flat: NormalizedConfig<T>,
): StoreManager<T> {
  return new StoreManager<T>(toGrouped(flat));
}
