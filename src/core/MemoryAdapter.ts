/**
 * MemoryAdapter — a fully in-memory StorageAdapter for use in Node.js, agents,
 * and any environment without IndexedDB.
 *
 * Data lives in Maps and arrays for the lifetime of the StoreManager.
 * Nothing is persisted to disk — the engine always starts with a full
 * bootstrap and loses pending transactions on restart. For durable off-heap
 * storage in a server environment, implement StorageAdapter with your own
 * SQLite / Redis / file-system backend.
 */

import {
  BootstrapType,
  LoadedModelsTracker,
  diffModelVersions,
  currentModelVersions,
  type DatabaseMeta,
  type PartialIndexEntry,
  type StorageAdapter,
  type SyncActionHeader,
} from "./Database.js";

export class MemoryAdapter implements StorageAdapter {
  private meta: DatabaseMeta | null = null;
  private models = new Map<string, Map<string, Record<string, unknown>>>();
  private txLog: { key: number; data: unknown }[] = [];
  /** Persisted SSE sync action headers — keyed by syncId. */
  private syncActions = new Map<number, SyncActionHeader>();
  private nextKey = 1;
  private connected = false;
  /** modelName → indexKey → value → firstSyncId at the time of fetch. */
  private partialIndexes = new Map<
    string,
    Map<string, Map<string, number>>
  >();
  /** Set true when connect() cleared rows for a schemaVersion-bumped model. */
  migrationClearedModels = false;
  /** Names of models added since the last connect — StoreManager target-fetches
   * these so adopters don't have to bump schemaVersion by hand. */
  newlyAddedModels: string[] = [];
  private loadedTracker = new LoadedModelsTracker();

  get loadedModels(): ReadonlySet<string> {
    return this.loadedTracker.loadedModels;
  }

  onLoadedModelsChange(cb: () => void): () => void {
    return this.loadedTracker.onChange(cb);
  }

  markModelLoaded(modelName: string): void {
    this.loadedTracker.markLoaded(modelName);
  }

  async connect(): Promise<void> {
    this.connected = true;
    this.migrationClearedModels = false;
    this.newlyAddedModels = [];
    this.loadedTracker.reset();
    for (const [name, bucket] of this.models) {
      if (bucket.size > 0) {
        this.loadedTracker.seed(name);
      }
    }
    if (this.meta != null) {
      const { cleared, newlyAdded } = await diffModelVersions(
        this,
        this.meta.modelSchemaVersions,
      );
      this.migrationClearedModels = cleared.length > 0;
      this.newlyAddedModels = newlyAdded;
      if (cleared.length > 0 || newlyAdded.length > 0) {
        this.meta.modelSchemaVersions = currentModelVersions();
      }
    }
  }

  get isConnected(): boolean {
    return this.connected;
  }

  async loadMeta(): Promise<DatabaseMeta | null> {
    return this.meta;
  }

  async saveMeta(meta: DatabaseMeta): Promise<void> {
    this.meta = {
      ...meta,
      modelSchemaVersions: meta.modelSchemaVersions ?? currentModelVersions(),
    };
  }

  get currentMeta(): DatabaseMeta | null {
    return this.meta;
  }

  async determineBootstrapType(): Promise<BootstrapType> {
    if (this.migrationClearedModels) {
      return BootstrapType.Full;
    }
    if (this.meta == null) {
      return BootstrapType.Full;
    }
    if (this.meta.lastSyncId > 0) {
      return BootstrapType.Partial;
    }
    return BootstrapType.Local;
  }

  async writeModels(
    modelName: string,
    records: Record<string, unknown>[],
  ): Promise<void> {
    if (records.length === 0) {
      return;
    }
    let bucket = this.models.get(modelName);
    if (bucket == null) {
      bucket = new Map();
      this.models.set(modelName, bucket);
    }
    for (const record of records) {
      bucket.set(record.id as string, record);
    }
    this.loadedTracker.markLoaded(modelName);
  }

  async writeModelsIfAbsent(
    modelName: string,
    records: Record<string, unknown>[],
  ): Promise<void> {
    if (records.length === 0) {
      return;
    }
    let bucket = this.models.get(modelName);
    if (bucket == null) {
      bucket = new Map();
      this.models.set(modelName, bucket);
    }
    let inserted = false;
    for (const record of records) {
      const id = record.id as string;
      if (!bucket.has(id)) {
        bucket.set(id, record);
        inserted = true;
      }
    }
    if (inserted) {
      this.loadedTracker.markLoaded(modelName);
    }
  }

  async readAllModels(modelName: string): Promise<Record<string, unknown>[]> {
    return [...(this.models.get(modelName)?.values() ?? [])];
  }

  async readModel(
    modelName: string,
    id: string,
  ): Promise<Record<string, unknown> | null> {
    return this.models.get(modelName)?.get(id) ?? null;
  }

  async readModelsByIndex(
    modelName: string,
    indexName: string,
    value: string,
  ): Promise<Record<string, unknown>[]> {
    return [...(this.models.get(modelName)?.values() ?? [])].filter(
      (r) => r[indexName] === value,
    );
  }

  async deleteModel(modelName: string, id: string): Promise<void> {
    this.models.get(modelName)?.delete(id);
  }

  async deleteModels(modelName: string, ids: string[]): Promise<void> {
    const bucket = this.models.get(modelName);
    if (bucket == null) {
      return;
    }
    for (const id of ids) {
      bucket.delete(id);
    }
  }

  async deleteModelsByIndex(
    modelName: string,
    indexName: string,
    value: string,
  ): Promise<void> {
    const bucket = this.models.get(modelName);
    if (bucket == null) {
      return;
    }
    for (const [id, record] of bucket.entries()) {
      if (record[indexName] === value) {
        bucket.delete(id);
      }
    }
  }

  async clearModelStore(modelName: string): Promise<void> {
    this.models.get(modelName)?.clear();
    this.loadedTracker.markUnloaded(modelName);
  }

  async cacheTransaction(data: unknown): Promise<number | null> {
    const key = this.nextKey++;
    this.txLog.push({ key, data });
    return key;
  }

  async getCachedTransactions(): Promise<{ idbKey: number; data: unknown }[]> {
    return this.txLog.map((t) => ({ idbKey: t.key, data: t.data }));
  }

  async deleteCachedTransactions(keys: number[]): Promise<void> {
    const keySet = new Set(keys);
    this.txLog = this.txLog.filter((t) => !keySet.has(t.key));
  }

  async clearCachedTransactions(): Promise<void> {
    this.txLog = [];
  }

  async updateCachedTransaction(idbKey: number, data: unknown): Promise<void> {
    const i = this.txLog.findIndex((t) => t.key === idbKey);
    if (i !== -1) {
      this.txLog[i] = { key: idbKey, data };
    }
  }

  async recordSyncActions(actions: SyncActionHeader[]): Promise<void> {
    for (const a of actions) {
      this.syncActions.set(a.syncId, a);
    }
  }

  async hasSyncAction(syncId: number): Promise<boolean> {
    return this.syncActions.has(syncId);
  }

  async findSyncActionsForModel(
    modelName: string,
    modelId: string,
  ): Promise<{ syncId: number; action: string }[]> {
    const out: { syncId: number; action: string }[] = [];
    for (const a of this.syncActions.values()) {
      if (a.modelName === modelName && a.modelId === modelId) {
        out.push({ syncId: a.syncId, action: a.action });
      }
    }
    return out;
  }

  async pruneSyncActionsBelow(belowSyncId: number): Promise<void> {
    for (const id of this.syncActions.keys()) {
      if (id < belowSyncId) {
        this.syncActions.delete(id);
      }
    }
  }

  async recordPartialIndex(
    modelName: string,
    indexKey: string,
    value: string,
    firstSyncId: number,
  ): Promise<void> {
    let byModel = this.partialIndexes.get(modelName);
    if (byModel == null) {
      byModel = new Map();
      this.partialIndexes.set(modelName, byModel);
    }
    let byKey = byModel.get(indexKey);
    if (byKey == null) {
      byKey = new Map();
      byModel.set(indexKey, byKey);
    }
    byKey.set(value, firstSyncId);
  }

  async clearPartialIndex(
    modelName: string,
    indexKey: string,
    value: string,
  ): Promise<void> {
    this.partialIndexes.get(modelName)?.get(indexKey)?.delete(value);
  }

  async clearPartialIndexesForModel(modelName: string): Promise<void> {
    this.partialIndexes.delete(modelName);
  }

  async loadPartialIndexes(): Promise<PartialIndexEntry[]> {
    const out: PartialIndexEntry[] = [];
    for (const [modelName, byKey] of this.partialIndexes) {
      for (const [indexKey, values] of byKey) {
        for (const [value, firstSyncId] of values) {
          out.push({ modelName, indexKey, value, firstSyncId });
        }
      }
    }
    return out;
  }

  async close(): Promise<void> {
    this.connected = false;
  }

  async destroy(): Promise<void> {
    this.models.clear();
    this.txLog = [];
    this.syncActions.clear();
    this.meta = null;
    this.nextKey = 1;
    this.connected = false;
    this.partialIndexes.clear();
  }
}
