/**
 * FullStore and PartialStore — per-model stores that sync memory ↔ IndexedDB.
 *
 * StoreManager creates one of these for each registered model:
 *   - FullStore for eager/lazy/localOnly models (all instances at once)
 *   - PartialStore for partial models (on demand)
 *   - EphemeralStore for ephemeral models (pool-only, never persisted)
 */

import type { BaseModel } from "./BaseModel";
import type { StorageAdapter } from "./Database";
import { ObjectPool } from "./ObjectPool";
import { type ModelMeta, LoadStrategy } from "./types";

export abstract class ModelStore {
  protected meta: ModelMeta;
  protected database: StorageAdapter;
  protected pool: ObjectPool;

  constructor(meta: ModelMeta, database: StorageAdapter, pool: ObjectPool) {
    this.meta = meta;
    this.database = database;
    this.pool = pool;
  }

  get modelName() {
    return this.meta.name;
  }

  protected hydrateRecord(record: Record<string, unknown>): BaseModel {
    return this.pool.hydrateAndPut(this.modelName, this.meta, record);
  }

  abstract loadFromDatabase(): Promise<void>;
  abstract loadFromServer(records: Record<string, unknown>[]): Promise<void>;
}

/** FullStore — loads ALL instances of a model at once. */
export class FullStore extends ModelStore {
  async loadFromDatabase() {
    const records = await this.database.readAllModels(this.modelName);
    for (const record of records) {
      this.hydrateRecord(record);
    }
  }

  async loadFromServer(records: Record<string, unknown>[]) {
    await this.database.clearModelStore(this.modelName);
    await this.database.writeModels(this.modelName, records);

    // Only hydrate into memory if this model loads at bootstrap time
    if (this.meta.loadStrategy === LoadStrategy.Eager) {
      for (const record of records) {
        this.hydrateRecord(record);
      }
    }
  }
}

/** EphemeralStore — pool-only, no IDB reads or writes. */
export class EphemeralStore extends ModelStore {
  async loadFromDatabase() {}
  async loadFromServer() {}
}

/** PartialStore — loads a subset of instances on demand. */
export class PartialStore extends ModelStore {
  private loadedIds = new Set<string>();

  async loadFromDatabase() {
    /* no-op — partial models load on demand */
  }

  async loadFromServer(records: Record<string, unknown>[]) {
    await this.database.clearModelStore(this.modelName);
    await this.database.writeModels(this.modelName, records);
    // NOT hydrated — will be loaded individually when requested
  }

  /** Load a single instance by ID from IDB. Returns null if not found. */
  async loadById(id: string): Promise<BaseModel | null> {
    if (this.loadedIds.has(id)) {
      return this.pool.getById(this.modelName, id) ?? null;
    }
    const record = await this.database.readModel(this.modelName, id);
    if (record == null) {
      return null;
    }
    this.loadedIds.add(id);
    return this.hydrateRecord(record);
  }
}
