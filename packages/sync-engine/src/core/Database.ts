/**
 * Database — wraps IndexedDB for a single workspace.
 *
 * Schema Migration:
 *   Instead of falling back to full bootstrap on every schemaHash change,
 *   we run actual IDB migrations:
 *     1. Open the DB at its current version to read meta
 *     2. If schemaHash matches → use as-is
 *     3. If schemaHash differs → close, reopen at version+1
 *     4. In onupgradeneeded: add new stores, remove old stores, update indexes
 *   This preserves existing data for unchanged models.
 *
 * Determines bootstrap type:
 *   - Full: no DB or meta, or a critical migration that can't be handled
 *   - Partial: DB exists with valid data, just need delta since lastSyncId
 *   - Local: DB exists, no server contact needed (offline start)
 */

import { ModelRegistry } from "./ModelRegistry";

export interface DatabaseMeta {
  lastSyncId: number;
  subscribedSyncGroups: string[];
  schemaHash: string;
  /** IDB version number. Incremented on each client-side schema migration. */
  dbVersion: number;
  /**
   * Server-side schema version. The server sends this with every bootstrap response.
   * If the server's version changes (e.g. renamed columns, restructured models),
   * the client detects the mismatch and forces a full bootstrap to avoid
   * interpreting data against the wrong schema.
   */
  backendDatabaseVersion: number;
  /**
   * Per-model `schemaVersion` snapshot at the time meta was last persisted.
   * Adapters compare this map against the current ModelRegistry on connect
   * and clear any model whose version bumped — stale rows in IDB serialized
   * against the old shape get wiped so the next bootstrap re-fetches them.
   * Filled in by the adapter; callers don't need to populate it.
   */
  modelSchemaVersions?: Record<string, number>;
}

export enum BootstrapType {
  Full = "full",
  Partial = "partial",
  Local = "local",
}

/**
 * One recorded `loadCollection(modelName, indexKey, value)` query, captured
 * with the `lastSyncId` at the time of fetch. Adopters ship these to the
 * server on partial fetches so it can return only deltas since `firstSyncId`.
 */
export interface PartialIndexEntry {
  modelName: string;
  indexKey: string;
  value: string;
  firstSyncId: number;
}

/** Snapshot of every registered model's current `schemaVersion`. */
export function currentModelVersions(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const meta of ModelRegistry.allModels()) {
    out[meta.name] = meta.schemaVersion;
  }
  return out;
}

/**
 * Diff stored vs current per-model schemaVersions and clear any model whose
 * version bumped (or that was removed from the registry entirely). Returns
 * the names of cleared models so the caller can flip its
 * `migrationClearedModels` flag.
 */
export async function clearStaleModels(
  adapter: Pick<
    StorageAdapter,
    "clearModelStore" | "clearPartialIndexesForModel"
  >,
  stored: Record<string, number> | undefined,
): Promise<string[]> {
  const cleared: string[] = [];
  const current = currentModelVersions();
  const storedMap = stored ?? {};
  // Bumped models still in the registry: clear rows + partial-index coverage.
  for (const [name, version] of Object.entries(current)) {
    const previous = storedMap[name];
    // First-time field (no record) is treated as "trust the existing data" —
    // adopters upgrading the engine for the first time shouldn't lose rows.
    if (previous == null || previous === version) {
      continue;
    }
    await adapter.clearModelStore(name);
    await adapter.clearPartialIndexesForModel(name);
    cleared.push(name);
  }
  // Models removed from the registry: clear leftover partial-index rows so
  // the `__partialIndexes` store doesn't accumulate orphans. (The model's
  // own object store is already deleted by the IDB schema migration.)
  for (const name of Object.keys(storedMap)) {
    if (!(name in current)) {
      await adapter.clearPartialIndexesForModel(name);
      cleared.push(name);
    }
  }
  return cleared;
}

/**
 * Pluggable storage backend for the sync engine.
 *
 * The default implementation (`Database`) uses IndexedDB and is suited for
 * browsers. Implement this interface to use a different backend — e.g.
 * `MemoryAdapter` for Node.js agents, or a custom SQLite/Redis adapter for
 * server-side environments that need durable off-heap storage.
 */
export interface StorageAdapter {
  /** Open / initialise the storage backend. Called once before bootstrap. */
  connect(): Promise<void>;
  loadMeta(): Promise<DatabaseMeta | null>;
  saveMeta(meta: DatabaseMeta): Promise<void>;
  get currentMeta(): DatabaseMeta | null;
  determineBootstrapType(): Promise<BootstrapType>;
  writeModels(
    modelName: string,
    records: Record<string, unknown>[],
  ): Promise<void>;
  writeModelsIfAbsent(
    modelName: string,
    records: Record<string, unknown>[],
  ): Promise<void>;
  readAllModels(modelName: string): Promise<Record<string, unknown>[]>;
  readModel(
    modelName: string,
    id: string,
  ): Promise<Record<string, unknown> | null>;
  readModelsByIndex(
    modelName: string,
    indexName: string,
    value: string,
  ): Promise<Record<string, unknown>[]>;
  deleteModel(modelName: string, id: string): Promise<void>;
  deleteModels(modelName: string, ids: string[]): Promise<void>;
  /** Delete all records matching indexName === value in a single IDB pass. */
  deleteModelsByIndex(
    modelName: string,
    indexName: string,
    value: string,
  ): Promise<void>;
  clearModelStore(modelName: string): Promise<void>;
  cacheTransaction(data: unknown): Promise<number | null>;
  getCachedTransactions(): Promise<unknown[]>;
  deleteCachedTransactions(keys: number[]): Promise<void>;
  clearCachedTransactions(): Promise<void>;
  /**
   * Record that a `loadCollection(modelName, indexKey, value)` query has been
   * fetched in full as of `firstSyncId`. Survives reload — on the next
   * bootstrap the engine knows which scoped queries are already covered
   * locally (and as of which point in the sync log) and can request a
   * targeted delta instead of a full re-fetch.
   */
  recordPartialIndex(
    modelName: string,
    indexKey: string,
    value: string,
    firstSyncId: number,
  ): Promise<void>;
  /** Clear coverage for a single (modelName, indexKey, value) tuple. */
  clearPartialIndex(
    modelName: string,
    indexKey: string,
    value: string,
  ): Promise<void>;
  /** Clear all coverage entries for a given model — used by schema migrations. */
  clearPartialIndexesForModel(modelName: string): Promise<void>;
  /** Read every recorded partial index. Called once at connect to populate the in-memory cache. */
  loadPartialIndexes(): Promise<PartialIndexEntry[]>;
  /**
   * Close the storage connection without deleting any data.
   * Called by StoreManager.teardown() during React unmount / cleanup.
   * Data is preserved for the next page load (enables faster partial bootstrap).
   */
  close(): Promise<void>;
  /**
   * Close the connection AND permanently delete all persisted data.
   * Use for explicit logout / factory-reset flows — NOT for routine teardown.
   */
  destroy(): Promise<void>;
  get isConnected(): boolean;
}

export class Database implements StorageAdapter {
  private db: IDBDatabase | null = null;
  private workspaceId: string;
  private meta: DatabaseMeta | null = null;

  /** Set to true if a migration added new model stores that need data. */
  migrationAddedNewModels = false;
  /** Set to true if connect() cleared rows for one or more models because
   * their per-model `schemaVersion` bumped. Forces a Full bootstrap so the
   * cleared rows refill from the server. */
  migrationClearedModels = false;

  constructor(workspaceId: string) {
    this.workspaceId = workspaceId;
  }

  // =========================================================================
  // Connection with schema migration
  // =========================================================================

  async connect(): Promise<void> {
    // Reset per-connect flags so reconnects don't carry forward a previous
    // session's "force Full" signal.
    this.migrationClearedModels = false;
    this.migrationAddedNewModels = false;

    // Gracefully handle environments without IndexedDB (Node.js, agents).
    // All methods guard on this.db == null, so the engine runs in-memory.
    if (typeof indexedDB === "undefined") {
      return;
    }

    const dbName = `sync_${this.workspaceId}`;

    // Step 1: Open at current version to read meta and check schema
    this.db = await this.openDB(dbName);
    const meta = await this.loadMeta();

    // Step 2: If schema matches (or first-time connect with no saved meta),
    // the DB is already in the right shape — no migration needed.
    // On a first connect, createAllStores just ran via onupgradeneeded and
    // created all current model stores; closing and reopening would only risk
    // losing that work on some IDB implementations.
    if (meta == null || meta.schemaHash === ModelRegistry.schemaHash) {
      return;
    }

    // Step 3: Schema changed. Close and reopen at a higher version to trigger migration.
    const oldVersion = this.db.version;
    const newVersion = (meta.dbVersion ?? oldVersion) + 1;
    this.db.close();
    this.db = null;

    // Step 4: Reopen at newVersion → triggers onupgradeneeded
    this.db = await this.openDBWithMigration(dbName, newVersion);

    // Step 5: Clear data for models whose schemaVersion bumped. The IDB
    // structure migrated in step 4, but rows serialized against the old
    // shape need to go.
    if (meta != null) {
      const cleared = await clearStaleModels(this, meta.modelSchemaVersions);
      this.migrationClearedModels = cleared.length > 0;
    }

    // Update the dbVersion + per-model versions in meta after migration
    if (meta != null) {
      meta.dbVersion = newVersion;
      meta.schemaHash = ModelRegistry.schemaHash;
      meta.modelSchemaVersions = currentModelVersions();
      await this.saveMeta(meta);
    }
  }

  /**
   * IDB blocks schema upgrades and deletions until all open connections close.
   * onversionchange is the browser's signal to us: "another tab needs you to
   * let go." Close immediately so the other tab's open/deleteDatabase call
   * can proceed.
   */
  private attachVersionChangeHandler(db: IDBDatabase): void {
    db.onversionchange = () => {
      db.close();
      this.db = null;
    };
  }

  /** Open DB at its current version (no migration). */
  private openDB(dbName: string): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(dbName);
      request.onupgradeneeded = (event) => {
        // First time creating this DB — set up everything from scratch
        this.createAllStores((event.target as IDBOpenDBRequest).result);
      };
      request.onsuccess = () => {
        const db = request.result;
        this.attachVersionChangeHandler(db);
        resolve(db);
      };
      request.onerror = () => reject(request.error);
    });
  }

  /** Open DB at a specific version, triggering migration in onupgradeneeded. */
  private openDBWithMigration(
    dbName: string,
    version: number,
  ): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(dbName, version);
      request.onblocked = () => {
        console.warn(
          `[DB] upgrade to v${version} blocked — another tab has "${dbName}" open`,
        );
      };
      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        // IMPORTANT: use the upgrade transaction from the event, not db.transaction().
        // IDB doesn't allow new transactions during an upgrade.
        const upgradeTx = (event.target as IDBOpenDBRequest).transaction!;
        this.migrateSchema(db, upgradeTx);
      };
      request.onsuccess = () => {
        const db = request.result;
        this.attachVersionChangeHandler(db);
        resolve(db);
      };
      request.onerror = () => reject(request.error);
    });
  }

  // =========================================================================
  // Schema migration logic
  //
  // Diffs the current IDB object stores against the ModelRegistry:
  //   - New models → create object store + indexes
  //   - Removed models → delete object store
  //   - Changed models → add/remove indexes
  // =========================================================================

  /** Create all stores from scratch (first-time DB creation). */
  private createAllStores(db: IDBDatabase) {
    if (!db.objectStoreNames.contains("__meta")) {
      db.createObjectStore("__meta");
    }
    if (!db.objectStoreNames.contains("__transactions")) {
      db.createObjectStore("__transactions", { autoIncrement: true });
    }
    if (!db.objectStoreNames.contains("__partialIndexes")) {
      db.createObjectStore("__partialIndexes", {
        keyPath: ["modelName", "indexKey", "value"],
      });
    }
    for (const modelMeta of ModelRegistry.allModels()) {
      this.createModelStore(db, modelMeta.name);
    }
  }

  /** Run an incremental migration: add/remove/update stores. */
  private migrateSchema(db: IDBDatabase, upgradeTx: IDBTransaction) {
    // Ensure system stores exist
    if (!db.objectStoreNames.contains("__meta")) {
      db.createObjectStore("__meta");
    }
    if (!db.objectStoreNames.contains("__transactions")) {
      db.createObjectStore("__transactions", { autoIncrement: true });
    }
    if (!db.objectStoreNames.contains("__partialIndexes")) {
      db.createObjectStore("__partialIndexes", {
        keyPath: ["modelName", "indexKey", "value"],
      });
    }

    const registeredModels = new Set(
      ModelRegistry.allModels().map((m) => m.name),
    );
    const existingStores = new Set<string>();
    for (let i = 0; i < db.objectStoreNames.length; i++) {
      const name = db.objectStoreNames[i];
      if (!name.startsWith("__")) {
        existingStores.add(name);
      }
    }

    // Add new model stores
    for (const modelName of registeredModels) {
      if (!existingStores.has(modelName)) {
        this.createModelStore(db, modelName);
        this.migrationAddedNewModels = true;
      }
    }

    // Remove stores for models that no longer exist
    for (const storeName of existingStores) {
      if (!registeredModels.has(storeName)) {
        db.deleteObjectStore(storeName);
      }
    }

    // Update indexes on existing stores using the upgrade transaction
    for (const modelName of registeredModels) {
      if (existingStores.has(modelName)) {
        this.migrateIndexes(upgradeTx, modelName);
      }
    }
  }

  /** Create an object store for a model with its indexed properties. */
  private createModelStore(db: IDBDatabase, modelName: string) {
    const store = db.createObjectStore(modelName, { keyPath: "id" });
    const meta = ModelRegistry.getModelMeta(modelName);
    if (meta != null) {
      for (const [propName, propMeta] of meta.properties) {
        if (propMeta.indexed === true) {
          store.createIndex(propName, propName, { unique: false });
        }
      }
    }
  }

  /** Add/remove indexes on an existing store to match current ModelRegistry. */
  private migrateIndexes(upgradeTx: IDBTransaction, modelName: string) {
    const meta = ModelRegistry.getModelMeta(modelName);
    if (meta == null) {
      return;
    }

    // Use the upgrade transaction — the only transaction that can modify indexes.
    const store = upgradeTx.objectStore(modelName);

    // Indexes that should exist based on current metadata
    const wantedIndexes = new Set<string>();
    for (const [propName, propMeta] of meta.properties) {
      if (propMeta.indexed === true) {
        wantedIndexes.add(propName);
      }
    }

    // Remove indexes that shouldn't exist anymore
    const existingIndexes: string[] = [];
    for (let i = 0; i < store.indexNames.length; i++) {
      existingIndexes.push(store.indexNames[i]);
    }
    for (const indexName of existingIndexes) {
      if (!wantedIndexes.has(indexName)) {
        store.deleteIndex(indexName);
      }
    }

    // Add indexes that don't exist yet
    for (const indexName of wantedIndexes) {
      if (!store.indexNames.contains(indexName)) {
        store.createIndex(indexName, indexName, { unique: false });
      }
    }
  }

  // =========================================================================
  // Bootstrap type detection
  // =========================================================================

  async determineBootstrapType(): Promise<BootstrapType> {
    const meta = await this.loadMeta();

    // No meta → first time → full bootstrap
    if (meta == null) {
      return BootstrapType.Full;
    }

    // If migration added new model stores, those stores need data.
    // A partial bootstrap (delta since lastSyncId) should cover this —
    // the server sends all data for models the client doesn't have.
    // But if the delta is too old, fall back to full.
    if (this.migrationAddedNewModels) {
      // Partial bootstrap should work — server sends everything since lastSyncId,
      // which includes data for the new model types.
      // Only fall back to full if there's no lastSyncId at all.
      if (meta.lastSyncId <= 0) {
        return BootstrapType.Full;
      }
    }

    // A schemaVersion bump cleared rows for one or more models — partial
    // bootstrap won't refill them (it only ships deltas since lastSyncId).
    // Force a Full bootstrap so cleared model stores get repopulated.
    if (this.migrationClearedModels) {
      return BootstrapType.Full;
    }

    // Valid data exists
    if (meta.lastSyncId > 0) {
      return BootstrapType.Partial;
    }

    return BootstrapType.Local;
  }

  // =========================================================================
  // Meta
  // =========================================================================

  async loadMeta(): Promise<DatabaseMeta | null> {
    if (this.db == null) {
      return null;
    }
    try {
      const result = await this.idbGet<DatabaseMeta>("__meta", "meta");
      this.meta = result;
      return result;
    } catch {
      // __meta store might not exist yet (first open before upgrade)
      return null;
    }
  }

  async saveMeta(meta: DatabaseMeta): Promise<void> {
    if (this.db == null) {
      return;
    }
    // Default the per-model schemaVersion snapshot from the live registry
    // when the caller didn't provide one — so bumps are detectable on the
    // next connect. Caller-supplied values win.
    const merged: DatabaseMeta = {
      ...meta,
      modelSchemaVersions: meta.modelSchemaVersions ?? currentModelVersions(),
    };
    this.meta = merged;
    await this.idbPut("__meta", merged, "meta");
  }

  get currentMeta() {
    return this.meta;
  }

  // =========================================================================
  // Model data operations
  // =========================================================================

  async writeModels(
    modelName: string,
    records: Record<string, unknown>[],
  ): Promise<void> {
    if (!this.hasStore(modelName)) {
      return;
    }
    const tx = this.db!.transaction(modelName, "readwrite");
    const store = tx.objectStore(modelName);
    for (const record of records) {
      store.put(record);
    }
    return this.waitForTransaction(tx);
  }

  async writeModelsIfAbsent(
    modelName: string,
    records: Record<string, unknown>[],
  ): Promise<void> {
    if (!this.hasStore(modelName) || records.length === 0) {
      return;
    }
    // IDB transactions on a single connection are serialized, so no gap between
    // the read and write can let a concurrent write slip through.
    const existingKeys = await new Promise<Set<string>>((resolve, reject) => {
      const r = this.db!.transaction(modelName, "readonly")
        .objectStore(modelName)
        .getAllKeys();
      r.onsuccess = () => resolve(new Set(r.result as string[]));
      r.onerror = () => reject(r.error);
    });
    const newRecords = records.filter((r) => !existingKeys.has(r.id as string));
    if (newRecords.length === 0) {
      return;
    }
    const tx = this.db!.transaction(modelName, "readwrite");
    const store = tx.objectStore(modelName);
    for (const record of newRecords) {
      store.put(record);
    }
    return this.waitForTransaction(tx);
  }

  async readAllModels(modelName: string): Promise<Record<string, unknown>[]> {
    if (!this.hasStore(modelName)) {
      return [];
    }
    return this.idbGetAll(modelName);
  }

  async readModel(
    modelName: string,
    id: string,
  ): Promise<Record<string, unknown> | null> {
    if (!this.hasStore(modelName)) {
      return null;
    }
    return this.idbGet(modelName, id);
  }

  async readModelsByIndex(
    modelName: string,
    indexName: string,
    value: string,
  ): Promise<Record<string, unknown>[]> {
    if (!this.hasStore(modelName)) {
      return [];
    }
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(modelName, "readonly");
      const store = tx.objectStore(modelName);
      if (store.indexNames.contains(indexName)) {
        const r = store.index(indexName).getAll(value);
        r.onsuccess = () => resolve(r.result ?? []);
        r.onerror = () => reject(r.error);
      } else {
        // Fallback: full scan + filter (slower, but correct)
        const r = store.getAll();
        r.onsuccess = () =>
          resolve(
            (r.result ?? []).filter(
              (rec: Record<string, unknown>) => rec[indexName] === value,
            ),
          );
        r.onerror = () => reject(r.error);
      }
    });
  }

  async deleteModel(modelName: string, id: string): Promise<void> {
    if (!this.hasStore(modelName)) {
      return;
    }
    const tx = this.db!.transaction(modelName, "readwrite");
    tx.objectStore(modelName).delete(id);
    return this.waitForTransaction(tx);
  }

  /** Delete multiple records in a single IDB transaction. */
  async deleteModels(modelName: string, ids: string[]): Promise<void> {
    if (!this.hasStore(modelName) || ids.length === 0) {
      return;
    }
    const tx = this.db!.transaction(modelName, "readwrite");
    const store = tx.objectStore(modelName);
    for (const id of ids) {
      store.delete(id);
    }
    return this.waitForTransaction(tx);
  }

  async deleteModelsByIndex(
    modelName: string,
    indexName: string,
    value: string,
  ): Promise<void> {
    if (!this.hasStore(modelName)) {
      return;
    }
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(modelName, "readwrite");
      const store = tx.objectStore(modelName);
      const request = store.indexNames.contains(indexName)
        ? store.index(indexName).openCursor(IDBKeyRange.only(value))
        : store.openCursor();
      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
        if (cursor == null) {
          return;
        }
        if (
          !store.indexNames.contains(indexName) &&
          cursor.value[indexName] !== value
        ) {
          cursor.continue();
          return;
        }
        cursor.delete();
        cursor.continue();
      };
      request.onerror = () => reject(request.error);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async clearModelStore(modelName: string): Promise<void> {
    if (!this.hasStore(modelName)) {
      return;
    }
    const tx = this.db!.transaction(modelName, "readwrite");
    tx.objectStore(modelName).clear();
    return this.waitForTransaction(tx);
  }

  // =========================================================================
  // Transaction cache
  // =========================================================================

  async cacheTransaction(data: unknown): Promise<number | null> {
    if (this.db == null) {
      return null;
    }
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction("__transactions", "readwrite");
      const r = tx.objectStore("__transactions").add(data);
      r.onsuccess = () => resolve(r.result as number);
      r.onerror = () => reject(r.error);
    });
  }

  async getCachedTransactions(): Promise<unknown[]> {
    if (this.db == null) {
      return [];
    }
    return this.idbGetAll("__transactions");
  }

  async deleteCachedTransactions(idbKeys: number[]): Promise<void> {
    if (this.db == null || idbKeys.length === 0) {
      return;
    }
    const tx = this.db.transaction("__transactions", "readwrite");
    const store = tx.objectStore("__transactions");
    for (const key of idbKeys) {
      store.delete(key);
    }
    return this.waitForTransaction(tx);
  }

  async clearCachedTransactions(): Promise<void> {
    if (this.db == null) {
      return;
    }
    const tx = this.db.transaction("__transactions", "readwrite");
    tx.objectStore("__transactions").clear();
    return this.waitForTransaction(tx);
  }

  // =========================================================================
  // Partial-index coverage store
  //
  // Records `(modelName, indexKey, value)` triples for which loadCollection has
  // fetched in full. Survives reload — on next bootstrap the engine populates
  // its in-memory cache from this store and skips redundant network/IDB work.
  // =========================================================================

  async recordPartialIndex(
    modelName: string,
    indexKey: string,
    value: string,
    firstSyncId: number,
  ): Promise<void> {
    if (this.db == null) {
      return;
    }
    const tx = this.db.transaction("__partialIndexes", "readwrite");
    tx.objectStore("__partialIndexes").put({
      modelName,
      indexKey,
      value,
      firstSyncId,
    });
    return this.waitForTransaction(tx);
  }

  async clearPartialIndex(
    modelName: string,
    indexKey: string,
    value: string,
  ): Promise<void> {
    if (this.db == null) {
      return;
    }
    const tx = this.db.transaction("__partialIndexes", "readwrite");
    tx.objectStore("__partialIndexes").delete([modelName, indexKey, value]);
    return this.waitForTransaction(tx);
  }

  async clearPartialIndexesForModel(modelName: string): Promise<void> {
    if (this.db == null) {
      return;
    }
    const tx = this.db.transaction("__partialIndexes", "readwrite");
    // IDB delete accepts a key range — drops every entry whose first compound
    // component is `modelName` in a single op.
    tx.objectStore("__partialIndexes").delete(
      IDBKeyRange.bound([modelName], [modelName, []], false, false),
    );
    return this.waitForTransaction(tx);
  }

  async loadPartialIndexes(): Promise<PartialIndexEntry[]> {
    if (this.db == null) {
      return [];
    }
    return this.idbGetAll("__partialIndexes") as Promise<PartialIndexEntry[]>;
  }

  // =========================================================================
  // Cleanup
  // =========================================================================

  /** Close the IDB connection without deleting any data. */
  async close(): Promise<void> {
    this.db?.close();
    this.db = null;
  }

  /** Close the connection AND delete all persisted data for this workspace. */
  async destroy(): Promise<void> {
    await this.close();
    if (typeof indexedDB !== "undefined") {
      indexedDB.deleteDatabase(`sync_${this.workspaceId}`);
    }
  }

  get isConnected() {
    return this.db !== null;
  }

  // =========================================================================
  // Helpers
  // =========================================================================

  private hasStore(name: string): boolean {
    return this.db != null && this.db.objectStoreNames.contains(name);
  }

  private idbGet<T>(storeName: string, key: string): Promise<T | null> {
    return new Promise((resolve, reject) => {
      const r = this.db!.transaction(storeName, "readonly")
        .objectStore(storeName)
        .get(key);
      r.onsuccess = () => resolve(r.result ?? null);
      r.onerror = () => reject(r.error);
    });
  }

  private idbGetAll<T>(storeName: string): Promise<T[]> {
    return new Promise((resolve, reject) => {
      const r = this.db!.transaction(storeName, "readonly")
        .objectStore(storeName)
        .getAll();
      r.onsuccess = () => resolve(r.result ?? []);
      r.onerror = () => reject(r.error);
    });
  }

  private idbPut(
    storeName: string,
    value: unknown,
    key?: string,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(storeName, "readwrite");
      tx.objectStore(storeName).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  private waitForTransaction(tx: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
}
