/**
 * StoreManager — the top-level orchestrator.
 *
 * Owns: ObjectPool, Database, TransactionQueue, SyncConnection, all Stores.
 *
 * Bootstrap phases (for loading indicators):
 *   idle → creatingStores → connectingDatabase → determiningBootstrapType
 *        → fetching → writingToDatabase → hydrating → connectingSync → ready
 *
 * Batch API:
 *   storeManager.batch(() => {
 *     issue.title = "x"; issue.save();
 *     team.name = "y"; team.save();
 *   });
 *   storeManager.undo(); // reverts both
 *
 * Lazy loading:
 *   storeManager.loadCollection("Issue", "teamId", teamId)
 *   storeManager.loadOne("DocumentContent", docId)
 */

import { ModelRegistry } from "./ModelRegistry";
import { ObjectPool } from "./ObjectPool";
import {
  Database,
  BootstrapType,
  type StorageAdapter,
  type DatabaseMeta,
} from "./Database";
import {
  FullStore,
  PartialStore,
  EphemeralStore,
  type ModelStore,
} from "./Store";
import { TransactionQueue, type TransactionSender } from "./TransactionQueue";
import {
  SyncConnection,
  type DeltaPacket,
  type SSEClientFactory,
  type SyncMessageTransform,
  createBrowserSSEFactory,
} from "./SyncConnection";
import { ModelStream, type ModelStreamMessageTransform } from "./ModelStream";
import { BaseModel } from "./BaseModel";
import {
  BootstrapPhase,
  LoadStrategy,
  PropertyType,
  toError,
  type ModelMeta,
  type PropertyChange,
  type EngineErrorContext,
  type EngineErrorHandler,
} from "./types";

function prop(model: BaseModel, key: string): unknown {
  return (model as unknown as Record<string, unknown>)[key];
}

/**
 * Thrown when a delete/archive is blocked by an onDelete: "restrict" relationship.
 *
 * Example: if Label has @Reference("Team", { onDelete: "restrict" }) and you
 * try to delete a Team that has Labels pointing to it, this error is thrown
 * with details about which model and property blocked the deletion.
 */
export class RestrictDeleteError extends Error {
  constructor(
    public deletedModelName: string,
    public deletedModelId: string,
    public restrictedByModel: string,
    public restrictedByProperty: string,
  ) {
    super(
      `Cannot delete ${deletedModelName} "${deletedModelId}": ` +
        `referenced by ${restrictedByModel}.${restrictedByProperty} with onDelete: "restrict"`,
    );
    this.name = "RestrictDeleteError";
  }
}

export interface BootstrapResponse {
  lastSyncId: number;
  subscribedSyncGroups: string[];
  models: Record<string, Record<string, unknown>[]>;
  /** Server-side schema version. Mismatch with stored value → full bootstrap. */
  backendDatabaseVersion?: number;
  /**
   * Tombstones for records the client may already have but the server has
   * since deleted, grouped by model name. Safe to omit when the client has
   * no prior state (e.g. first-time full bootstrap).
   */
  deletedIds?: Record<string, string[]>;
}

export interface FetcherContext {
  currentMeta?: DatabaseMeta | null;
}

export interface BootstrapFetcherOptions extends FetcherContext {
  sinceSyncId?: number;
  onlyModels?: string[];
  /**
   * Scope the response to records belonging to these sync groups. Set by the
   * engine when activating a sync group at runtime or reacting to a delta that
   * added the client to new groups. Server should ignore unrelated records.
   */
  syncGroups?: string[];
}

export type BootstrapFetcher = (
  type: BootstrapType.Full | BootstrapType.Partial,
  options?: BootstrapFetcherOptions,
) => Promise<BootstrapResponse>;

export interface ModelStreamConfig {
  url: string;
  onStatusChange?: (connected: boolean) => void;
  /**
   * Use when the backend sends a different envelope than the engine's
   * canonical `{ modelName, modelId, data }`.
   */
  transform?: ModelStreamMessageTransform;
}

export interface StoreManagerConfig {
  workspaceId: string;
  bootstrapFetcher: BootstrapFetcher;
  transactionSender?: TransactionSender;
  syncUrl?: string;

  /** Secondary model update streams (e.g. a calculation service). */
  modelStreams?: ModelStreamConfig[];

  /**
   * Custom SSE client factory. Defaults to the browser's built-in EventSource.
   * Override to use the engine outside the browser — e.g. in Node.js or an agent:
   *
   *   import EventSource from "eventsource";
   *   sseClientFactory: (url) => new EventSource(url)
   *
   * When set, `sseInit` is ignored — your factory is responsible for any options.
   */
  sseClientFactory?: SSEClientFactory;

  /**
   * Init options forwarded to the default browser EventSource (e.g. cookie auth):
   *
   *   sseInit: { withCredentials: true }
   *
   * Applies to the main sync stream and every entry in `modelStreams`. Ignored
   * when `sseClientFactory` is set.
   */
  sseInit?: EventSourceInit;

  /**
   * Use when the backend sends a different envelope than the canonical
   * `DeltaPacket`. Return null to drop a message.
   */
  syncTransform?: SyncMessageTransform;

  /**
   * Custom storage backend. Defaults to IndexedDB (`Database`).
   * Override for environments without IndexedDB — e.g. Node.js agents:
   *
   *   import { MemoryAdapter } from "./MemoryAdapter";
   *   storageAdapter: new MemoryAdapter()
   *
   * Implement `StorageAdapter` to plug in SQLite, Redis, or any other backend.
   * If omitted, `Database` is used and gracefully falls back to in-memory when
   * IndexedDB is unavailable (no crash, but no persistence across restarts).
   */
  storageAdapter?: StorageAdapter;

  /**
   * Maximum number of undo entries kept in memory. Defaults to 100.
   * Lower this for long-running agents that make many writes and don't need
   * deep undo history (each entry holds model snapshots).
   */
  undoLimit?: number;

  /**
   * Two-phase full bootstrap. If provided, the first fetch loads only
   * the critical models (everything NOT in this list). Once hydrated
   * and the UI is interactive, a second background fetch loads these
   * deferred models. The first fetch loads critical models (e.g.
   * Issue/Team/User) and the second loads the rest (e.g. Comment/Reaction/Attachment).
   *
   * If not provided, all models are fetched in a single request.
   */
  deferredModels?: string[];

  /**
   * Progressive / on-demand loading. When provided, models with
   * Partial/Lazy/ExplicitlyRequested load strategies are NOT included
   * in the bootstrap fetch. Instead, the first time a collection is
   * accessed (e.g. issue.comments.load()), this fetcher is called with
   * the scoped query. Results are written to IDB and hydrated into the
   * pool, so subsequent accesses are served locally.
   *
   * SSE deltas still write to IDB for these model types, but new
   * inserts are only hydrated into the pool if the relevant collection
   * has already been loaded for that parent.
   */
  onDemandFetcher?: (
    modelName: string,
    indexKey: string,
    value: string,
  ) => Promise<Record<string, unknown>[]>;

  /** Batch ID lookup used by loadByIds — receives all missing IDs at once so
   * the caller can make a single server request instead of one per ID. */
  onDemandBatchFetcher?: (
    modelName: string,
    ids: string[],
  ) => Promise<Record<string, unknown>[]>;

  onPhaseChange?: (phase: BootstrapPhase, detail?: string) => void;
  onDeltaPacket?: (packet: DeltaPacket) => void;
  onReady?: () => void;

  /**
   * Single hook for every async failure the engine catches internally —
   * eager loads, SSE parse errors, transaction send retries, deferred bootstrap
   * fetches, etc. Adopters typically wire this into Sentry/Datadog/console.
   *
   * Receives the error and a tagged-union `EngineErrorContext` describing the
   * failure site. Throwing from inside the handler is swallowed (it can't break
   * the engine). Without this hook every internal failure is silently dropped.
   */
  onError?: EngineErrorHandler;

  /**
   * Called when a sync group is removed — by `deactivateSyncGroup` or by an
   * SSE delta carrying `removedSyncGroups`. The engine has already updated
   * `dbMeta.subscribedSyncGroups` by the time this fires; SSE reconnect waits
   * for the returned promise.
   *
   * Use it to evict pool/IDB records belonging to the group. The `sm` argument
   * exposes `evictByIndex` / `evictWhere` helpers, the `objectPool`, the
   * `database` adapter, and `ModelRegistry` is importable from the package
   * if you want to walk every registered model.
   */
  onSyncGroupDelete?: (
    groupId: string,
    sm: StoreManager,
  ) => void | Promise<void>;
}

export class StoreManager {
  readonly objectPool: ObjectPool;
  readonly database: StorageAdapter;
  readonly transactionQueue: TransactionQueue;

  private stores = new Map<string, ModelStore>();
  private syncConnection: SyncConnection | null = null;
  private modelStreams: ModelStream[] = [];
  private config: StoreManagerConfig;
  private _phase = BootstrapPhase.Idle;
  private _error: Error | null = null;
  private stopped = false;

  /**
   * Hot cache of collection coverage. Backed by the storage adapter's
   * `__partialIndexes` store, so coverage survives reload — the cache is
   * populated from disk during bootstrap and updated on every successful
   * `loadCollection`. Key format: "ModelName:indexKey:value".
   */
  private loadedCollections = new Set<string>();
  private loadedIds = new Set<string>();

  constructor(config: StoreManagerConfig) {
    this.config = config;
    this.objectPool = new ObjectPool();
    this.database = config.storageAdapter ?? new Database(config.workspaceId);
    this.transactionQueue = new TransactionQueue(
      this.database,
      this.objectPool,
      config.undoLimit,
    );
    if (config.transactionSender != null) {
      this.transactionQueue.setSender(config.transactionSender);
    }
    this.transactionQueue.setErrorReporter((err, ctx) =>
      this.emitError(err, ctx),
    );
    BaseModel.storeManager = this; // wire auto-commit
  }

  // ── Bootstrap phases ──────────────────────────────────────────────────────

  get phase() {
    return this._phase;
  }
  get error() {
    return this._error;
  }
  get isReady() {
    return this._phase === BootstrapPhase.Ready;
  }

  private setPhase(phase: BootstrapPhase, detail?: string) {
    this._phase = phase;
    this.config.onPhaseChange?.(phase, detail);
  }

  /**
   * Route an internal error to `config.onError`. No-op when the hook isn't
   * configured. Wrapped in try/catch so a buggy adopter handler can't crash
   * the engine.
   */
  emitError(err: unknown, context: EngineErrorContext): void {
    const handler = this.config.onError;
    if (handler == null) {
      return;
    }
    try {
      handler(toError(err), context);
    } catch {
      // user's onError threw — swallow
    }
  }

  // ── Bootstrap pipeline ────────────────────────────────────────────────────

  async bootstrap(): Promise<void> {
    if (ModelRegistry.allModels().length === 0) {
      throw new Error(
        "No models registered. Import your model files before calling bootstrap().\n" +
          'Example: import "@/lib/models"; // register models',
      );
    }
    try {
      this.setPhase(BootstrapPhase.CreatingStores);
      for (const meta of ModelRegistry.allModels()) {
        let store: ModelStore;
        if (meta.loadStrategy === LoadStrategy.Ephemeral) {
          store = new EphemeralStore(meta, this.database, this.objectPool);
        } else if (
          meta.loadStrategy === LoadStrategy.Partial ||
          meta.loadStrategy === LoadStrategy.ExplicitlyRequested
        ) {
          store = new PartialStore(meta, this.database, this.objectPool);
        } else {
          store = new FullStore(meta, this.database, this.objectPool);
        }
        this.stores.set(meta.name, store);
      }

      this.setPhase(BootstrapPhase.ConnectingDatabase);
      await this.database.connect();
      if (this.stopped) {
        return;
      }

      // Hydrate the in-memory partial-index cache from the persistent store.
      // Survives reload: coverage recorded in earlier sessions is reused, so
      // already-fetched scoped queries don't re-hit the server. Failure here
      // is non-fatal — the cache stays empty and we re-fetch on demand.
      try {
        for (const entry of await this.database.loadPartialIndexes()) {
          this.loadedCollections.add(
            StoreManager.collectionKey(
              entry.modelName,
              entry.indexKey,
              entry.value,
            ),
          );
        }
      } catch (err) {
        this.emitError(err, { kind: "deferredBootstrap", modelNames: [] });
      }

      this.setPhase(BootstrapPhase.DeterminingBootstrapType);
      const type = await this.database.determineBootstrapType();
      if (this.stopped) {
        return;
      }

      if (type === BootstrapType.Full) {
        await this.fullBootstrap();
      } else if (type === BootstrapType.Partial) {
        await this.partialBootstrap();
      } else {
        await this.localBootstrap();
      }
      if (this.stopped) {
        return;
      }

      this.setPhase(BootstrapPhase.ConnectingSync);
      const sseFactory =
        this.config.sseClientFactory ??
        createBrowserSSEFactory(this.config.sseInit);
      const sseErrorReporter = (err: Error, ctx: EngineErrorContext) =>
        this.emitError(err, ctx);
      if (this.config.syncUrl != null) {
        this.syncConnection = new SyncConnection(
          this.config.syncUrl,
          this.database,
          this.objectPool,
          this.transactionQueue,
          this.config.onDeltaPacket,
          async (added, removed) => {
            await this.handleSyncGroupsAdded(added);
            await this.handleSyncGroupsRemoved(removed);
          },
          this.isCollectionLoaded.bind(this),
          sseFactory,
          this.config.syncTransform,
          sseErrorReporter,
        );
        this.syncConnection.connect();
      }
      for (const streamConfig of this.config.modelStreams ?? []) {
        const stream = new ModelStream(
          streamConfig.url,
          this.database,
          this.objectPool,
          streamConfig.onStatusChange,
          sseFactory,
          streamConfig.transform,
          sseErrorReporter,
        );
        stream.connect();
        this.modelStreams.push(stream);
      }
      await this.transactionQueue.resendCached();
      if (this.stopped) {
        return;
      }

      this.setPhase(BootstrapPhase.Ready);
      this.config.onReady?.();
    } catch (err) {
      this._error = err as Error;
      this.setPhase(BootstrapPhase.Error, (err as Error).message);
      throw err;
    }
  }

  /**
   * Full bootstrap — two-phase fetch.
   *
   * Phase 1: Fetch critical models (everything NOT in deferredModels).
   *          Write to IDB, hydrate into ObjectPool. UI can render.
   *
   * Phase 2: Fetch deferred models (Comment, Reaction, Attachment, etc.)
   *          in the background after the engine is marked ready.
   *          These are less critical for the initial render.
   *
   * If deferredModels is not configured, everything is fetched in one request.
   */
  /**
   * True when the model should be skipped from a bootstrap payload because the
   * configured `onDemandFetcher` will fetch it later on first access. Returns
   * false when no on-demand fetcher is configured (everything ships normally).
   */
  private isSkippedAtBootstrap(m: ModelMeta): boolean {
    if (this.config.onDemandFetcher == null) {
      return false;
    }
    return (
      m.loadStrategy === LoadStrategy.Partial ||
      m.loadStrategy === LoadStrategy.Lazy ||
      m.loadStrategy === LoadStrategy.ExplicitlyRequested
    );
  }

  private async fullBootstrap() {
    const deferred = new Set(this.config.deferredModels ?? []);
    const allMetas = ModelRegistry.allModels();
    const isOnDemand = this.config.onDemandFetcher != null;

    if (deferred.size > 0) {
      // Phase 1: critical models only
      const criticalModels = allMetas
        .filter((m) => !deferred.has(m.name) && !this.isSkippedAtBootstrap(m))
        .map((m) => m.name);
      this.setPhase(
        BootstrapPhase.Fetching,
        `phase 1: ${criticalModels.length} critical models`,
      );
      const res = await this.config.bootstrapFetcher(BootstrapType.Full, {
        onlyModels: criticalModels,
        currentMeta: this.database.currentMeta,
      });

      this.setPhase(BootstrapPhase.WritingToDatabase);
      await Promise.all(
        Object.entries(res.models).map(([name, records]) => {
          const store = this.stores.get(name);
          return store != null
            ? store.loadFromServer(records)
            : Promise.resolve();
        }),
      );
      await this.applyDeletedIds(res);

      this.setPhase(BootstrapPhase.Hydrating, `${this.objectPool.size} models`);
      await this.database.saveMeta({
        lastSyncId: res.lastSyncId,
        subscribedSyncGroups: StoreManager.mergeSubscribedGroups(
          this.database.currentMeta?.subscribedSyncGroups,
          res.subscribedSyncGroups,
        ),
        schemaHash: ModelRegistry.schemaHash,
        dbVersion: this.database.currentMeta?.dbVersion ?? 1,
        backendDatabaseVersion: res.backendDatabaseVersion ?? 0,
      });

      // Phase 2: deferred models — runs AFTER bootstrap() returns and the
      // engine is marked ready. The UI is already interactive at this point.
      const deferredModels = allMetas
        .filter((m) => deferred.has(m.name))
        .map((m) => m.name);
      if (deferredModels.length > 0) {
        this.fetchDeferredModels(deferredModels);
      }
    } else {
      // Single-phase: fetch everything at once.
      // When onDemandFetcher is configured, narrow to fetchable models so the
      // server can omit Partial / Lazy / ExplicitlyRequested data.
      this.setPhase(BootstrapPhase.Fetching, "full");
      const res = await this.config.bootstrapFetcher(BootstrapType.Full, {
        onlyModels: isOnDemand
          ? allMetas
              .filter((m) => !this.isSkippedAtBootstrap(m))
              .map((m) => m.name)
          : undefined,
        currentMeta: this.database.currentMeta,
      });

      this.setPhase(BootstrapPhase.WritingToDatabase);
      await Promise.all(
        Object.entries(res.models).map(([name, records]) => {
          const store = this.stores.get(name);
          return store != null
            ? store.loadFromServer(records)
            : Promise.resolve();
        }),
      );
      await this.applyDeletedIds(res);

      this.setPhase(BootstrapPhase.Hydrating, `${this.objectPool.size} models`);
      await this.database.saveMeta({
        lastSyncId: res.lastSyncId,
        subscribedSyncGroups: StoreManager.mergeSubscribedGroups(
          this.database.currentMeta?.subscribedSyncGroups,
          res.subscribedSyncGroups,
        ),
        schemaHash: ModelRegistry.schemaHash,
        dbVersion: this.database.currentMeta?.dbVersion ?? 1,
        backendDatabaseVersion: res.backendDatabaseVersion ?? 0,
      });
    }
  }

  /**
   * Background fetch for deferred models (phase 2).
   * Runs after the engine is ready — the UI is already interactive.
   * Uses Full bootstrap because the client has never fetched these models before.
   * Any changes that occurred concurrently during phase 1 are covered by SSE,
   * which connects before this method runs.
   *
   * Bypasses clearModelStore to avoid clobbering concurrent SSE writes to IDB.
   * Uses writeModelsIfAbsent so snapshot records only land if SSE hasn't already
   * written a newer version.
   */
  private async fetchDeferredModels(modelNames: string[]) {
    try {
      const currentMeta = this.database.currentMeta;
      const res = await this.config.bootstrapFetcher(BootstrapType.Full, {
        onlyModels: modelNames,
        sinceSyncId: currentMeta?.lastSyncId,
      });
      await Promise.all(
        Object.entries(res.models).map(async ([name, records]) => {
          await this.database.writeModelsIfAbsent(name, records);
        }),
      );
      await this.applyDeletedIds(res);
      const meta = this.database.currentMeta;
      if (meta != null && res.lastSyncId > meta.lastSyncId) {
        meta.lastSyncId = res.lastSyncId;
        await this.database.saveMeta(meta);
      }
    } catch (err) {
      // Deferred fetch failure is non-fatal — models load on demand later.
      // Surface to onError so adopters can monitor.
      this.emitError(err, { kind: "deferredBootstrap", modelNames });
    }
  }

  /** Append-only merge: bootstrap responses never shrink the subscription set. */
  private static mergeSubscribedGroups(
    existing: string[] | undefined,
    fromResponse: string[],
  ): string[] {
    return [...new Set([...(existing ?? []), ...fromResponse])];
  }

  /**
   * Evict tombstones from IDB (skipping Ephemeral models) and the pool.
   * Run AFTER the upsert pass — if an id is in both `res.models` and
   * `res.deletedIds` the tombstone wins (server's delete is authoritative).
   * Cascade/invalidate are skipped; those flow via SSE D actions.
   */
  private async applyDeletedIds(res: BootstrapResponse): Promise<void> {
    if (res.deletedIds == null) {
      return;
    }
    for (const [modelName, ids] of Object.entries(res.deletedIds)) {
      if (ids.length === 0) {
        continue;
      }
      const meta = ModelRegistry.getModelMeta(modelName);
      if (meta?.loadStrategy !== LoadStrategy.Ephemeral) {
        await this.database.deleteModels(modelName, ids);
      }
      for (const id of ids) {
        this.objectPool.remove(modelName, id);
      }
    }
  }

  private async partialBootstrap() {
    const existing = this.database.currentMeta!;

    // Load from IDB first — UI renders immediately with cached data
    this.setPhase(BootstrapPhase.Hydrating, "from IndexedDB");
    await Promise.all(
      [...this.stores.entries()]
        .filter(
          ([name]) =>
            ModelRegistry.getModelMeta(name)?.loadStrategy ===
            LoadStrategy.Instant,
        )
        .map(([, store]) => store.loadFromDatabase()),
    );

    // Fetch delta from server
    this.setPhase(
      BootstrapPhase.Fetching,
      `since syncId ${existing.lastSyncId}`,
    );
    const res = await this.config.bootstrapFetcher(BootstrapType.Partial, {
      sinceSyncId: existing.lastSyncId,
      currentMeta: existing,
    });

    // Check backendDatabaseVersion. If the server's schema changed since our
    // last bootstrap, the delta data might be structured differently (renamed
    // fields, restructured models). We can't safely apply it — fall back to full.
    if (
      res.backendDatabaseVersion !== undefined &&
      existing.backendDatabaseVersion !== undefined &&
      res.backendDatabaseVersion !== existing.backendDatabaseVersion
    ) {
      this.objectPool.clear();
      await this.fullBootstrap();
      return;
    }

    // Apply delta
    this.setPhase(BootstrapPhase.WritingToDatabase);
    for (const [name, records] of Object.entries(res.models)) {
      await this.database.writeModels(name, records);
      const meta = ModelRegistry.getModelMeta(name);
      if (meta?.loadStrategy === LoadStrategy.Instant) {
        for (const r of records) {
          const existing = this.objectPool.getById(name, r.id as string);
          if (existing != null) {
            for (const [k, v] of Object.entries(r)) {
              if (k !== "id") {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (existing as any)[k] = v;
              }
            }
          } else {
            this.objectPool.hydrateAndPut(name, meta, r);
          }
        }
      }
    }
    await this.applyDeletedIds(res);
    await this.database.saveMeta({
      ...existing,
      lastSyncId: res.lastSyncId,
      schemaHash: ModelRegistry.schemaHash,
      dbVersion: existing.dbVersion ?? 1,
      backendDatabaseVersion:
        res.backendDatabaseVersion ?? existing.backendDatabaseVersion ?? 0,
    });
  }

  private async localBootstrap() {
    this.setPhase(BootstrapPhase.Hydrating, "from IndexedDB");
    await Promise.all(
      [...this.stores.entries()]
        .filter(
          ([name]) =>
            ModelRegistry.getModelMeta(name)?.loadStrategy ===
            LoadStrategy.Instant,
        )
        .map(([, store]) => store.loadFromDatabase()),
    );
  }

  // ── Transaction API ────────────────────────────────────────────────────────

  commitCreate(model: BaseModel) {
    const meta = ModelRegistry.getMetaForInstance(model);
    if (meta == null) {
      return;
    }
    model.makeModelObservable();
    this.objectPool.put(meta.name, model);
    const data = model.serialize();
    this.transactionQueue.enqueueCreate(model.id, meta.name, data);
  }

  commitUpdate(
    modelId: string,
    modelName: string,
    changes: Record<string, PropertyChange>,
  ) {
    this.transactionQueue.enqueueUpdate(modelId, modelName, changes);
  }

  /**
   * Delete a model WITH client-side cascade and restrict validation.
   *
   * Pre-validation: checks for References with onDelete: "restrict".
   * If any model instance references the one being deleted via a restrict
   * relationship, the delete is refused with a RestrictDeleteError.
   *
   * Cascade: walks the ModelRegistry for:
   *   - BackReferences pointing at this model → delete those "owned" models
   *   - References with onDelete: "cascade" → delete those dependent models
   *   - References with onDelete: "nullify" → set the reference to null
   *
   * All operations are grouped in a batch so undo reverses everything.
   */
  deleteModel(model: BaseModel) {
    const meta = ModelRegistry.getMetaForInstance(model);
    if (meta == null) {
      return this.transactionQueue.enqueueDelete(model);
    }

    // Pre-validate: check onDelete: "restrict"
    const restriction = this.checkDeleteRestriction(meta.name, model.id);
    if (restriction != null) {
      throw new RestrictDeleteError(
        meta.name,
        model.id,
        restriction.modelName,
        restriction.propertyName,
      );
    }

    const batchId = this.transactionQueue.beginBatch();
    try {
      this.cascadeDeleteClient(meta.name, model.id);
      this.transactionQueue.enqueueDelete(model);
    } finally {
      this.transactionQueue.endBatch(batchId);
    }
  }

  /** Archive a model WITH client-side cascade and restrict validation. */
  archiveModel(model: BaseModel) {
    const meta = ModelRegistry.getMetaForInstance(model);
    if (meta == null) {
      return this.transactionQueue.enqueueArchive(model);
    }

    const restriction = this.checkDeleteRestriction(meta.name, model.id);
    if (restriction != null) {
      throw new RestrictDeleteError(
        meta.name,
        model.id,
        restriction.modelName,
        restriction.propertyName,
      );
    }

    const batchId = this.transactionQueue.beginBatch();
    try {
      this.cascadeArchiveClient(meta.name, model.id);
      this.transactionQueue.enqueueArchive(model);
    } finally {
      this.transactionQueue.endBatch(batchId);
    }
  }

  /**
   * Check if any Reference with onDelete: "restrict" blocks this deletion.
   *
   * Walks all registered models. For each Reference property that points
   * to the model type being deleted and has onDelete: "restrict", checks
   * if any instance in the ObjectPool actually references the target ID.
   *
   * Returns the first restriction found, or null if deletion is allowed.
   */
  private checkDeleteRestriction(
    deletedModelName: string,
    deletedModelId: string,
  ): { modelName: string; propertyName: string } | null {
    for (const meta of ModelRegistry.allModels()) {
      for (const [propName, propMeta] of meta.properties) {
        if (propMeta.type !== PropertyType.Reference) {
          continue;
        }
        if (propMeta.referenceTo !== deletedModelName) {
          continue;
        }
        if (propMeta.onDelete !== "restrict") {
          continue;
        }

        // Found a restrict relationship. Check if any instance references our target.
        for (const model of this.objectPool.getAll(meta.name)) {
          if (prop(model, propName) === deletedModelId) {
            return { modelName: meta.name, propertyName: propName };
          }
        }
      }
    }
    return null;
  }

  /**
   * Client-side cascade: find and delete/nullify models that reference the
   * one being deleted. Mirrors SyncConnection.cascadeDelete but creates
   * actual transactions (so undo works).
   */
  private cascadeDeleteClient(
    deletedModelName: string,
    deletedModelId: string,
  ) {
    for (const meta of ModelRegistry.allModels()) {
      for (const [propName, propMeta] of meta.properties) {
        // BackReference: "owned by" the deleted model → delete them
        if (
          propMeta.type === PropertyType.BackReference &&
          propMeta.referenceTo === deletedModelName
        ) {
          const inverseKey = propMeta.inverseOf!;
          for (const model of this.objectPool.getAll(meta.name)) {
            if (prop(model, inverseKey) === deletedModelId) {
              this.transactionQueue.enqueueDelete(model);
            }
          }
        }

        // Reference with onDelete: "cascade" → delete dependents
        if (
          propMeta.type === PropertyType.Reference &&
          propMeta.referenceTo === deletedModelName &&
          propMeta.onDelete === "cascade"
        ) {
          for (const model of this.objectPool.getAll(meta.name)) {
            if (prop(model, propName) === deletedModelId) {
              this.transactionQueue.enqueueDelete(model);
            }
          }
        }

        // Reference with onDelete: "nullify" → set reference to null
        if (
          propMeta.type === PropertyType.Reference &&
          propMeta.referenceTo === deletedModelName &&
          propMeta.onDelete === "nullify"
        ) {
          for (const model of this.objectPool.getAll(meta.name)) {
            if (prop(model, propName) === deletedModelId) {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              (model as any)[propName] = null;
              model.save();
            }
          }
        }
      }
    }
  }

  /** Same cascade logic for archive. */
  private cascadeArchiveClient(
    archivedModelName: string,
    archivedModelId: string,
  ) {
    // Archive cascade is similar but uses onArchive metadata
    for (const meta of ModelRegistry.allModels()) {
      for (const [_propName, propMeta] of meta.properties) {
        if (
          propMeta.type === PropertyType.BackReference &&
          propMeta.referenceTo === archivedModelName
        ) {
          const inverseKey = propMeta.inverseOf!;
          for (const model of this.objectPool.getAll(meta.name)) {
            if (prop(model, inverseKey) === archivedModelId) {
              this.transactionQueue.enqueueArchive(model);
            }
          }
        }
      }
    }
  }

  // ── Sync group scoped loading ─────────────────────────────────────────────

  /**
   * Called by SyncConnection when new sync groups are added.
   * Fetches all models scoped to those groups from the server,
   * writes to IDB, and hydrates instant-load ones into the pool.
   *
   * Example: user joins team "t-design" → fetch all Issues, Comments,
   * etc. that belong to that team.
   */
  private async handleSyncGroupsAdded(addedGroups: string[]): Promise<void> {
    if (addedGroups.length === 0) {
      return;
    }
    const dbMeta = this.database.currentMeta;
    if (dbMeta == null) {
      return;
    }
    // Schema-mismatch return is intentionally ignored: fetchSyncGroupModels
    // already triggered a full re-bootstrap internally, which clears the pool
    // and reloads from scratch. Nothing more for the SSE-driven path to do.
    await this.fetchSyncGroupModels(addedGroups, dbMeta);
  }

  /**
   * Called by SyncConnection when a delta packet's `removedSyncGroups` lists
   * groups the client no longer has access to. SyncConnection has already
   * updated `dbMeta.subscribedSyncGroups`.
   */
  private async handleSyncGroupsRemoved(
    removedGroups: string[],
  ): Promise<void> {
    await this.fireOnSyncGroupDelete(removedGroups);
  }

  /**
   * Fire `onSyncGroupDelete` once per group, serially. Errors thrown by the
   * adopter's callback are caught and routed to `onError` so one bad group
   * doesn't abort cleanup for the rest.
   */
  private async fireOnSyncGroupDelete(
    groupIds: string[] | Iterable<string>,
  ): Promise<void> {
    const cb = this.config.onSyncGroupDelete;
    if (cb == null) {
      return;
    }
    for (const g of groupIds) {
      try {
        await cb(g, this);
      } catch (err) {
        this.emitError(err, { kind: "onSyncGroupDelete", groupId: g });
      }
    }
  }

  /**
   * Scoped bootstrap-fetcher call: same fetcher used by full/partial bootstrap,
   * scoped to a subset of groups via `syncGroups`. Also narrows `onlyModels` so
   * on-demand-loaded models aren't shipped when an `onDemandFetcher` is wired.
   *
   * Returns `schemaMismatch: true` if the server reports a schema version that
   * doesn't match what's stored — in that case a full re-bootstrap has already
   * been triggered and the caller should bail.
   */
  private async fetchSyncGroupModels(
    groups: string[],
    dbMeta: DatabaseMeta,
  ): Promise<{ schemaMismatch: boolean }> {
    const isOnDemand = this.config.onDemandFetcher != null;
    let res: BootstrapResponse;
    try {
      res = await this.config.bootstrapFetcher(BootstrapType.Full, {
        syncGroups: groups,
        onlyModels: isOnDemand
          ? ModelRegistry.allModels()
              .filter((m) => !this.isSkippedAtBootstrap(m))
              .map((m) => m.name)
          : undefined,
        currentMeta: dbMeta,
      });
    } catch (err) {
      this.emitError(err, { kind: "syncGroupFetch", groups });
      throw err;
    }

    if (
      res.backendDatabaseVersion !== undefined &&
      dbMeta.backendDatabaseVersion !== undefined &&
      res.backendDatabaseVersion !== dbMeta.backendDatabaseVersion
    ) {
      this.objectPool.clear();
      await this.fullBootstrap();
      return { schemaMismatch: true };
    }

    await Promise.all(
      Object.entries(res.models).map(async ([modelName, records]) => {
        await this.database.writeModels(modelName, records);
        this.hydrateInstantModels(modelName, records);
      }),
    );
    await this.applyDeletedIds(res);

    // Don't touch dbMeta.lastSyncId. It's a *global* checkpoint — the highest
    // syncId for which we've applied every event across every subscribed group.
    // res.lastSyncId only describes the scoped groups, so if it's ahead of the
    // current checkpoint, the gap [current, res.lastSyncId] may contain events
    // for OTHER subscribed groups that we haven't received. Advancing the
    // checkpoint would cause the next SSE reconnect (`?since=<lastSyncId>`) to
    // skip those events — silent data loss. Leave it alone; SSE will replay
    // anything the scoped fetcher delivered and writes are overwrite-by-id.

    return { schemaMismatch: false };
  }

  /**
   * Write records for Instant models into the pool. Updates existing instances
   * in-place; creates new ones via hydrateAndPut for models not yet in memory.
   */
  private hydrateInstantModels(
    modelName: string,
    records: Record<string, unknown>[],
  ): void {
    const meta = ModelRegistry.getModelMeta(modelName);
    if (meta?.loadStrategy !== LoadStrategy.Instant) {
      return;
    }
    for (const record of records) {
      const existing = this.objectPool.getById(modelName, record.id as string);
      if (existing != null) {
        for (const [k, v] of Object.entries(record)) {
          if (k !== "id") {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (existing as any)[k] = v;
          }
        }
      } else {
        this.objectPool.hydrateAndPut(modelName, meta, record);
      }
    }
  }

  // ── Sync group lifecycle (user-initiated) ────────────────────────────────

  /**
   * Activate a sync group: subscribe to SSE deltas for the group and
   * optionally fetch its models from the server.
   *
   * By default (fetch: true) models are fetched, written to IDB, and hydrated
   * into the pool before reconnecting. Pass `{ fetch: false }` to subscribe
   * without fetching — useful when you want SSE deltas to start flowing but
   * will load models lazily later.
   *
   * Pass `{ ephemeral: true }` for session-scoped groups that should not
   * survive page reloads. The group subscription is kept in memory only —
   * models are still written to IDB as usual, but the group itself is not
   * saved to meta.
   *
   * Idempotent — does nothing if the group is already active.
   *
   * Uses the same `bootstrapFetcher` as initial bootstrap, scoped via the
   * `syncGroups` option. The server should return only records belonging to
   * those groups.
   */
  async activateSyncGroup(
    groupId: string | string[],
    {
      fetch = true,
      ephemeral = false,
    }: { fetch?: boolean; ephemeral?: boolean } = {},
  ): Promise<void> {
    const dbMeta = this.database.currentMeta;
    if (dbMeta == null) {
      return;
    }

    const ids = Array.isArray(groupId) ? groupId : [groupId];
    const newIds = ids.filter(
      (id) => !dbMeta.subscribedSyncGroups.includes(id),
    );
    if (newIds.length === 0) {
      return;
    }

    if (fetch) {
      const { schemaMismatch } = await this.fetchSyncGroupModels(
        newIds,
        dbMeta,
      );
      if (schemaMismatch) {
        return;
      }
    }

    const groups = new Set(dbMeta.subscribedSyncGroups);
    newIds.forEach((id) => groups.add(id));
    dbMeta.subscribedSyncGroups = [...groups];
    if (!ephemeral) {
      await this.database.saveMeta(dbMeta);
    }
    this.syncConnection?.reconnect();
  }

  /**
   * Deactivate a sync group: drop it from the subscribed list, fire
   * `onSyncGroupDelete` (if configured) so the app can evict pool/IDB records,
   * and reconnect SSE so the server stops streaming deltas for it.
   *
   * If `onSyncGroupDelete` isn't configured the group's records remain in the
   * pool/IDB. Use `sm.evictByIndex` / `sm.evictWhere` inside the callback, or
   * walk `ModelRegistry.allModels()` for a generic sweeper.
   *
   * Idempotent — does nothing if the group is not currently active.
   */
  async deactivateSyncGroup(groupId: string | string[]): Promise<void> {
    const dbMeta = this.database.currentMeta;
    if (dbMeta == null) {
      return;
    }

    const ids = Array.isArray(groupId) ? groupId : [groupId];
    const toRemove = new Set(
      ids.filter((id) => dbMeta.subscribedSyncGroups.includes(id)),
    );
    if (toRemove.size === 0) {
      return;
    }

    dbMeta.subscribedSyncGroups = dbMeta.subscribedSyncGroups.filter(
      (g) => !toRemove.has(g),
    );
    await this.database.saveMeta(dbMeta);
    await this.fireOnSyncGroupDelete(toRemove);
    this.syncConnection?.reconnect();
  }

  // ── Batch API ─────────────────────────────────────────────────────────────

  /** Run a function inside a batch. All save() calls share a batchId.
   * Accepts both sync and async functions — endBatch is always called
   * after the function (or its returned Promise) completes.
   */
  batch(fn: () => void): string;
  batch(fn: () => Promise<void>): Promise<string>;
  batch(fn: () => void | Promise<void>): string | Promise<string> {
    const id = this.transactionQueue.beginBatch();
    let result: void | Promise<void>;
    try {
      result = fn();
    } catch (err) {
      this.transactionQueue.endBatch(id);
      throw err;
    }
    if (result instanceof Promise) {
      return result
        .finally(() => this.transactionQueue.endBatch(id))
        .then(() => id);
    }
    this.transactionQueue.endBatch(id);
    return id;
  }

  beginBatch() {
    return this.transactionQueue.beginBatch();
  }
  endBatch(id: string) {
    this.transactionQueue.endBatch(id);
  }

  // ── Undo / Redo ───────────────────────────────────────────────────────────

  undo() {
    return this.transactionQueue.undo();
  }
  redo() {
    return this.transactionQueue.redo();
  }

  // ── Lazy loading ──────────────────────────────────────────────────────────

  private static collectionKey(
    modelName: string,
    indexKey: string,
    value: string,
  ): string {
    return `${modelName}:${indexKey}:${value}`;
  }

  private static parseCollectionKey(
    key: string,
    modelName: string,
  ): { indexKey: string; value: string } | null {
    const prefix = `${modelName}:`;
    if (!key.startsWith(prefix)) {
      return null;
    }
    const rest = key.slice(prefix.length);
    const separatorIdx = rest.indexOf(":");
    if (separatorIdx === -1) {
      return null;
    }
    return {
      indexKey: rest.slice(0, separatorIdx),
      value: rest.slice(separatorIdx + 1),
    };
  }

  private static modelIdKey(modelName: string, id: string): string {
    return `${modelName}:${id}`;
  }

  /** Load all instances where indexKey === value (e.g. all Issues for a team). */
  async loadCollection<T extends BaseModel = BaseModel>(
    modelName: string,
    indexKey: string,
    value: string,
  ): Promise<T[]> {
    const inMemory = this.objectPool
      .getAll(modelName)
      .filter((m) => prop(m, indexKey) === value);
    const inMemoryIds = new Set(inMemory.map((m) => m.id));

    const key = StoreManager.collectionKey(modelName, indexKey, value);
    const meta = ModelRegistry.getModelMeta(modelName);

    const isEphemeral = meta?.loadStrategy === LoadStrategy.Ephemeral;
    const results = [...inMemory] as T[];

    if (
      meta?.loadStrategy !== LoadStrategy.Instant &&
      this.config.onDemandFetcher != null &&
      !this.loadedCollections.has(key)
    ) {
      // The server fetch intentionally happens before the IDB read.
      //
      // IDB may already contain some records for this collection — written by
      // prior SSE delta packets — but those are a partial view. There is no way
      // to tell from IDB alone whether the set is complete. The server is the
      // only authoritative source for "all records where indexKey = value".
      //
      // By fetching first and writing the results into IDB, the subsequent IDB
      // read below acts as a merge: it picks up both the freshly fetched records
      // and anything SSE had already written. loadedCollections is then marked,
      // so future calls skip the server entirely and trust IDB as complete.
      //
      // Contrast with loadOne: a single ID lookup is binary — either the record
      // is in IDB or it isn't — so the server is only consulted as a last resort.
      const serverRecords = await this.config.onDemandFetcher(
        modelName,
        indexKey,
        value,
      );
      if (serverRecords.length > 0) {
        if (isEphemeral) {
          // Ephemeral models skip IDB — hydrate directly into the pool
          for (const record of serverRecords) {
            if (!inMemoryIds.has(record.id as string)) {
              results.push(
                this.objectPool.hydrateAndPut(modelName, meta!, record) as T,
              );
              inMemoryIds.add(record.id as string);
            }
          }
        } else {
          await this.database.writeModels(modelName, serverRecords);
        }
      }
      // Mark loaded before the IDB read so SSE inserts arriving during
      // that read are hydrated directly rather than waiting for next access.
      this.loadedCollections.add(key);
    }

    if (!isEphemeral) {
      const idbRecords = await this.database.readModelsByIndex(
        modelName,
        indexKey,
        value,
      );

      if (meta != null) {
        for (const record of idbRecords) {
          if (!inMemoryIds.has(record.id as string)) {
            results.push(
              this.objectPool.hydrateAndPut(modelName, meta, record) as T,
            );
          }
        }
      }
    }

    await this.markPartialIndexLoaded(modelName, indexKey, value);
    return results;
  }

  isCollectionLoaded(
    modelName: string,
    indexKey: string,
    value: string,
  ): boolean {
    return this.loadedCollections.has(
      StoreManager.collectionKey(modelName, indexKey, value),
    );
  }

  /** Mark a `(modelName, indexKey, value)` query as fully covered locally —
   * both in the in-memory cache and the storage adapter's persistent store. */
  private async markPartialIndexLoaded(
    modelName: string,
    indexKey: string,
    value: string,
  ): Promise<void> {
    this.loadedCollections.add(
      StoreManager.collectionKey(modelName, indexKey, value),
    );
    await this.database.recordPartialIndex(modelName, indexKey, value);
  }

  // ── Eviction helpers ──────────────────────────────────────────────────────

  /** Walk the pool for `modelName`, removing instances matching `predicate`. */
  private evictFromPool(
    modelName: string,
    predicate: (m: Record<string, unknown>) => boolean,
  ): number {
    let count = 0;
    for (const m of this.objectPool.getAll(modelName)) {
      if (predicate(m as unknown as Record<string, unknown>)) {
        this.objectPool.remove(modelName, m.id);
        this.loadedIds.delete(StoreManager.modelIdKey(modelName, m.id));
        count++;
      }
    }
    return count;
  }

  /**
   * Remove every record of `modelName` matching `predicate` from pool and IDB.
   * Predicate receives hydrated instances (pool) and raw records (IDB); write
   * predicates that test plain property values so they work on both shapes.
   * IDB side is a full cursor scan — prefer `evictByIndex` when the match is
   * "indexed column equals value".
   */
  async evictWhere(
    modelName: string,
    predicate: (m: Record<string, unknown>) => boolean,
  ): Promise<number> {
    const poolCount = this.evictFromPool(modelName, predicate);
    const records = await this.database.readAllModels(modelName);
    const ids = records.filter(predicate).map((r) => r.id as string);
    if (ids.length > 0) {
      await this.database.deleteModels(modelName, ids);
    }
    return poolCount + ids.length;
  }

  /**
   * Remove every record where `record[indexKey] === value`, using the IDB
   * index for the database side. Pool side is still a linear scan (no
   * secondary in-memory index by field value). Also clears the matching
   * `loadedCollections` cache key so a future `loadCollection(modelName,
   * indexKey, value)` re-fetches from the server instead of trusting IDB.
   */
  async evictByIndex(
    modelName: string,
    indexKey: string,
    value: string,
  ): Promise<void> {
    this.evictFromPool(modelName, (m) => m[indexKey] === value);
    await this.database.deleteModelsByIndex(modelName, indexKey, value);
    this.loadedCollections.delete(
      StoreManager.collectionKey(modelName, indexKey, value),
    );
    await this.database.clearPartialIndex(modelName, indexKey, value);
  }

  /**
   * Cascade `evictByIndex` across every model type that owns this FK. Use
   * when an "owner" id (workspaceId, teamId, userId, …) goes away and the
   * client should drop every related row in one call. Models that don't
   * declare `indexKey` as `indexed: true` are skipped — `deleteModelsByIndex`
   * falls back to a full-store cursor scan when the index is missing, and
   * walking every store at every call is rarely what the caller wants.
   */
  async evictAllByIndex(indexKey: string, value: string): Promise<void> {
    const models = ModelRegistry.allModels().filter(
      (meta) => meta.properties.get(indexKey)?.indexed === true,
    );
    await Promise.all(
      models.map((meta) => this.evictByIndex(meta.name, indexKey, value)),
    );
  }

  /** Load multiple models by ID (for OwnedCollection resolution). */
  async loadByIds(modelName: string, ids: string[]): Promise<BaseModel[]> {
    if (ids.length === 0) {
      return [];
    }

    const meta = ModelRegistry.getModelMeta(modelName);
    if (meta == null) {
      return [];
    }

    const missingFromPool = ids.filter(
      (id) => this.objectPool.getById(modelName, id) == null,
    );

    const isEphemeral = meta.loadStrategy === LoadStrategy.Ephemeral;

    if (missingFromPool.length > 0) {
      let stillMissing = missingFromPool;

      if (!isEphemeral) {
        const idbResults = await Promise.all(
          missingFromPool.map((id) => this.database.readModel(modelName, id)),
        );

        stillMissing = [];
        for (let i = 0; i < missingFromPool.length; i++) {
          const record = idbResults[i];
          if (record != null) {
            this.objectPool.hydrateAndPut(modelName, meta, record);
          } else {
            stillMissing.push(missingFromPool[i]);
          }
        }
      }

      if (stillMissing.length > 0) {
        const unloaded = stillMissing.filter(
          (id) => !this.loadedIds.has(StoreManager.modelIdKey(modelName, id)),
        );
        if (unloaded.length > 0) {
          if (this.config.onDemandBatchFetcher != null) {
            const serverRecords = await this.config.onDemandBatchFetcher(
              modelName,
              unloaded,
            );
            if (serverRecords.length > 0) {
              if (!isEphemeral) {
                await this.database.writeModels(modelName, serverRecords);
              }
              for (const record of serverRecords) {
                this.objectPool.hydrateAndPut(modelName, meta, record);
              }
            }
            for (const id of unloaded) {
              this.loadedIds.add(StoreManager.modelIdKey(modelName, id));
            }
          } else {
            await Promise.all(
              unloaded.map((id) => this.loadOne(modelName, id)),
            );
          }
        }
      }
    }

    return ids
      .map((id) => this.objectPool.getById(modelName, id))
      .filter((m): m is BaseModel => m != null);
  }

  /** Load a single model by ID (for partial/lazy models not yet in memory). */
  async loadOne<T extends BaseModel = BaseModel>(
    modelName: string,
    id: string,
  ): Promise<T | null> {
    const existing = this.objectPool.getById(modelName, id);
    if (existing != null) {
      return existing as T;
    }

    const meta = ModelRegistry.getModelMeta(modelName);
    const isEphemeral = meta?.loadStrategy === LoadStrategy.Ephemeral;

    // Check IDB before hitting the server — server is last resort.
    let record = isEphemeral
      ? null
      : await this.database.readModel(modelName, id);

    const idKey = StoreManager.modelIdKey(modelName, id);
    if (
      record == null &&
      this.config.onDemandFetcher != null &&
      !this.loadedIds.has(idKey)
    ) {
      const serverRecords = await this.config.onDemandFetcher(
        modelName,
        "id",
        id,
      );
      if (serverRecords.length > 0) {
        if (isEphemeral) {
          record = serverRecords.find((r) => r.id === id) ?? null;
        } else {
          await this.database.writeModels(modelName, serverRecords);
          record = await this.database.readModel(modelName, id);
        }
      }
      this.loadedIds.add(idKey);
    }

    if (record == null) {
      return null;
    }
    if (meta == null) {
      return null;
    }

    return this.objectPool.hydrateAndPut(modelName, meta, record) as T;
  }

  // ── Refresh ──────────────────────────────────────────────────────────────

  /**
   * Re-fetch a collection from the server, replacing stale pool data.
   * Existing instances are updated in-place so references held by
   * components/hooks remain valid. Models the server no longer returns
   * are removed from the pool.
   */
  async refreshCollection<T extends BaseModel = BaseModel>(
    modelName: string,
    indexKey: string,
    value: string,
  ): Promise<T[]> {
    const meta = ModelRegistry.getModelMeta(modelName);
    if (meta == null || this.config.onDemandFetcher == null) {
      return [];
    }

    const isEphemeral = meta.loadStrategy === LoadStrategy.Ephemeral;

    const previousIds = new Set(
      this.objectPool
        .getAll(modelName)
        .filter((m) => prop(m, indexKey) === value)
        .map((m) => m.id),
    );

    const serverRecords = await this.config.onDemandFetcher(
      modelName,
      indexKey,
      value,
    );

    if (!isEphemeral) {
      await this.database.deleteModelsByIndex(modelName, indexKey, value);
      if (serverRecords.length > 0) {
        await this.database.writeModels(modelName, serverRecords);
      }
    }

    const results: T[] = [];
    for (const record of serverRecords) {
      results.push(this.objectPool.hydrateAndPut(modelName, meta, record) as T);
    }

    const freshIds = new Set(serverRecords.map((r) => r.id as string));
    for (const id of previousIds) {
      if (!freshIds.has(id)) {
        this.objectPool.remove(modelName, id);
      }
    }

    await this.markPartialIndexLoaded(modelName, indexKey, value);
    return results;
  }

  /**
   * Re-fetch specific models by ID from the server.
   * Existing instances are updated in-place so references remain valid.
   */
  async refreshModels(modelName: string, ids: string[]): Promise<BaseModel[]> {
    if (ids.length === 0) {
      return [];
    }

    const meta = ModelRegistry.getModelMeta(modelName);
    if (meta == null) {
      return [];
    }

    const isEphemeral = meta.loadStrategy === LoadStrategy.Ephemeral;
    let serverRecords: Record<string, unknown>[] = [];

    if (this.config.onDemandBatchFetcher != null) {
      serverRecords = await this.config.onDemandBatchFetcher(modelName, ids);
    } else if (this.config.onDemandFetcher != null) {
      const fetched = await Promise.all(
        ids.map((id) => this.config.onDemandFetcher!(modelName, "id", id)),
      );
      serverRecords = fetched.flat();
    }

    if (!isEphemeral) {
      await this.database.deleteModels(modelName, ids);
      if (serverRecords.length > 0) {
        await this.database.writeModels(modelName, serverRecords);
      }
    }

    for (const record of serverRecords) {
      this.objectPool.hydrateAndPut(modelName, meta, record);
    }

    const returnedIds = new Set(serverRecords.map((r) => r.id as string));
    for (const id of ids) {
      if (!returnedIds.has(id)) {
        this.objectPool.remove(modelName, id);
      }
      this.loadedIds.add(StoreManager.modelIdKey(modelName, id));
    }

    return ids
      .map((id) => this.objectPool.getById(modelName, id))
      .filter((m): m is BaseModel => m != null);
  }

  /**
   * Re-fetch all previously loaded collections and models for a given model type.
   * Existing instances are updated in-place so references remain valid.
   * Models the server no longer returns are removed from the pool.
   */
  async refreshAllOfModel(modelName: string): Promise<void> {
    const prefix = `${modelName}:`;

    const collectionKeys: { indexKey: string; value: string }[] = [];
    for (const key of [...this.loadedCollections]) {
      const parsed = StoreManager.parseCollectionKey(key, modelName);
      if (parsed != null) {
        collectionKeys.push(parsed);
      }
    }

    const modelIds: string[] = [];
    for (const key of [...this.loadedIds]) {
      if (key.startsWith(prefix)) {
        modelIds.push(key.slice(prefix.length));
      }
    }

    const collectionResults = await Promise.all(
      collectionKeys.map(({ indexKey, value }) =>
        this.refreshCollection(modelName, indexKey, value),
      ),
    );

    // Only re-fetch IDs not already covered by a collection refresh
    const refreshedIds = new Set(collectionResults.flat().map((m) => m.id));
    const uncoveredIds = modelIds.filter((id) => !refreshedIds.has(id));
    if (uncoveredIds.length > 0) {
      await this.refreshModels(modelName, uncoveredIds);
    }
  }

  // ── Status ────────────────────────────────────────────────────────────────

  status() {
    return {
      phase: this._phase,
      error: this._error?.message,
      workspaceId: this.config.workspaceId,
      objectPoolSize: this.objectPool.size,
      objectPoolCounts: this.objectPool.counts(),
      pending: this.transactionQueue.pendingCount,
      undoDepth: this.transactionQueue.undoDepth,
      redoDepth: this.transactionQueue.redoDepth,
      syncConnected: this.syncConnection?.isConnected ?? false,
      lastSyncId: this.database.currentMeta?.lastSyncId ?? 0,
    };
  }

  async teardown() {
    this.stopped = true;
    BaseModel.storeManager = null;
    this.syncConnection?.disconnect();
    this.syncConnection = null;
    for (const stream of this.modelStreams) {
      stream.disconnect();
    }
    this.modelStreams = [];
    this.transactionQueue.destroy();
    await this.database.close();
    this.objectPool.clear();
    this.stores.clear();
    this.loadedCollections.clear();
    this.loadedIds.clear();
    this.setPhase(BootstrapPhase.Idle);
  }
}
