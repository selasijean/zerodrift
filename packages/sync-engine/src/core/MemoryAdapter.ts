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
  clearStaleModels,
  currentModelVersions,
  type DatabaseMeta,
  type PartialIndexEntry,
  type StorageAdapter,
} from "./Database";

export class MemoryAdapter implements StorageAdapter {
  private meta: DatabaseMeta | null = null;
  private models = new Map<string, Map<string, Record<string, unknown>>>();
  private txLog: { key: number; data: unknown }[] = [];
  private nextKey = 1;
  private connected = false;
  /** modelName → indexKey → value → firstSyncId at the time of fetch. */
  private partialIndexes = new Map<
    string,
    Map<string, Map<string, number>>
  >();
  /** Set true when connect() cleared rows for a schemaVersion-bumped model. */
  migrationClearedModels = false;

  async connect(): Promise<void> {
    this.connected = true;
    this.migrationClearedModels = false;
    if (this.meta != null) {
      const cleared = await clearStaleModels(
        this,
        this.meta.modelSchemaVersions,
      );
      if (cleared.length > 0) {
        this.migrationClearedModels = true;
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
    let bucket = this.models.get(modelName);
    if (bucket == null) {
      bucket = new Map();
      this.models.set(modelName, bucket);
    }
    for (const record of records) {
      bucket.set(record.id as string, record);
    }
  }

  async writeModelsIfAbsent(
    modelName: string,
    records: Record<string, unknown>[],
  ): Promise<void> {
    let bucket = this.models.get(modelName);
    if (bucket == null) {
      bucket = new Map();
      this.models.set(modelName, bucket);
    }
    for (const record of records) {
      const id = record.id as string;
      if (!bucket.has(id)) {
        bucket.set(id, record);
      }
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
  }

  async cacheTransaction(data: unknown): Promise<number | null> {
    const key = this.nextKey++;
    this.txLog.push({ key, data });
    return key;
  }

  async getCachedTransactions(): Promise<unknown[]> {
    return this.txLog.map((t) => t.data);
  }

  async deleteCachedTransactions(keys: number[]): Promise<void> {
    const keySet = new Set(keys);
    this.txLog = this.txLog.filter((t) => !keySet.has(t.key));
  }

  async clearCachedTransactions(): Promise<void> {
    this.txLog = [];
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
    this.meta = null;
    this.nextKey = 1;
    this.connected = false;
    this.partialIndexes.clear();
  }
}
