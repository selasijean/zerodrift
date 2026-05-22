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

import { ModelRegistry } from "./ModelRegistry.js";

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
 * One recorded `getOrLoadCollection(modelName, indexKey, value)` query, captured
 * with the `lastSyncId` at the time of fetch. Adopters ship these to the
 * server on partial fetches so it can return only deltas since `firstSyncId`.
 */
export interface PartialIndexEntry {
  modelName: string;
  indexKey: string;
  value: string;
  firstSyncId: number;
}

/** A header for a server-confirmed sync action — persisted in the
 * `__syncActions` store so crash-recovery can decide whether the awaited
 * delta has already arrived (and whether a pending tx's target was
 * deleted while the client was away). */
export interface SyncActionHeader {
  syncId: number;
  modelName: string;
  modelId: string;
  action: "I" | "U" | "D" | "A" | "V" | "C";
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
 * Diff stored vs current per-model schemaVersions. `cleared` lists models
 * whose version bumped (rows + partial-index coverage wiped) and models
 * removed from the registry (coverage wiped). `newlyAdded` lists models
 * present in the registry but missing from a non-empty `stored` snapshot —
 * the caller targets these in a follow-up full-bootstrap call.
 */
export async function diffModelVersions(
  adapter: Pick<
    StorageAdapter,
    "clearModelStore" | "clearPartialIndexesForModel"
  >,
  stored: Record<string, number> | undefined,
): Promise<{ cleared: string[]; newlyAdded: string[] }> {
  const cleared: string[] = [];
  const newlyAdded: string[] = [];
  const current = currentModelVersions();
  const storedMap = stored ?? {};
  const knownStored = Object.keys(storedMap).length > 0;

  for (const [name, version] of Object.entries(current)) {
    const previous = storedMap[name];
    if (previous == null) {
      // No record for this model. Treat as "newly added" only when the
      // adopter has previously persisted some versions (i.e. they upgraded
      // the engine *and* added a model). Otherwise it's a legacy meta and we
      // trust the existing rows.
      if (knownStored) {
        newlyAdded.push(name);
      }
      continue;
    }
    if (previous === version) {
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
  return { cleared, newlyAdded };
}

/**
 * Tracks which models have at least one row in storage and notifies
 * listeners on add/remove transitions. Composed by both `Database` and
 * `MemoryAdapter` (the trio of mark/unmark/onChange + listener Set is
 * adapter-agnostic, so the duplication doesn't have to live in each).
 */
export class LoadedModelsTracker {
  private set = new Set<string>();
  private listeners = new Set<() => void>();

  get loadedModels(): ReadonlySet<string> {
    return this.set;
  }

  /** Mark a model as having data. Notifies listeners on the first add. */
  markLoaded(modelName: string): void {
    if (this.set.has(modelName)) {
      return;
    }
    this.set.add(modelName);
    this.notify();
  }

  /** Mark a model as empty (e.g. after `clearModelStore`). */
  markUnloaded(modelName: string): void {
    if (!this.set.has(modelName)) {
      return;
    }
    this.set.delete(modelName);
    this.notify();
  }

  /** Empty the tracker without firing listeners — used at the start of
   * `connect()` before re-seeding. */
  reset(): void {
    this.set.clear();
  }

  /** Seed without notifying — used by `connect()` to populate from storage. */
  seed(modelName: string): void {
    this.set.add(modelName);
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private notify(): void {
    for (const cb of this.listeners) {
      try {
        cb();
      } catch {
        // A misbehaving listener mustn't reject the write that triggered it.
      }
    }
  }
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
  /**
   * Names of models present in the live registry but missing from the
   * persisted `modelSchemaVersions` snapshot — i.e., new since the last
   * connect. Populated during `connect()`. StoreManager runs a targeted
   * full fetch for just these so adopters don't need to bump anything.
   */
  readonly newlyAddedModels: string[];
  /**
   * Names of models with at least one row in local storage. Seeded on
   * `connect()` and grown as `writeModels` / `writeModelsIfAbsent` write
   * records; shrinks when a store is fully cleared. The SSE catchup URL
   * passes this set as `onlyModels` so the server skips deltas for models
   * the client never touched.
   */
  readonly loadedModels: ReadonlySet<string>;
  /** Subscribe to add/remove transitions on `loadedModels`. Returns an
   * unsubscribe function. Per-row deletes don't fire — only first writes
   * to a model and full clears do. */
  onLoadedModelsChange(cb: () => void): () => void;
  /** Mark a model as loaded even when no rows were written — e.g.
   * `getOrLoadCollection` returned an empty server response, which still
   * expresses "we want SSE deltas for this model". `writeModels` already
   * covers the non-empty case; this is the path for empty-but-successful
   * fetches. */
  markModelLoaded(modelName: string): void;
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
  /**
   * Update an existing cached transaction by `idbKey`. Used to flag a
   * transaction as awaiting a specific syncId (server-ack'd, waiting for the
   * matching SSE delta). On crash, recovery checks the SyncAction store to
   * decide whether the awaited delta already arrived.
   */
  updateCachedTransaction(idbKey: number, data: unknown): Promise<void>;
  /** Returns `(idbKey, data)` pairs so recovery can selectively delete
   * resolved entries without clearing the whole store. */
  getCachedTransactions(): Promise<{ idbKey: number; data: unknown }[]>;
  deleteCachedTransactions(keys: number[]): Promise<void>;
  clearCachedTransactions(): Promise<void>;
  /**
   * Persist headers for received SSE sync actions. Crash-recovery checks this
   * store to (a) recognize transactions whose ack-syncId already arrived,
   * (b) detect that a pending tx's target was deleted before the queue could
   * flush. Headers only — `data` is not stored, since the model state is
   * already durable in its own store.
   */
  recordSyncActions(actions: SyncActionHeader[]): Promise<void>;
  hasSyncAction(syncId: number): Promise<boolean>;
  findSyncActionsForModel(
    modelName: string,
    modelId: string,
  ): Promise<{ syncId: number; action: string }[]>;
  /** Drop sync actions older than `belowSyncId`. Called periodically to bound storage. */
  pruneSyncActionsBelow(belowSyncId: number): Promise<void>;
  /**
   * Record that a `getOrLoadCollection(modelName, indexKey, value)` query has been
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
   * Called by StoreManager.destroy() for explicit logout / factory-reset
   * flows — NOT for routine teardown.
   */
  destroy(): Promise<void>;
  get isConnected(): boolean;
}

export class Database implements StorageAdapter {
  private db: IDBDatabase | null = null;
  private workspaceId: string;
  private meta: DatabaseMeta | null = null;

  newlyAddedModels: string[] = [];
  /** Set to true if connect() cleared rows for one or more models because
   * their per-model `schemaVersion` bumped. Forces a Full bootstrap so the
   * cleared rows refill from the server. */
  migrationClearedModels = false;
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
    this.newlyAddedModels = [];
    this.loadedTracker.reset();

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

    // Step 5: Diff per-model schemaVersions. Bumped models get their rows +
    // partial-index coverage wiped (the IDB structure migrated in step 4 but
    // the rows are still in the old shape). Newly added models are reported
    // for a targeted follow-up fetch by StoreManager.
    if (meta != null) {
      const { cleared, newlyAdded } = await diffModelVersions(
        this,
        meta.modelSchemaVersions,
      );
      this.migrationClearedModels = cleared.length > 0;
      // migrateSchema already pushed any model whose IDB store was newly
      // created (covering the legacy-meta + new-model case where stored
      // versions are empty); on the typical "adopter added a new model" path
      // both sources fire for the same name, so we dedupe.
      this.newlyAddedModels = [
        ...new Set([...this.newlyAddedModels, ...newlyAdded]),
      ];
    }

    // Update the dbVersion + per-model versions in meta after migration
    if (meta != null) {
      meta.dbVersion = newVersion;
      meta.schemaHash = ModelRegistry.schemaHash;
      meta.modelSchemaVersions = currentModelVersions();
      await this.saveMeta(meta);
    }

    await this.seedLoadedModels();
  }

  /** One IDB count() per store to seed `loadedModels` with anything that
   * survived from a prior session. Runs once per connect. */
  private async seedLoadedModels(): Promise<void> {
    if (this.db == null) {
      return;
    }
    const names = [...this.db.objectStoreNames].filter(
      (name) => !name.startsWith("__"),
    );
    if (names.length === 0) {
      return;
    }
    const tx = this.db.transaction(names, "readonly");
    await Promise.all(
      names.map(
        (name) =>
          new Promise<void>((resolve, reject) => {
            const r = tx.objectStore(name).count();
            r.onsuccess = () => {
              if ((r.result as number) > 0) {
                this.loadedTracker.seed(name);
              }
              resolve();
            };
            r.onerror = () => reject(r.error);
          }),
      ),
    );
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

  /** Create the engine's reserved stores (`__`-prefixed) if they don't yet
   * exist. Called from both first-time creation and incremental migration —
   * adding a new system store means one entry here, not two. */
  private ensureSystemStores(db: IDBDatabase): void {
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
    if (!db.objectStoreNames.contains("__syncActions")) {
      const syncActions = db.createObjectStore("__syncActions", {
        keyPath: ["syncId", "modelName", "modelId"],
      });
      syncActions.createIndex("byModel", ["modelName", "modelId"]);
      syncActions.createIndex("bySyncId", "syncId");
    }
  }

  /** Create all stores from scratch (first-time DB creation). */
  private createAllStores(db: IDBDatabase) {
    this.ensureSystemStores(db);
    for (const modelMeta of ModelRegistry.allModels()) {
      this.createModelStore(db, modelMeta.name);
    }
  }

  /** Run an incremental migration: add/remove/update stores. */
  private migrateSchema(db: IDBDatabase, upgradeTx: IDBTransaction) {
    this.ensureSystemStores(db);

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
        this.newlyAddedModels.push(modelName);
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

    // If migration added new model stores AND there's no prior sync, fall
    // back to Full — there's nothing to fetch deltas against. With a
    // lastSyncId in hand, partial bootstrap proceeds and StoreManager runs
    // a targeted fullBootstrap call for just `newlyAddedModels` after.
    if (this.newlyAddedModels.length > 0 && meta.lastSyncId <= 0) {
      return BootstrapType.Full;
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
    if (!this.hasStore(modelName) || records.length === 0) {
      return;
    }
    const tx = this.db!.transaction(modelName, "readwrite");
    const store = tx.objectStore(modelName);
    for (const record of records) {
      store.put(record);
    }
    await this.waitForTransaction(tx);
    this.loadedTracker.markLoaded(modelName);
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
    await this.waitForTransaction(tx);
    this.loadedTracker.markLoaded(modelName);
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
    await this.waitForTransaction(tx);
    this.loadedTracker.markUnloaded(modelName);
  }

  // =========================================================================
  // Transaction cache
  // =========================================================================

  /**
   * Open a `__transactions` transaction, tolerating the brief window where
   * the connection is closing but not yet nulled — a cross-tab `versionchange`
   * upgrade, or teardown racing an SSE reconnect. In that window `this.db` is
   * still non-null yet `.transaction()` throws `InvalidStateError` ("the
   * database connection is closing"). Returns `null` so callers degrade
   * gracefully: the transaction cache is a best-effort resend buffer that
   * self-heals on the next clean connection.
   */
  private openTxCacheTx(mode: IDBTransactionMode): IDBTransaction | null {
    if (this.db == null) {
      return null;
    }
    try {
      return this.db.transaction("__transactions", mode);
    } catch (err) {
      if ((err as { name?: string } | null)?.name === "InvalidStateError") {
        return null;
      }
      throw err;
    }
  }

  async cacheTransaction(data: unknown): Promise<number | null> {
    const tx = this.openTxCacheTx("readwrite");
    if (tx == null) {
      return null;
    }
    return new Promise((resolve, reject) => {
      const r = tx.objectStore("__transactions").add(data);
      r.onsuccess = () => resolve(r.result as number);
      r.onerror = () => reject(r.error);
    });
  }

  async getCachedTransactions(): Promise<{ idbKey: number; data: unknown }[]> {
    const tx = this.openTxCacheTx("readonly");
    if (tx == null) {
      return [];
    }
    return new Promise((resolve, reject) => {
      const store = tx.objectStore("__transactions");
      const out: { idbKey: number; data: unknown }[] = [];
      const cursor = store.openCursor();
      cursor.onsuccess = () => {
        const c = cursor.result;
        if (c == null) {
          resolve(out);
          return;
        }
        out.push({ idbKey: c.primaryKey as number, data: c.value });
        c.continue();
      };
      cursor.onerror = () => reject(cursor.error);
    });
  }

  async deleteCachedTransactions(idbKeys: number[]): Promise<void> {
    if (idbKeys.length === 0) {
      return;
    }
    const tx = this.openTxCacheTx("readwrite");
    if (tx == null) {
      return;
    }
    const store = tx.objectStore("__transactions");
    for (const key of idbKeys) {
      store.delete(key);
    }
    return this.waitForTransaction(tx);
  }

  async clearCachedTransactions(): Promise<void> {
    const tx = this.openTxCacheTx("readwrite");
    if (tx == null) {
      return;
    }
    tx.objectStore("__transactions").clear();
    return this.waitForTransaction(tx);
  }

  async updateCachedTransaction(idbKey: number, data: unknown): Promise<void> {
    const tx = this.openTxCacheTx("readwrite");
    if (tx == null) {
      return;
    }
    tx.objectStore("__transactions").put(data, idbKey);
    return this.waitForTransaction(tx);
  }

  // =========================================================================
  // SyncAction store — persisted change-log headers for crash recovery.
  // =========================================================================

  async recordSyncActions(actions: SyncActionHeader[]): Promise<void> {
    if (this.db == null || actions.length === 0) {
      return;
    }
    const tx = this.db.transaction("__syncActions", "readwrite");
    const store = tx.objectStore("__syncActions");
    for (const a of actions) {
      store.put(a);
    }
    return this.waitForTransaction(tx);
  }

  async hasSyncAction(syncId: number): Promise<boolean> {
    if (this.db == null) {
      return false;
    }
    return new Promise((resolve, reject) => {
      const r = this.db!.transaction("__syncActions", "readonly")
        .objectStore("__syncActions")
        .index("bySyncId")
        .getKey(syncId);
      r.onsuccess = () => resolve(r.result != null);
      r.onerror = () => reject(r.error);
    });
  }

  async findSyncActionsForModel(
    modelName: string,
    modelId: string,
  ): Promise<{ syncId: number; action: string }[]> {
    if (this.db == null) {
      return [];
    }
    return new Promise((resolve, reject) => {
      const r = this.db!.transaction("__syncActions", "readonly")
        .objectStore("__syncActions")
        .index("byModel")
        .getAll([modelName, modelId]);
      r.onsuccess = () => {
        const rows = (r.result ?? []) as {
          syncId: number;
          action: string;
        }[];
        resolve(rows.map((row) => ({ syncId: row.syncId, action: row.action })));
      };
      r.onerror = () => reject(r.error);
    });
  }

  async pruneSyncActionsBelow(belowSyncId: number): Promise<void> {
    if (this.db == null) {
      return;
    }
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction("__syncActions", "readwrite");
      const store = tx.objectStore("__syncActions");
      const cursor = store
        .index("bySyncId")
        .openCursor(IDBKeyRange.upperBound(belowSyncId, true));
      cursor.onsuccess = () => {
        const c = cursor.result;
        if (c == null) {
          return;
        }
        c.delete();
        c.continue();
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  // =========================================================================
  // Partial-index coverage store
  //
  // Records `(modelName, indexKey, value)` triples for which getOrLoadCollection has
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
