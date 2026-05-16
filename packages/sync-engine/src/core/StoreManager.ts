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
 *   storeManager.getOrLoadCollection("Issue", "teamId", teamId)
 *   storeManager.getOrLoadById("DocumentContent", docId)
 */

import { ModelRegistry } from "./ModelRegistry";
import { DEFAULT_TRANSIENT_INDEX_DEPTH } from "./types";
import { ObjectPool, prop, readFk } from "./ObjectPool";
import {
  Database,
  BootstrapType,
  type StorageAdapter,
  type DatabaseMeta,
  type PartialIndexEntry,
} from "./Database";
import {
  FullStore,
  PartialStore,
  EphemeralStore,
  type ModelStore,
} from "./Store";
import {
  TransactionQueue,
  type TransactionSender,
  type UndoableActionHandlers,
} from "./TransactionQueue";
import type { UndoableAction } from "./Transaction";
import {
  SyncConnection,
  encodeCsvList,
  type DeltaPacket,
  type SSEClientFactory,
  type SyncMessageTransform,
  createBrowserSSEFactory,
} from "./SyncConnection";
import { ModelStream, type ModelStreamMessageTransform } from "./ModelStream";
import { BatchModelLoader, type IndexBatchFetcher } from "./BatchModelLoader";
import {
  COMPOUND_FETCH_THRESHOLD,
  wrapCompoundFetcher,
} from "./CompoundIndexFetcher";
import { BaseModel } from "./BaseModel";
import {
  BootstrapPhase,
  LoadStrategy,
  PropertyType,
  toError,
  type ModelMeta,
  type PropertyMeta,
  type PropertyChange,
  type FieldTransform,
  type EngineErrorContext,
  type EngineErrorHandler,
  type CommitIntent,
  type CommitRouteHandler,
  type CommitRouteResult,
  type OnModelTouchedHandler,
} from "./types";

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

export type OnDemandFetcher = (
  modelName: string,
  indexKey: string,
  value: string,
) => Promise<Record<string, unknown>[]>;

export type OnDemandBatchFetcher = (
  modelName: string,
  ids: string[],
) => Promise<Record<string, unknown>[]>;

/**
 * On-demand (progressive) loading strategy for `Partial` / `Lazy` models.
 * A discriminated union so an index-batch backend can't be half-configured
 * — the old flat shape let `serverSupportsCompoundIndexKeys` be set without
 * an `onDemandIndexBatchFetcher`, which silently did nothing.
 *
 * - `perKey`: `fetch(modelName, indexKey, value)` is called the first time a
 *   collection/index is accessed; `batchFetch` coalesces missing id lookups
 *   for `getByIds`. Supply either or both (they drive different reads —
 *   `getByIndex` vs `getByIds`). Results are written to IDB + hydrated.
 * - `indexBatch`: concurrent `getByIndex` calls (incl. `coveringIndexes`
 *   fan-out) coalesce into one `fetch` per microtask. `compound` opts in to
 *   dotted server-side-join index keys; `threshold` overrides
 *   {@link COMPOUND_FETCH_THRESHOLD}.
 */
export type OnDemandConfig =
  | { mode: "perKey"; fetch?: OnDemandFetcher; batchFetch?: OnDemandBatchFetcher }
  | {
      mode: "indexBatch";
      fetch: IndexBatchFetcher;
      compound?: { threshold?: number };
    };

export interface TransportConfig {
  bootstrapFetcher: BootstrapFetcher;
  transactionSender?: TransactionSender;
  syncUrl?: string;
  /**
   * Optional async hook that returns the user's sync-group memberships
   * before any bootstrap fetch runs. The returned groups are append-only
   * unioned with `dbMeta.subscribedSyncGroups` (so a stale persisted set
   * never shrinks the live one) and persisted, so every downstream
   * `bootstrapFetcher` call can pass `syncGroups` from one canonical source
   * rather than relying on the server inferring scope from auth/session.
   * Fires after the storage adapter connects but before the bootstrap type
   * is determined, so seeded groups can influence Full vs Partial. Failure
   * is fatal. Return `[]` (or omit) if the server owns scope.
   */
  bootstrapSyncGroups?: () => Promise<string[]>;
  /** Secondary model update streams (e.g. a calculation service). */
  modelStreams?: ModelStreamConfig[];
  /**
   * Custom SSE client factory. Defaults to the browser's `EventSource`.
   * Override to run outside the browser (Node/agent):
   * `sseClientFactory: (url) => new EventSource(url)`. When set, `sseInit`
   * is ignored — your factory owns any options.
   */
  sseClientFactory?: SSEClientFactory;
  /**
   * Init options forwarded to the default browser EventSource (e.g.
   * `{ withCredentials: true }`). Applies to the main stream and every
   * `modelStreams` entry. Ignored when `sseClientFactory` is set.
   */
  sseInit?: EventSourceInit;
  /**
   * Use when the backend sends a different envelope than the canonical
   * `DeltaPacket`. Return null to drop a message.
   */
  syncTransform?: SyncMessageTransform;
}

export interface LoadingConfig {
  /**
   * How deep `RefCollection`s walk the parent's outgoing FK chain when
   * auto-deriving covering axes. Defaults to 3 (matching Linear). 1 = only
   * the parent's direct FKs; 0 = disable auto-derivation (manual
   * `coveringIndexes` still applies). Higher values exponentially increase
   * the registry-walk surface for diminishing returns.
   */
  transientIndexDepth?: number;
  /**
   * Two-phase full bootstrap. If provided, the first fetch loads only the
   * critical models (everything NOT in this list); once interactive, a
   * background fetch loads these. If omitted, all models load in one
   * request.
   */
  deferredModels?: string[];
  /**
   * Progressive / on-demand loading for `Partial` / `Lazy` models — they're
   * excluded from bootstrap and fetched on first access, written to IDB,
   * and hydrated. See {@link OnDemandConfig}.
   */
  onDemand?: OnDemandConfig;
}

export interface PersistenceConfig {
  /**
   * Custom storage backend. Defaults to IndexedDB (`Database`). Override
   * for environments without IndexedDB (`new MemoryAdapter()`), or
   * implement `StorageAdapter` for SQLite/Redis/etc. If omitted, `Database`
   * falls back to in-memory when IndexedDB is unavailable (no persistence
   * across restarts, no crash).
   */
  storageAdapter?: StorageAdapter;
  /**
   * Maximum undo entries kept in memory. Defaults to 100. Lower it for
   * long-running agents that make many writes and don't need deep history
   * (each entry holds model snapshots).
   */
  undoLimit?: number;
}

export interface HooksConfig<TContext = unknown> {
  onPhaseChange?: (phase: BootstrapPhase, detail?: string) => void;
  onDeltaPacket?: (packet: DeltaPacket) => void;
  onReady?: () => void;
  /**
   * Single hook for every async failure the engine catches internally
   * (eager loads, SSE parse errors, transaction retries, deferred fetches).
   * Receives the error and a tagged-union `EngineErrorContext`. Throwing
   * from it is swallowed. Without it, internal failures are silently
   * dropped.
   */
  onError?: EngineErrorHandler;
  /**
   * Called when a sync group is removed (`deactivateSyncGroup` or an SSE
   * `removedSyncGroups`). `dbMeta.subscribedSyncGroups` is already updated;
   * SSE reconnect waits for the returned promise. Use it to evict pool/IDB
   * records — `sm` exposes `evictByIndex` / `evictWhere`, `objectPool`,
   * `database`.
   */
  onSyncGroupDelete?: (
    groupId: string,
    sm: StoreManager<TContext>,
  ) => void | Promise<void>;
}

export interface AdvancedConfig<TContext = unknown> {
  /**
   * Mint the `id` for newly-constructed client-side models. Not invoked for
   * server/IDB-hydrated records. Receives the live context from
   * `setContext` (or `<SyncProvider context>`); `undefined` until set.
   * Defaults to `crypto.randomUUID()`.
   */
  identifierFn?: (meta: ModelMeta, context: TContext | undefined) => string;
  /**
   * Stamp a field transform onto each `(model, property)` at engine init
   * (walked once). The transform fires inside the property setter before
   * the MobX box, receiving the value, instance, and live context — use it
   * to canonicalize cross-cutting input (tenant-prefix FKs, normalize
   * strings) without per-field decorators. Per-StoreManager storage.
   */
  applyFieldTransforms?: (
    meta: ModelMeta,
    prop: PropertyMeta,
  ) => FieldTransform<TContext> | undefined;
  /**
   * Route user-initiated commits before they hit the pool / queue. Fires
   * from `commitCreate` (before pool insert + enqueue) and `commitUpdate`
   * (before enqueue). `"skip"` suppresses; a redirect replays the intent
   * against a different model id (optionally restoring the original's
   * pre-edit boxes). Delta/SSE writes do NOT fire this. Pair with
   * `materializePoolOnly` / `clonePoolOnly` for pool-only redirect targets.
   */
  routeCommit?: CommitRouteHandler;
  /**
   * Fired the instant a clean model becomes dirty (first pending change
   * since last save/discard), synchronously inside the setter before any
   * `save()`. For eager side-effects that must not wait for a commit (e.g.
   * materializing a draft-layer scaffold). The write is still routed at
   * `save()` via `routeCommit`. Runs on the setter hot path — keep it fast.
   * NOT fired during redirect replay or delta/SSE hydrates.
   */
  onModelTouched?: OnModelTouchedHandler;
  /**
   * Hooks for undoing/redoing remote side-effects committed via non-model
   * APIs (bulk endpoints, server workflows). Tracked on the same undo stack
   * as model transactions; on undo the engine calls `undoableActions.undo`
   * with the recorded `UndoableAction`. Each handler returns the
   * compensating action (or `void` if symmetric). Wire
   * `StoreManager.runUndoable(fn)` at the call site. Failures route to
   * `onError` with `kind: "undoableAction"`.
   */
  undoableActions?: UndoableActionHandlers;
}

/**
 * Public engine config, grouped by concern. `transport` is required
 * (carries the required `bootstrapFetcher`); the rest are optional.
 */
export interface StoreManagerConfig<TContext = unknown> {
  workspaceId: string;
  transport: TransportConfig;
  loading?: LoadingConfig;
  persistence?: PersistenceConfig;
  hooks?: HooksConfig<TContext>;
  advanced?: AdvancedConfig<TContext>;
}

/**
 * @internal Flattened shape the engine reads internally. The public grouped
 * `StoreManagerConfig` is normalized into this exactly once (constructor),
 * so the rest of the engine collapses to one stable surface. Exported only
 * for the test factory.
 *
 * Derived structurally from the grouped sub-interfaces (minus `onDemand`,
 * which the discriminated union expands into the flat `onDemand*` fields
 * below) so the "flat = projection of grouped" invariant is compiler-
 * enforced — rename a field in one place and this follows automatically.
 */
export type NormalizedConfig<TContext = unknown> = Omit<
  TransportConfig &
    LoadingConfig &
    PersistenceConfig &
    HooksConfig<TContext> &
    AdvancedConfig<TContext>,
  "onDemand"
> & {
  workspaceId: string;
  onDemandFetcher?: OnDemandFetcher;
  onDemandBatchFetcher?: OnDemandBatchFetcher;
  onDemandIndexBatchFetcher?: IndexBatchFetcher;
  serverSupportsCompoundIndexKeys?: boolean;
  compoundIndexFetchThreshold?: number;
};

/** @internal Grouped public config → flat internal config. Single mapping
 * point; the discriminated `onDemand` union expands to the legacy flat
 * onDemand* fields here. */
export function normalizeConfig<TContext = unknown>(
  c: StoreManagerConfig<TContext>,
): NormalizedConfig<TContext> {
  const od = c.loading?.onDemand;
  return {
    workspaceId: c.workspaceId,
    bootstrapFetcher: c.transport.bootstrapFetcher,
    transactionSender: c.transport.transactionSender,
    syncUrl: c.transport.syncUrl,
    bootstrapSyncGroups: c.transport.bootstrapSyncGroups,
    modelStreams: c.transport.modelStreams,
    sseClientFactory: c.transport.sseClientFactory,
    sseInit: c.transport.sseInit,
    syncTransform: c.transport.syncTransform,
    storageAdapter: c.persistence?.storageAdapter,
    undoLimit: c.persistence?.undoLimit,
    transientIndexDepth: c.loading?.transientIndexDepth,
    deferredModels: c.loading?.deferredModels,
    onDemandFetcher: od?.mode === "perKey" ? od.fetch : undefined,
    onDemandBatchFetcher: od?.mode === "perKey" ? od.batchFetch : undefined,
    onDemandIndexBatchFetcher: od?.mode === "indexBatch" ? od.fetch : undefined,
    serverSupportsCompoundIndexKeys:
      od?.mode === "indexBatch" ? od.compound != null : undefined,
    compoundIndexFetchThreshold:
      od?.mode === "indexBatch" ? od.compound?.threshold : undefined,
    onPhaseChange: c.hooks?.onPhaseChange,
    onDeltaPacket: c.hooks?.onDeltaPacket,
    onReady: c.hooks?.onReady,
    onError: c.hooks?.onError,
    onSyncGroupDelete: c.hooks?.onSyncGroupDelete,
    identifierFn: c.advanced?.identifierFn,
    applyFieldTransforms: c.advanced?.applyFieldTransforms,
    routeCommit: c.advanced?.routeCommit,
    onModelTouched: c.advanced?.onModelTouched,
    undoableActions: c.advanced?.undoableActions,
  };
}

/**
 * Reserved `indexKey` segment used by `getOrLoadAll` to record whole-table
 * coverage in `partialIndexCoverage` alongside real field-keyed entries.
 * Real models must not declare a field named `"*"`.
 */
const ALL_INDEX_KEY_SENTINEL = "*";

export class StoreManager<TContext = unknown> {
  readonly objectPool: ObjectPool;
  readonly database: StorageAdapter;
  readonly transactionQueue: TransactionQueue;

  get transientIndexDepth(): number {
    return this.config.transientIndexDepth ?? DEFAULT_TRANSIENT_INDEX_DEPTH;
  }

  private stores = new Map<string, ModelStore>();
  private syncConnection: SyncConnection | null = null;
  private modelStreams: ModelStream[] = [];
  private config: NormalizedConfig<TContext>;
  private context: TContext | undefined = undefined;
  private fieldTransforms = new Map<string, FieldTransform<TContext>>();
  hasFieldTransforms = false;
  hasModelTouchedHandler = false;
  private _phase = BootstrapPhase.Idle;
  private _error: Error | null = null;
  private stopped = false;
  private loadedModelsUnsub: (() => void) | null = null;
  private syncReconnectTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Hot cache of collection coverage, keyed by `"modelName:indexKey:value"`.
   * Each value carries the structured tuple plus the `firstSyncId` (the
   * `lastSyncId` at the time of fetch). Mirrored to the storage adapter's
   * `__partialIndexes` store, so coverage survives reload.
   */
  private partialIndexCoverage = new Map<string, PartialIndexEntry>();
  private loadedIds = new Set<string>();
  /** Models whose IDB rows have been hydrated into the pool at least once
   * this session. `getOrLoadAll`'s cache-hit path skips a full IDB scan
   * when a model is in this set — pool stays current via SSE
   * (`shouldHydrateInsert` honors `*`-coverage, see `isModelFullyLoaded`),
   * so a fresh IDB read would just rediscover what pool already holds.
   * Cleared whenever `objectPool.clear()` is called. */
  private poolSyncedFromIDB = new Set<string>();
  /** Models that have at least one `*`-coverage entry in
   * `partialIndexCoverage` (any scope). Mirror of those entries — kept so
   * `isModelFullyLoaded` is O(1) on the SSE insert hot path. Updated
   * wherever `partialIndexCoverage` mutates a `"*"` row. */
  private fullyLoadedModels = new Set<string>();
  /** Models with an in-flight `getOrLoadAll` (or `fetchDeferredModels`)
   * fetch. Refcounted because two fetches with different scopes can overlap.
   * `isModelFullyLoaded` returns true while pending so `shouldHydrateInsert`
   * starts admitting SSE deltas immediately — otherwise inserts arriving
   * during the fetch window would land only in IDB and the snapshot's older
   * `hydrateAndPut` pass would overwrite the pool with stale data. */
  private pendingFullLoadRefcount = new Map<string, number>();
  /** Tombstone set populated by SSE `D`/`A` handlers while a model has a
   * pending full-load. The merge step at the end of `getOrLoadAll` /
   * `fetchDeferredModels` filters snapshot records through this set so a
   * delete that arrived after the server's snapshot doesn't get resurrected.
   * Cleared when the last in-flight fetch for the model completes. */
  private inflightDeletes = new Map<string, Set<string>>();
  /** Per-(model, scope) in-flight `getOrLoadAll` promises so concurrent calls
   * coalesce instead of double-fetching. Keyed by `coverageKey`. */
  private inflightFullLoads = new Map<string, Promise<BaseModel[]>>();
  /** Sync groups returned by `config.bootstrapSyncGroups`. Used as a
   * pre-Phase-1 source for `subscribedSyncGroupsForFetch` (when no prior
   * dbMeta exists, currentMeta is still null at fetch time) and unioned
   * into the meta written by `saveMeta` after Phase 1/Partial completes. */
  private seededSyncGroups: string[] = [];
  /** Wired only when `onDemandIndexBatchFetcher` is configured. */
  private indexBatchLoader: BatchModelLoader | null = null;

  /** Set of models touched inside the currently open `atomic()` scope.
   * `null` when no scope is active. Mutations register themselves via
   * `registerAtomicTouch` (called from `BaseModel.propertyChanged`). */
  private activeAtomicScope: Set<BaseModel> | null = null;
  /** True only while the engine replays a redirected commit onto its target.
   * Gates every user-intent hook (`routeCommit`, `onModelTouched`) so the
   * engine's own `assign()`/`save()` during replay isn't mistaken for a
   * fresh user edit. */
  private suppressUserIntentHooks = false;

  constructor(config: StoreManagerConfig<TContext>) {
    const c = normalizeConfig(config);
    this.config = c;
    this.objectPool = new ObjectPool();
    this.database = c.storageAdapter ?? new Database(c.workspaceId);
    this.transactionQueue = new TransactionQueue(
      this.database,
      this.objectPool,
      c.undoLimit,
    );
    if (c.transactionSender != null) {
      this.transactionQueue.setSender(c.transactionSender);
    }
    this.transactionQueue.setErrorReporter((err, ctx) =>
      this.emitError(err, ctx),
    );
    if (c.undoableActions != null) {
      this.transactionQueue.setActionHandlers(c.undoableActions);
    }
    if (c.onDemandIndexBatchFetcher != null) {
      const fetcher =
        c.serverSupportsCompoundIndexKeys === true
          ? wrapCompoundFetcher(
              c.onDemandIndexBatchFetcher,
              this.objectPool,
              {
                threshold:
                  c.compoundIndexFetchThreshold ?? COMPOUND_FETCH_THRESHOLD,
                onCompoundFetched: (compound, bag) =>
                  this.absorbCompoundResponse(compound, bag),
              },
            )
          : c.onDemandIndexBatchFetcher;
      this.indexBatchLoader = new BatchModelLoader(fetcher);
    }
    if (c.applyFieldTransforms != null) {
      const apply = c.applyFieldTransforms;
      for (const meta of ModelRegistry.allModels()) {
        for (const prop of meta.properties.values()) {
          const t = apply(meta, prop);
          if (t != null) {
            this.fieldTransforms.set(
              StoreManager.fieldTransformKey(meta.name, prop.name),
              t,
            );
          }
        }
      }
      this.hasFieldTransforms = this.fieldTransforms.size > 0;
    }
    this.hasModelTouchedHandler = c.onModelTouched != null;
    BaseModel.storeManager = this; // wire auto-commit
  }

  // ── Context (for identifierFn) ───────────────────────────────────────────

  /** Push the live context (e.g. user/tenant info) used by `identifierFn`.
   * Read at id-mint time, not captured — call this whenever the relevant
   * context changes. The React `<SyncProvider context={...}>` prop is a
   * thin wrapper over this. */
  setContext(ctx: TContext): void {
    this.context = ctx;
  }

  /** Apply any registered field transform for `(instance, propName)` against
   * `value`, returning the result (or `value` unchanged when no rule applies).
   * Setters short-circuit on `hasFieldTransforms` first — by the time this
   * runs we know at least one rule exists somewhere in the engine. */
  applyTransform(
    instance: BaseModel,
    propName: string,
    value: unknown,
  ): unknown {
    const modelName = (instance.constructor as { _modelName?: string })
      ._modelName;
    if (modelName == null) {
      return value;
    }
    const transform = this.fieldTransforms.get(
      StoreManager.fieldTransformKey(modelName, propName),
    );
    if (transform == null) {
      return value;
    }
    return transform(value, instance, this.context);
  }

  private static fieldTransformKey(
    modelName: string,
    propName: string,
  ): string {
    return `${modelName}:${propName}`;
  }

  /** Mint a fresh id, honoring `identifierFn` when configured. Folds the
   * registry lookup in so callers can skip it entirely on the no-config
   * path — `new Model()` is hot. */
  mintId(instance: BaseModel): string {
    const fn = this.config.identifierFn;
    if (fn == null) {
      return crypto.randomUUID();
    }
    const meta = ModelRegistry.getMetaForInstance(instance);
    return meta != null ? fn(meta, this.context) : crypto.randomUUID();
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
      // Kick off the sync-groups hook eagerly so its network RTT overlaps
      // with `database.connect()` + `loadPartialIndexes()` below. The
      // attached `.catch` only suppresses the unhandled-rejection event
      // for the early-stop path; the real `await` further down still
      // re-throws and propagates to the outer try/catch.
      const seededP = this.config.bootstrapSyncGroups?.();
      seededP?.catch(() => {});

      this.setPhase(BootstrapPhase.CreatingStores);
      for (const meta of ModelRegistry.allModels()) {
        let store: ModelStore;
        if (meta.loadStrategy === LoadStrategy.Ephemeral) {
          store = new EphemeralStore(meta, this.database, this.objectPool);
        } else if (meta.loadStrategy === LoadStrategy.Partial) {
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
          this.partialIndexCoverage.set(
            StoreManager.collectionKey(
              entry.modelName,
              entry.indexKey,
              entry.value,
            ),
            entry,
          );
          if (entry.indexKey === ALL_INDEX_KEY_SENTINEL) {
            this.fullyLoadedModels.add(entry.modelName);
          }
        }
      } catch (err) {
        this.emitError(err, { kind: "deferredBootstrap", modelNames: [] });
      }

      if (seededP != null) {
        await this.applySeededSyncGroups(await seededP);
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
        // Partial deltas can't fill newly-added models — fetch them in full.
        if (this.database.newlyAddedModels.length > 0) {
          await this.fetchNewlyAddedModels(this.database.newlyAddedModels);
        }
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
          {
            onPacket: this.config.onDeltaPacket,
            onSyncGroupsChanged: async (added, removed) => {
              await this.handleSyncGroupsAdded(added);
              await this.handleSyncGroupsRemoved(removed);
            },
            isCollectionLoaded: this.isCollectionLoaded.bind(this),
            sseClientFactory: sseFactory,
            transform: this.config.syncTransform,
            reportError: sseErrorReporter,
            isModelFullyLoaded: this.isModelFullyLoaded.bind(this),
            recordInflightDelete: this.recordInflightDelete.bind(this),
          },
        );
        this.syncConnection.connect();
        // Reconnect SSE when the loaded-models set changes — server uses
        // it as `onlyModels` for both catchup and live stream. Debounce so
        // a burst of writes (e.g. getOrLoadCollection batch) only reconnects once.
        this.loadedModelsUnsub = this.database.onLoadedModelsChange(() =>
          this.scheduleSyncReconnect(),
        );
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
   * Full bootstrap — two-phase fetch. Only Eager models are ever shipped;
   * Lazy / Partial / LocalOnly / Ephemeral load on demand
   * or via SSE.
   *
   * Phase 1: critical Eager models (everything NOT in deferredModels).
   *          Write to IDB, hydrate into ObjectPool. UI can render.
   *
   * Phase 2: deferred Eager models (Comment, Reaction, Attachment, etc.)
   *          in the background after the engine is marked ready.
   *
   * If deferredModels is not configured, every Eager model is fetched in
   * a single request.
   */
  private async fullBootstrap() {
    const deferred = new Set(this.config.deferredModels ?? []);
    const eagerModels = ModelRegistry.eagerModelNames();

    if (deferred.size > 0) {
      // Phase 1: critical Eager models only
      const criticalModels = eagerModels.filter(
        (name) => !deferred.has(name),
      );
      this.setPhase(
        BootstrapPhase.Fetching,
        `phase 1: ${criticalModels.length} critical models`,
      );
      const res = await this.config.bootstrapFetcher(BootstrapType.Full, {
        onlyModels: criticalModels,
        syncGroups: this.subscribedSyncGroupsForFetch(),
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
      await this.persistFullBootstrapMeta(res);

      // Phase 2: deferred models — runs AFTER bootstrap() returns and the
      // engine is marked ready. The UI is already interactive at this point.
      const deferredModels = eagerModels.filter((name) => deferred.has(name));
      if (deferredModels.length > 0) {
        this.fetchDeferredModels(deferredModels);
      }
    } else {
      // Single-phase: fetch every Eager model at once. Lazy / Partial /
      // LocalOnly / Ephemeral models are loaded on demand
      // (or never) and don't belong in a bootstrap payload.
      this.setPhase(BootstrapPhase.Fetching, "full");
      const res = await this.config.bootstrapFetcher(BootstrapType.Full, {
        onlyModels: eagerModels,
        syncGroups: this.subscribedSyncGroupsForFetch(),
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
      await this.persistFullBootstrapMeta(res);
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
   * Uses writeModelsIfAbsent + tombstone filter to merge with SSE — see
   * `agent-docs/04-lazy-loading.md` for the in-flight merge invariants.
   */
  private async fetchDeferredModels(modelNames: string[]) {
    for (const name of modelNames) {
      this.beginPendingFullLoad(name);
    }
    try {
      const res = await this.config.bootstrapFetcher(BootstrapType.Full, {
        onlyModels: modelNames,
        syncGroups: this.subscribedSyncGroupsForFetch(),
        currentMeta: this.database.currentMeta,
      });
      await Promise.all(
        Object.entries(res.models).map(async ([name, records]) => {
          const live = this.filterTombstoned(name, records);
          if (live.length > 0) {
            await this.database.writeModelsIfAbsent(name, live);
          }
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
    } finally {
      for (const name of modelNames) {
        this.endPendingFullLoad(name);
      }
    }
  }

  /** Fold the result of `bootstrapSyncGroups` into `dbMeta`. When prior
   * meta exists we persist immediately so `localBootstrap` (no `saveMeta`
   * of its own) and a subsequent reload see the seeded groups; `saveMeta`
   * is safe here because `lastSyncId` is preserved. With no prior meta,
   * stash on the instance — calling `saveMeta` with `lastSyncId: 0` would
   * coerce a fresh bootstrap into the `Local` path. Phase 1's `saveMeta`
   * will fold the stashed set in. */
  private async applySeededSyncGroups(seeded: string[]): Promise<void> {
    if (seeded.length === 0) {
      return;
    }
    const meta = this.database.currentMeta;
    if (meta == null) {
      this.seededSyncGroups = seeded;
      return;
    }
    meta.subscribedSyncGroups = StoreManager.mergeSubscribedGroups(
      meta.subscribedSyncGroups,
      seeded,
    );
    await this.database.saveMeta(meta);
  }

  /** Persist `dbMeta` after a Full bootstrap response, folding in any
   * `seededSyncGroups` left over from `bootstrapSyncGroups`. Shared by the
   * Phase-1 and single-phase branches of `fullBootstrap`. */
  private async persistFullBootstrapMeta(
    res: BootstrapResponse,
  ): Promise<void> {
    this.setPhase(BootstrapPhase.Hydrating, `${this.objectPool.size} models`);
    await this.database.saveMeta({
      lastSyncId: res.lastSyncId,
      subscribedSyncGroups: StoreManager.mergeSubscribedGroups(
        this.database.currentMeta?.subscribedSyncGroups,
        [...res.subscribedSyncGroups, ...this.seededSyncGroups],
      ),
      schemaHash: ModelRegistry.schemaHash,
      dbVersion: this.database.currentMeta?.dbVersion ?? 1,
      backendDatabaseVersion: res.backendDatabaseVersion ?? 0,
    });
    this.seededSyncGroups = [];
  }

  /** Append-only merge: bootstrap responses never shrink the subscription set. */
  private static mergeSubscribedGroups(
    existing: string[] | undefined,
    fromResponse: string[],
  ): string[] {
    return [...new Set([...(existing ?? []), ...fromResponse])];
  }

  /** Canonical scope for bootstrap-style fetches: persisted set, then the
   * pre-Phase-1 seeded fallback, else `undefined`. */
  private subscribedSyncGroupsForFetch(): string[] | undefined {
    const fromMeta = this.database.currentMeta?.subscribedSyncGroups;
    if (fromMeta != null && fromMeta.length > 0) {
      return fromMeta;
    }
    return this.seededSyncGroups.length > 0 ? this.seededSyncGroups : undefined;
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
            LoadStrategy.Eager,
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
      syncGroups: this.subscribedSyncGroupsForFetch(),
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
      this.resetPoolState();
      await this.fullBootstrap();
      return;
    }

    // Apply delta
    this.setPhase(BootstrapPhase.WritingToDatabase);
    for (const [name, records] of Object.entries(res.models)) {
      await this.database.writeModels(name, records);
      const meta = ModelRegistry.getModelMeta(name);
      if (meta?.loadStrategy === LoadStrategy.Eager) {
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
            LoadStrategy.Eager,
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
    if (this.config.routeCommit != null && !this.suppressUserIntentHooks) {
      const route = this.resolveCommitRoute({
        kind: "create",
        model,
        modelName: meta.name,
      });
      if (this.applyCreateRoute(model, meta, route)) {
        return;
      }
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
    if (this.config.routeCommit != null && !this.suppressUserIntentHooks) {
      // No pool entry → nothing for the hook to inspect; let the enqueue
      // proceed so the txqueue's own crash-recovery / target-deleted logic
      // is the single source of truth for "model gone."
      const model = this.objectPool.getById(modelName, modelId);
      if (model != null) {
        let previousData: Record<string, unknown> | undefined;
        const route = this.resolveCommitRoute({
          kind: "update",
          model,
          modelName,
          changes,
          previousData: () =>
            (previousData ??= this.previousDataFor(model, changes)),
        });
        if (this.applyUpdateRoute(model, modelName, changes, route)) {
          return;
        }
      }
    }
    this.transactionQueue.enqueueUpdate(modelId, modelName, changes);
  }

  private resolveCommitRoute(
    intent: CommitIntent,
  ): CommitRouteResult | undefined {
    const hook = this.config.routeCommit;
    if (hook == null) {
      return undefined;
    }
    try {
      return hook(intent) ?? undefined;
    } catch (err) {
      this.emitError(err, {
        kind: "beforeCommit",
        opKind: intent.kind,
        modelName: intent.modelName,
        modelId: intent.model.id,
      });
      return undefined;
    }
  }

  private applyCreateRoute(
    model: BaseModel,
    meta: ModelMeta,
    route: CommitRouteResult | undefined,
  ): boolean {
    if (route === undefined) {
      return false;
    }
    if (route === "skip") {
      return true;
    }
    const modelName = route.modelName ?? meta.name;
    const data = { ...model.serialize(), id: route.modelId };
    this.materializePoolOnly(modelName, [data], { onCollision: "error" });
    this.transactionQueue.enqueueCreate(route.modelId, modelName, data);
    return true;
  }

  private applyUpdateRoute(
    source: BaseModel,
    sourceModelName: string,
    changes: Record<string, PropertyChange>,
    route: CommitRouteResult | undefined,
  ): boolean {
    if (route === undefined) {
      return false;
    }
    if (route === "skip") {
      return true;
    }

    const restoreSource = () => {
      if (route.restoreOriginal === true) {
        for (const [propName, change] of Object.entries(changes)) {
          source.setQuiet(propName, change.oldValue);
        }
      }
    };

    const targetModelName = route.modelName ?? sourceModelName;
    const target = this.objectPool.getById(targetModelName, route.modelId);
    if (target == null) {
      this.emitError(
        new Error(
          `routeCommit redirect target not found (model=${targetModelName}, id=${route.modelId})`,
        ),
        {
          kind: "beforeCommit",
          opKind: "update",
          modelName: sourceModelName,
          modelId: source.id,
        },
      );
      // The adopter explicitly diverted away from the source — committing the
      // edit back onto it would be the surprising outcome. Honor the requested
      // restore and drop the write; an SSE/refresh will reconcile the pool.
      restoreSource();
      return true;
    }

    restoreSource();

    const replay: Record<string, unknown> = {};
    for (const [propName, change] of Object.entries(changes)) {
      replay[propName] = change.newValue;
    }

    this.suppressUserIntentHooks = true;
    try {
      target.assign(replay);
      target.save();
    } finally {
      this.suppressUserIntentHooks = false;
    }
    return true;
  }

  private previousDataFor(
    model: BaseModel,
    changes: Record<string, PropertyChange>,
  ): Record<string, unknown> {
    const previous = model.serialize();
    for (const [propName, change] of Object.entries(changes)) {
      previous[propName] = change.oldValue;
    }
    return previous;
  }

  /**
   * Hydrate server-shaped records straight into the pool — no
   * `CreateTransaction`, no server round-trip, no IDB write. Mirrors the insert
   * path SSE uses (`ObjectPool.hydrateAndPut`), so inverse links,
   * `@ReferenceCollection` membership, and `notifyModelChanged` reactivity all
   * wire up automatically.
   */
  materializePoolOnly<T extends BaseModel = BaseModel>(
    modelName: string,
    records: Record<string, unknown>[],
    options: { onCollision?: "error" | "hydrate" } = {},
  ): T[] {
    const meta = ModelRegistry.getModelMeta(modelName);
    if (meta == null) {
      throw new Error(`materializePoolOnly: unknown model "${modelName}".`);
    }
    const onCollision = options.onCollision ?? "error";
    const instances: T[] = [];
    for (const record of records) {
      if (typeof record.id !== "string" || record.id === "") {
        throw new Error(
          `materializePoolOnly: record for ${modelName} must include a string id.`,
        );
      }
      if (
        onCollision === "error" &&
        this.objectPool.getById(modelName, record.id) != null
      ) {
        throw new Error(
          `materializePoolOnly: ${modelName}#${record.id} already exists in the pool.`,
        );
      }
      instances.push(
        this.objectPool.hydrateAndPut(modelName, meta, record) as T,
      );
    }
    return instances;
  }

  /**
   * Convenience wrapper around `materializePoolOnly` for cloning existing
   * sources into pool-only optimistic mirrors.
   *
   * `transform` receives each source's serialized data plus the source
   * instance and must return a fully-formed record with a different `id`.
   * Use it to rewrite ids and any FK fields that should point at the
   * new scope.
   *
   * Intended for optimistic in-memory mirrors while the server fork-fetch
   * is in flight. When the server's records eventually arrive via SSE on
   * the same ids, `hydrate()` runs in place and the pendingChanges rebase
   * keeps any user edits the user has stacked on top.
   *
   * Throws if `transform` returns the source id unchanged — that would
   * silently overwrite the original instance.
   */
  clonePoolOnly<T extends BaseModel>(
    sources: T[],
    transform: (
      data: Record<string, unknown>,
      source: T,
    ) => Record<string, unknown>,
  ): T[] {
    const clones: T[] = [];
    for (const source of sources) {
      const meta = ModelRegistry.getMetaForInstance(source);
      if (meta == null) {
        continue;
      }
      const cloneData = transform(source.serialize(), source);
      if (cloneData.id === source.id) {
        throw new Error(
          `clonePoolOnly: clone must have a different id than source ` +
            `(model=${meta.name}, id=${source.id}). Rewrite \`id\` in \`transform\`.`,
        );
      }
      clones.push(...this.materializePoolOnly<T>(meta.name, [cloneData]));
    }
    return clones;
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

    const batchId = this.transactionQueue.hasActiveBatch
      ? null
      : this.transactionQueue.beginBatch();
    try {
      this.cascadeDeleteClient(meta.name, model.id);
      this.transactionQueue.enqueueDelete(model);
    } finally {
      if (batchId != null) {
        this.transactionQueue.endBatch(batchId);
      }
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

    const batchId = this.transactionQueue.hasActiveBatch
      ? null
      : this.transactionQueue.beginBatch();
    try {
      this.cascadeArchiveClient(meta.name, model.id);
      this.transactionQueue.enqueueArchive(model);
    } finally {
      if (batchId != null) {
        this.transactionQueue.endBatch(batchId);
      }
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
   * writes to IDB, and hydrates eager-load ones into the pool.
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
   * scoped to a subset of groups via `syncGroups` and to Eager models only.
   *
   * Returns `schemaMismatch: true` if the server reports a schema version that
   * doesn't match what's stored — in that case a full re-bootstrap has already
   * been triggered and the caller should bail.
   */
  private async fetchSyncGroupModels(
    groups: string[],
    dbMeta: DatabaseMeta,
  ): Promise<{ schemaMismatch: boolean }> {
    let res: BootstrapResponse;
    try {
      res = await this.config.bootstrapFetcher(BootstrapType.Full, {
        syncGroups: groups,
        onlyModels: ModelRegistry.eagerModelNames(),
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
      this.resetPoolState();
      await this.fullBootstrap();
      return { schemaMismatch: true };
    }

    await this.applyBootstrapResponse(res);

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
   * Targeted full fetch for Eager models added to the registry since the
   * last connect. Runs after partial bootstrap so existing models keep their
   * delta-only path; new Eager models get a full snapshot. Non-Eager
   * additions are silently dropped — they load on demand or not at all.
   */
  private async fetchNewlyAddedModels(modelNames: string[]): Promise<void> {
    const eager = new Set(ModelRegistry.eagerModelNames());
    const targets = modelNames.filter((name) => eager.has(name));
    if (targets.length === 0) {
      return;
    }
    let res: BootstrapResponse;
    try {
      res = await this.config.bootstrapFetcher(BootstrapType.Full, {
        onlyModels: targets,
        syncGroups: this.subscribedSyncGroupsForFetch(),
        currentMeta: this.database.currentMeta,
      });
    } catch (err) {
      this.emitError(err, { kind: "newModelsBootstrap", modelNames });
      return;
    }
    await this.applyBootstrapResponse(res);
  }

  /** Write a bootstrap response into IDB + the in-memory pool, then apply
   * any tombstones it carries. Shared by `fetchSyncGroupModels` and
   * `fetchNewlyAddedModels` — both are targeted full fetches. */
  private async applyBootstrapResponse(res: BootstrapResponse): Promise<void> {
    await Promise.all(
      Object.entries(res.models).map(async ([modelName, records]) => {
        await this.database.writeModels(modelName, records);
        this.hydrateEagerModels(modelName, records);
      }),
    );
    await this.applyDeletedIds(res);
  }

  /**
   * Write records for Eager models into the pool. Updates existing instances
   * in-place; creates new ones via hydrateAndPut for models not yet in memory.
   */
  private hydrateEagerModels(
    modelName: string,
    records: Record<string, unknown>[],
  ): void {
    const meta = ModelRegistry.getModelMeta(modelName);
    if (meta?.loadStrategy !== LoadStrategy.Eager) {
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

  // ── Atomic API ────────────────────────────────────────────────────────────

  /**
   * Stage optimistic edits with all-or-nothing local commit semantics.
   *
   *   storeManager.atomic(async () => {
   *     book.assign({ title: "X" });
   *     issue.assign({ status: "done" });
   *     await api.call();
   *   });
   *
   * Any model mutated inside `fn` registers with the active scope. On
   * resolve, every touched model's `save()` is called once (wrapped in a
   * single batch so undo collapses to one entry). On throw, every touched
   * model's `discardUnsavedChanges()` runs and the error re-throws.
   *
   * SSE deltas that arrive on a touched field during an `await` rebase the
   * model's `pendingChanges` baseline (see `BaseModel.hydrate`) — the
   * optimistic value stays visible, and a discard lands on the server's
   * latest known value rather than a stale pre-edit one.
   *
   * `runUndoable` side effects pass through unchanged: their server
   * mutation is not rolled back when the atomic block throws. Compensate
   * them yourself in the caller's catch if needed.
   *
   * Nested atomic scopes are not supported.
   */
  atomic<T>(fn: () => T): T;
  atomic<T>(fn: () => Promise<T>): Promise<T>;
  atomic<T>(fn: () => T | Promise<T>): T | Promise<T> {
    if (this.activeAtomicScope != null) {
      throw new Error(
        "Nested atomic() is not supported. The outer scope must resolve " +
          "before opening another.",
      );
    }
    const scope = new Set<BaseModel>();
    this.activeAtomicScope = scope;

    const finalize = (didThrow: boolean): void => {
      try {
        if (didThrow) {
          for (const m of scope) {
            m.discardUnsavedChanges();
          }
        } else {
          this.batch(() => {
            for (const m of scope) {
              if (m.hasUnsavedChanges) {
                m.save();
              }
            }
          });
        }
      } finally {
        this.activeAtomicScope = null;
      }
    };

    let result: T | Promise<T>;
    try {
      result = fn();
    } catch (err) {
      finalize(true);
      throw err;
    }

    if (result instanceof Promise) {
      return result.then(
        (v) => {
          finalize(false);
          return v;
        },
        (err) => {
          finalize(true);
          throw err;
        },
      );
    }
    finalize(false);
    return result;
  }

  /** @internal */
  registerAtomicTouch(model: BaseModel): void {
    this.activeAtomicScope?.add(model);
  }

  /** @internal Called from `BaseModel.propertyChanged` on the clean→dirty
   * transition. Suppressed during the engine's own redirect replay so the
   * draft target's `assign()` doesn't re-trigger a user-facing "first edit".
   * BaseModel guards on `hasModelTouchedHandler` before calling. */
  fireModelTouched(model: BaseModel, modelName: string): void {
    if (this.suppressUserIntentHooks) {
      return;
    }
    const hook = this.config.onModelTouched;
    if (hook == null) {
      return;
    }
    try {
      hook(model, modelName);
    } catch (err) {
      this.emitError(err, {
        kind: "onModelTouched",
        modelName,
        modelId: model.id,
      });
    }
  }

  // ── Undo / Redo ───────────────────────────────────────────────────────────

  undo() {
    return this.transactionQueue.undo();
  }
  redo() {
    return this.transactionQueue.redo();
  }

  /**
   * Run a remote side-effect that returns a `changeLogId`, and record it on
   * the undo stack so the next `undo()` invokes the consumer's
   * `undoableActions.undo` handler with that id.
   *
   * The function may return either the `changeLogId` string directly, or any
   * object with a `changeLogId` field — in which case the full object is
   * returned to the caller. Inside an open `batch()`, the action joins the
   * batch and undoes alongside the model transactions.
   *
   * If `fn` throws, nothing is recorded.
   */
  async runUndoable<T extends string | { changeLogId: string }>(
    fn: () => Promise<T> | T,
    opts?: { actionType?: string; metadata?: Record<string, unknown> },
  ): Promise<T> {
    const result = await fn();
    const changeLogId =
      typeof result === "string" ? result : result.changeLogId;
    const action: UndoableAction = {
      id: crypto.randomUUID(),
      changeLogId,
      actionType: opts?.actionType,
      metadata: opts?.metadata,
      timestamp: Date.now(),
    };
    this.transactionQueue.enqueueAction(action);
    return result;
  }

  // ── Lazy loading ──────────────────────────────────────────────────────────

  /**
   * Builds the `partialIndexCoverage` cache key. The `indexKey` segment is
   * usually a real model field name, but the value `ALL_INDEX_KEY_SENTINEL`
   * (`"*"`) is reserved for `getOrLoadAll` whole-table coverage and must
   * not collide with any real field name.
   */
  private static collectionKey(
    modelName: string,
    indexKey: string,
    value: string,
  ): string {
    return `${modelName}:${indexKey}:${value}`;
  }

  private static modelIdKey(modelName: string, id: string): string {
    return `${modelName}:${id}`;
  }

  /** Pool-first collection lookup where indexKey === value (e.g. all Issues for a team). */
  async getOrLoadCollection<T extends BaseModel = BaseModel>(
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

    // Single resolved fetcher — either the batched loader or the per-triple
    // callback. Routing both through one local lets TS narrow the null check.
    const fetchFromServer =
      this.indexBatchLoader != null
        ? (m: string, k: string, v: string) =>
            this.indexBatchLoader!.load({ modelName: m, indexKey: k, value: v })
        : this.config.onDemandFetcher;

    if (
      meta?.loadStrategy !== LoadStrategy.Eager &&
      fetchFromServer != null &&
      !this.partialIndexCoverage.has(key) &&
      // Compound coverage only ever exists when the adopter opted into
      // server-side compound index keys; skip the parent/FK walk otherwise.
      (this.config.serverSupportsCompoundIndexKeys !== true ||
        !this.isCoveredByCompound(modelName, indexKey, value))
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
      // Contrast with getOrLoadById: a single ID lookup is binary — either the record
      // is in IDB or it isn't — so the server is only consulted as a last resort.
      const serverRecords = await fetchFromServer(modelName, indexKey, value);
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
      // Empty result still expresses "we asked for this model" — mark it
      // loaded so the SSE catchup URL includes it and future inserts arrive.
      this.database.markModelLoaded(modelName);
      // Mark loaded before the IDB read so SSE inserts arriving during
      // that read are hydrated directly rather than waiting for next access.
      // The persistent record is set later via markPartialIndexLoaded.
      this.partialIndexCoverage.set(key, {
        modelName,
        indexKey,
        value,
        firstSyncId: this.database.currentMeta?.lastSyncId ?? 0,
      });
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
    return this.partialIndexCoverage.has(
      StoreManager.collectionKey(modelName, indexKey, value),
    );
  }

  /** True when the model has `*`-coverage (a completed `getOrLoadAll`) or
   * a full-load fetch is currently in flight. Read on the SSE insert hot
   * path via `shouldHydrateInsert` — the in-flight branch is what makes
   * deltas land in the pool during the fetch window. */
  isModelFullyLoaded(modelName: string): boolean {
    return (
      this.fullyLoadedModels.has(modelName) ||
      this.pendingFullLoadRefcount.has(modelName)
    );
  }

  /** Called by SSE D/A processing whenever a delete arrives. While a model
   * has a pending full-load, the id is recorded so the in-flight fetch's
   * merge step can drop a stale-snapshot resurrection. No-op when no fetch
   * is pending — keeps the hot path cheap. */
  recordInflightDelete(modelName: string, id: string): void {
    if (!this.pendingFullLoadRefcount.has(modelName)) {
      return;
    }
    let set = this.inflightDeletes.get(modelName);
    if (set == null) {
      set = new Set();
      this.inflightDeletes.set(modelName, set);
    }
    set.add(id);
  }

  /** Increment the in-flight refcount for `modelName`. Must be paired with
   * `endPendingFullLoad`. While refcount > 0, `isModelFullyLoaded` returns
   * true (admitting SSE inserts to the pool) and `recordInflightDelete`
   * tracks tombstones. */
  private beginPendingFullLoad(modelName: string): void {
    const prev = this.pendingFullLoadRefcount.get(modelName) ?? 0;
    this.pendingFullLoadRefcount.set(modelName, prev + 1);
  }

  /** Decrement the in-flight refcount. When it hits 0, drop the tombstone
   * set — any snapshot that needed it has already merged. */
  private endPendingFullLoad(modelName: string): void {
    const prev = this.pendingFullLoadRefcount.get(modelName) ?? 0;
    if (prev <= 1) {
      this.pendingFullLoadRefcount.delete(modelName);
      this.inflightDeletes.delete(modelName);
    } else {
      this.pendingFullLoadRefcount.set(modelName, prev - 1);
    }
  }

  /** Strip records whose id was tombstoned by an SSE delete during the
   * in-flight full-load window. Common case (no pending deletes) returns
   * the input unchanged so the caller doesn't allocate. */
  private filterTombstoned(
    modelName: string,
    records: Record<string, unknown>[],
  ): Record<string, unknown>[] {
    const t = this.inflightDeletes.get(modelName);
    return t != null && t.size > 0
      ? records.filter((r) => !t.has(r.id as string))
      : records;
  }

  /**
   * Derive-on-read for compound coverage: a direct triple
   * `(modelName, indexKey, value)` is implicitly covered when a previously-
   * fetched compound query `(modelName, "indexKey.fk", parent.fk)` exists
   * AND the parent of `value` shares that FK value. Walks one hop on the
   * parent — must stay in sync with `collapseGroup` in
   * `CompoundIndexFetcher.ts`. If the rewriter ever recurses (e.g. to
   * `taskId.projectId.workspaceId`), this loop needs the same recursion
   * or covered reads will silently miss and re-fetch.
   *
   * Skipped (returns false) when:
   *   - `indexKey` is already a dotted path (we only check direct keys)
   *   - the FK's referent model isn't registered
   *   - `value`'s parent isn't in the pool
   *   - no outgoing FK on the parent has a matching compound coverage
   */
  private isCoveredByCompound(
    modelName: string,
    indexKey: string,
    value: string,
  ): boolean {
    if (indexKey.includes(".")) {
      return false;
    }
    const childMeta = ModelRegistry.getModelMeta(modelName);
    const fkProp = childMeta?.properties.get(indexKey);
    if (fkProp?.type !== PropertyType.Reference || fkProp.referenceTo == null) {
      return false;
    }
    const parent = this.objectPool.getById(fkProp.referenceTo, value);
    if (parent == null) {
      return false;
    }
    const parentMeta = ModelRegistry.getModelMeta(fkProp.referenceTo);
    if (parentMeta == null) {
      return false;
    }
    for (const prop of parentMeta.properties.values()) {
      if (prop.type !== PropertyType.Reference || prop.referenceTo == null) {
        continue;
      }
      const v = readFk(parent, prop.name);
      if (v == null) {
        continue;
      }
      const compoundKey = StoreManager.collectionKey(
        modelName,
        `${indexKey}.${prop.name}`,
        v,
      );
      if (this.partialIndexCoverage.has(compoundKey)) {
        return true;
      }
    }
    return false;
  }

  /** Mark a `(modelName, indexKey, value)` query as fully covered locally as
   * of `firstSyncId`. Updates the in-memory hot cache and the storage
   * adapter's persistent store. */
  private async markPartialIndexLoaded(
    modelName: string,
    indexKey: string,
    value: string,
  ): Promise<void> {
    const firstSyncId = this.database.currentMeta?.lastSyncId ?? 0;
    this.partialIndexCoverage.set(
      StoreManager.collectionKey(modelName, indexKey, value),
      { modelName, indexKey, value, firstSyncId },
    );
    if (indexKey === ALL_INDEX_KEY_SENTINEL) {
      this.fullyLoadedModels.add(modelName);
    }
    await this.database.recordPartialIndex(
      modelName,
      indexKey,
      value,
      firstSyncId,
    );
  }

  /**
   * Absorb the response from a synthetic compound query produced by
   * `wrapCompoundFetcher`. The full response bag is written to IDB so
   * future direct lookups within the compound's coverage area find their
   * records — `BatchModelLoader.flush` only delivers per-waiter slices,
   * which would otherwise drop records for parents that weren't in the
   * original batch. The compound key itself is recorded in
   * `partialIndexCoverage` so derive-on-read can short-circuit subsequent
   * direct loads.
   */
  private async absorbCompoundResponse(
    compound: { modelName: string; indexKey: string; value: string },
    bag: Record<string, unknown>[],
  ): Promise<void> {
    const meta = ModelRegistry.getModelMeta(compound.modelName);
    if (meta?.loadStrategy !== LoadStrategy.Ephemeral && bag.length > 0) {
      await this.database.writeModels(compound.modelName, bag);
    }
    await this.markPartialIndexLoaded(
      compound.modelName,
      compound.indexKey,
      compound.value,
    );
  }

  /**
   * Returns every recorded `(modelName, indexKey, value, firstSyncId)` tuple
   * known to this client. Adopters can ship the result to the server alongside
   * a partial fetch so it can return only deltas since each scope's
   * `firstSyncId` instead of re-shipping the full snapshot.
   */
  getPartialIndexCoverage(): PartialIndexEntry[] {
    return [...this.partialIndexCoverage.values()];
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
   * `loadedCollections` cache key so a future `getOrLoadCollection(modelName,
   * indexKey, value)` re-fetches from the server instead of trusting IDB.
   */
  async evictByIndex(
    modelName: string,
    indexKey: string,
    value: string,
  ): Promise<void> {
    this.evictFromPool(modelName, (m) => m[indexKey] === value);
    await this.database.deleteModelsByIndex(modelName, indexKey, value);
    this.partialIndexCoverage.delete(
      StoreManager.collectionKey(modelName, indexKey, value),
    );
    if (indexKey === ALL_INDEX_KEY_SENTINEL) {
      // Multiple scopes can coexist for the same model — only flip the
      // mirror set off when no other `*` entry remains.
      let stillCovered = false;
      for (const entry of this.partialIndexCoverage.values()) {
        if (
          entry.modelName === modelName &&
          entry.indexKey === ALL_INDEX_KEY_SENTINEL
        ) {
          stillCovered = true;
          break;
        }
      }
      if (!stillCovered) {
        this.fullyLoadedModels.delete(modelName);
      }
    }
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

  /** Pool-first bulk lookup by ID (for OwnedCollection resolution). */
  async getOrLoadByIds<T extends BaseModel = BaseModel>(
    modelName: string,
    ids: string[],
  ): Promise<T[]> {
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
            // Empty result still expresses "we asked for this model" — mark
            // it loaded so the SSE catchup URL includes it and future
            // inserts arrive. Mirrors the same call in `getOrLoadById`.
            this.database.markModelLoaded(modelName);
            for (const id of unloaded) {
              this.loadedIds.add(StoreManager.modelIdKey(modelName, id));
            }
          } else {
            await Promise.all(
              unloaded.map((id) => this.getOrLoadById(modelName, id)),
            );
          }
        }
      }
    }

    return ids
      .map((id) => this.objectPool.getById<T>(modelName, id))
      .filter((m): m is T => m != null);
  }

  /** Pool-first single-model lookup by ID. */
  async getOrLoadById<T extends BaseModel = BaseModel>(
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
      // Empty result still expresses "we asked for this model" — mark it as
      // loaded so the SSE catchup URL includes it and future inserts arrive.
      this.database.markModelLoaded(modelName);
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

  /**
   * Load every instance of `modelName`, optionally scoped to a set of sync
   * groups. Triggers a Full bootstrap fetch on first call, hydrates the
   * results, and records coverage so subsequent same-scope calls short-circuit.
   *
   * Per-strategy behavior:
   *   - Eager / Ephemeral — already fully resident; returns pool snapshot.
   *   - Local — returns IDB contents (no server hit).
   *   - Lazy / Partial — fetches and hydrates.
   *
   * Coverage is tracked in `partialIndexCoverage` under the
   * `ALL_INDEX_KEY_SENTINEL` reserved indexKey — adopters never see it but it
   * coexists with real indexKeys, so callers must avoid using "*" themselves.
   *
   * Concurrent SSE deltas during the fetch are merged via a pending-flag +
   * tombstone scheme — see `agent-docs/04-lazy-loading.md` for the full
   * invariants. Concurrent calls with the same `(modelName, scope)` coalesce
   * into one fetch via `inflightFullLoads`.
   */
  async getOrLoadAll<T extends BaseModel = BaseModel>(
    modelName: string,
    opts: { syncGroups?: string[] } = {},
  ): Promise<T[]> {
    const meta = ModelRegistry.getModelMeta(modelName);
    if (meta == null) {
      return [];
    }
    const { loadStrategy } = meta;

    if (
      loadStrategy === LoadStrategy.Eager ||
      loadStrategy === LoadStrategy.Ephemeral
    ) {
      return this.objectPool.getAll<T>(modelName);
    }

    const scope = (opts.syncGroups ?? []).slice().sort();
    // Per-element encode so commas inside any ID don't collide with the join.
    const coverageValue = encodeCsvList(scope);
    const coverageKey = StoreManager.collectionKey(
      modelName,
      ALL_INDEX_KEY_SENTINEL,
      coverageValue,
    );

    const isLocal = loadStrategy === LoadStrategy.LocalOnly;
    const alreadyCovered =
      isLocal || this.partialIndexCoverage.has(coverageKey);

    // Fast path: pool was already hydrated this session AND coverage is in
    // place. SSE keeps the pool current for `*`-covered models (see
    // `isModelFullyLoaded` + `shouldHydrateInsert`), so no IDB scan needed.
    if (alreadyCovered && this.poolSyncedFromIDB.has(modelName)) {
      return this.objectPool.getAll<T>(modelName);
    }

    const inflight = this.inflightFullLoads.get(coverageKey);
    if (inflight != null) {
      return inflight as Promise<T[]>;
    }

    const work = alreadyCovered
      ? this.hydrateFullLoadFromIDB(modelName, meta)
      : this.fetchAndMergeFullLoad(modelName, scope);
    this.inflightFullLoads.set(coverageKey, work);
    try {
      return (await work) as T[];
    } finally {
      this.inflightFullLoads.delete(coverageKey);
    }
  }

  /** Hydrate every IDB row for a covered (or Local) model into the pool.
   * Used the first time `getOrLoadAll` runs this session against a model
   * whose `*`-coverage was already recorded (e.g. on a warm reload). */
  private async hydrateFullLoadFromIDB(
    modelName: string,
    meta: ModelMeta,
  ): Promise<BaseModel[]> {
    const idbRecords = await this.database.readAllModels(modelName);
    for (const record of idbRecords) {
      this.objectPool.hydrateAndPut(modelName, meta, record);
    }
    this.poolSyncedFromIDB.add(modelName);
    return this.objectPool.getAll(modelName);
  }

  /** Fetch the snapshot and merge it with whatever the SSE pipeline wrote
   * during the in-flight window. See the JSDoc on `getOrLoadAll` for the
   * merge invariants (skip pool-present, drop tombstoned, IDB if-absent). */
  private async fetchAndMergeFullLoad(
    modelName: string,
    scope: string[],
  ): Promise<BaseModel[]> {
    const meta = ModelRegistry.getModelMeta(modelName);
    if (meta == null) {
      return [];
    }
    const coverageValue = encodeCsvList(scope);
    this.beginPendingFullLoad(modelName);
    try {
      let res: BootstrapResponse;
      try {
        res = await this.config.bootstrapFetcher(BootstrapType.Full, {
          onlyModels: [modelName],
          syncGroups:
            scope.length > 0 ? scope : this.subscribedSyncGroupsForFetch(),
          currentMeta: this.database.currentMeta,
        });
      } catch (err) {
        this.emitError(err, { kind: "syncGroupFetch", groups: scope });
        throw err;
      }

      const live = this.filterTombstoned(
        modelName,
        res.models[modelName] ?? [],
      );
      if (live.length > 0) {
        await this.database.writeModelsIfAbsent(modelName, live);
        for (const record of live) {
          const id = record.id as string | undefined;
          if (id != null && this.objectPool.getById(modelName, id) != null) {
            continue;
          }
          this.objectPool.hydrateAndPut(modelName, meta, record);
        }
      }

      this.database.markModelLoaded(modelName);
      await this.markPartialIndexLoaded(
        modelName,
        ALL_INDEX_KEY_SENTINEL,
        coverageValue,
      );
      this.poolSyncedFromIDB.add(modelName);
      return this.objectPool.getAll(modelName);
    } finally {
      this.endPendingFullLoad(modelName);
    }
  }

  // ── Test / Storybook seeding ─────────────────────────────────────────────
  //
  // Pool-only helpers for injecting fixtures without going through
  // `bootstrapFetcher` or any I/O. The accepted shape mirrors
  // `BootstrapResponse.models` so adopters can paste fixtures from one to
  // the other. Re-seeding the same id is idempotent — `hydrateAndPut`
  // re-hydrates in place rather than constructing a new instance.
  //
  // No IDB write, no `partialIndexCoverage` mutation, no `loadedModels`
  // change. Adopters who want "this collection is fully covered, don't
  // refetch on subsequent getOrLoadCollection" can additionally call
  // `getOrLoadCollection` with a no-op fetcher to mark coverage.

  /** Hydrate `records` into the pool as instances of `modelName` and
   * return them. Skips any record whose model isn't registered.
   * Intended for stories and tests, not production. */
  seed<T extends BaseModel = BaseModel>(
    modelName: string,
    records: Record<string, unknown>[],
  ): T[] {
    const meta = ModelRegistry.getModelMeta(modelName);
    if (meta == null) {
      return [];
    }
    return records.map(
      (record) => this.objectPool.hydrateAndPut(modelName, meta, record) as T,
    );
  }

  /** Bulk seed: takes the same shape as `BootstrapResponse.models`. Useful
   * for one-shot story setup that hydrates a graph in one call. */
  seedMany(modelsByName: Record<string, Record<string, unknown>[]>): void {
    for (const [modelName, records] of Object.entries(modelsByName)) {
      this.seed(modelName, records);
    }
  }

  // ── Refresh ──────────────────────────────────────────────────────────────

  /**
   * Sync filter over the pool for records of `modelName` whose `indexKey`
   * field matches `value`. Used by the typed `store.<entity>.peekByIndex`
   * surface and shared with the diff path inside `refreshCollection`.
   */
  peekByIndex<T extends BaseModel = BaseModel>(
    modelName: string,
    indexKey: string,
    value: string,
  ): T[] {
    return this.objectPool
      .getAll<T>(modelName)
      .filter((m) => prop(m, indexKey) === value);
  }

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
      this.peekByIndex(modelName, indexKey, value).map((m) => m.id),
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
    for (const entry of this.partialIndexCoverage.values()) {
      if (entry.modelName === modelName) {
        collectionKeys.push({ indexKey: entry.indexKey, value: entry.value });
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

  /** Drop in-memory pool + the per-session "we hydrated from IDB" mirror.
   * Used by the schema-mismatch fallback in delta processing and sync-
   * group fetches: when the server's data shape changes we throw away the
   * pool and re-bootstrap. The two clears are an invariant pair —
   * extracting the helper enforces it across both call sites instead of
   * trusting future authors to remember. `partialIndexCoverage` is NOT
   * cleared here because the schema-mismatch path keeps coverage entries;
   * the `fullyLoadedModels` mirror stays consistent with that. */
  private resetPoolState(): void {
    this.objectPool.clear();
    this.poolSyncedFromIDB.clear();
    this.pendingFullLoadRefcount.clear();
    this.inflightDeletes.clear();
    this.inflightFullLoads.clear();
    this.seededSyncGroups = [];
  }

  async teardown() {
    this.stopped = true;
    BaseModel.storeManager = null;
    this.loadedModelsUnsub?.();
    this.loadedModelsUnsub = null;
    if (this.syncReconnectTimer != null) {
      clearTimeout(this.syncReconnectTimer);
      this.syncReconnectTimer = null;
    }
    this.syncConnection?.disconnect();
    this.syncConnection = null;
    for (const stream of this.modelStreams) {
      stream.disconnect();
    }
    this.modelStreams = [];
    this.transactionQueue.destroy();
    this.indexBatchLoader?.dispose();
    this.indexBatchLoader = null;
    await this.database.close();
    this.objectPool.clear();
    this.stores.clear();
    this.partialIndexCoverage.clear();
    this.fullyLoadedModels.clear();
    this.pendingFullLoadRefcount.clear();
    this.inflightDeletes.clear();
    this.inflightFullLoads.clear();
    this.seededSyncGroups = [];
    this.loadedIds.clear();
    this.poolSyncedFromIDB.clear();
    this.fieldTransforms.clear();
    this.hasFieldTransforms = false;
    this.hasModelTouchedHandler = false;
    this.setPhase(BootstrapPhase.Idle);
  }

  /** Debounced reconnect for SSE when `loadedModels` mutates. A burst of
   * transitions in the same tick (or across awaited writes in the same
   * async chain) coalesces into a single reconnect. setTimeout — not
   * queueMicrotask — so consecutive `await db.writeModels(A); await
   * db.writeModels(B)` doesn't reconnect twice. */
  private scheduleSyncReconnect(): void {
    if (this.syncReconnectTimer != null || this.syncConnection == null) {
      return;
    }
    this.syncReconnectTimer = setTimeout(() => {
      this.syncReconnectTimer = null;
      if (this.stopped) {
        return;
      }
      this.syncConnection?.reconnect();
    }, 0);
  }
}
