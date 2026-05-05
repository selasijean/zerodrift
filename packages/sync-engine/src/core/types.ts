import type { BaseModel } from "./BaseModel";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

/** How a model is loaded into the client during bootstrap. */
export enum LoadStrategy {
  /** Loaded immediately during bootstrap. Most models use this. */
  Instant = "instant",
  /** Not loaded at bootstrap. All instances fetched when first needed. */
  Lazy = "lazy",
  /** Only a subset of instances loaded on demand (e.g. DocumentContent). */
  Partial = "partial",
  /** Only loaded when explicitly requested (e.g. DocumentContentHistory). */
  ExplicitlyRequested = "explicitlyRequested",
  /** Stored only in local IndexedDB. Used for features still in development. */
  Local = "local",
  /** Pool-only — never persisted to IDB. Updated only in memory via SSE streams. */
  Ephemeral = "ephemeral",
}

/** The kind of data a property holds. Determines how it's stored and observed. */
export enum PropertyType {
  /** A regular persisted property owned by the model (e.g. Issue.title). */
  Property = "property",
  /** Like Property but NOT saved to IndexedDB (e.g. User.lastInteraction). */
  EphemeralProperty = "ephemeralProperty",
  /** A foreign key ID pointing to another model (e.g. Issue.teamId). Persisted and indexed. */
  Reference = "reference",
  /** A virtual getter/setter that resolves a Reference ID to the actual model instance. Not persisted. */
  ReferenceModel = "referenceModel",
  /** A one-to-many relationship from the parent side (e.g. Team.templates). */
  ReferenceCollection = "referenceCollection",
  /** Inverse of a Reference. Deleted when the referenced model is deleted. */
  BackReference = "backReference",
  /** A many-to-many relationship stored as an array of IDs (e.g. Project.memberIds). */
  ReferenceArray = "referenceArray",
  /** A collection where the parent owns an array of IDs (e.g. Team.issueIds → issues). */
  OwnedCollection = "ownedCollection",
}

/** Progress phases during the bootstrap pipeline. Used for loading indicators. */
export enum BootstrapPhase {
  Idle = "idle",
  CreatingStores = "creatingStores",
  ConnectingDatabase = "connectingDatabase",
  DeterminingBootstrapType = "determiningBootstrapType",
  Fetching = "fetching",
  WritingToDatabase = "writingToDatabase",
  Hydrating = "hydrating",
  ConnectingSync = "connectingSync",
  Ready = "ready",
  Error = "error",
}

/** Transaction lifecycle states. */
export enum TransactionState {
  /** Created but not yet sent to the server. */
  Pending = "pending",
  /** Sent to the server, waiting for response. */
  Executing = "executing",
  /** Server acknowledged, but the matching delta packet hasn't arrived yet. */
  CompletedButUnsynced = "completedButUnsynced",
  /** Delta packet received. Fully done. */
  Completed = "completed",
  /** Server rejected the transaction. */
  Failed = "failed",
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Default `transientIndexDepth` — how deep `RefCollection`s walk the parent's
 * outgoing FK chain to auto-derive covering axes when no explicit value is
 * passed via `StoreManagerConfig.transientIndexDepth`. See that field for
 * the trade-offs. Lives in types.ts so both the StoreManager getter and the
 * BaseModel fallback can reference the same constant without a cycle.
 */
export const DEFAULT_TRANSIENT_INDEX_DEPTH = 3;

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

/**
 * One auto-derived covering axis for a `RefCollection`. Each path encodes
 * how to reach a value on the parent (or a deeper ancestor) that matches an
 * indexed FK on the child. Resolved at `RefCollection.hydrate()`:
 *
 *   walk the `hops` chain through the pool; the last hop's `fk` value is
 *   used as the covering query — `Comment[axis = resolvedValue]`.
 *
 * For depth 1 (`hops.length === 1`), resolution is `readFk(parent, hops[0].fk)`.
 * For depth 2+, intermediate hops resolve through `pool.getById(throughModel, id)`.
 */
export interface CoveringPath {
  /** The FK name on the child model — also `hops[hops.length - 1].fk`. */
  axis: string;
  /** Chain of FK lookups starting from the parent. The last hop is the
   * leaf; preceding hops are pool look-ups that resolve to the next model. */
  hops: { fk: string; throughModel: string }[];
}

/** Metadata about a single property, stored in the ModelRegistry. */
export interface PropertyMeta {
  name: string;
  type: PropertyType;
  lazy?: boolean;
  nullable?: boolean;
  indexed?: boolean;
  serializer?: (value: unknown) => unknown;
  deserializer?: (value: unknown) => unknown;
  referenceTo?: string; // name of the model this reference points to
  inverseOf?: string; // for BackReference: the property name on the other side
  idField?: string; // for ReferenceModel: the backing ID property name (e.g. "teamId")
  idsField?: string; // for OwnedCollection: the array property holding the IDs (e.g. "issueIds")
  onDelete?: OnDelete;
  /**
   * Additional FK axes a `@*ReferenceCollection` covers beyond `inverseOf`.
   * Each entry names a property on the *parent* model whose value is also a
   * partial-index key on the child. At hydrate time the collection reads
   * `parent[axis]` and emits an extra query, so the load fetches the union of
   * (inverseOf == parent.id) plus each covering axis. Used for sync-group
   * scoping and similar multi-axis lazy queries.
   */
  coveringIndexes?: string[];
}

/** Metadata about a model class, stored in the ModelRegistry. */
export interface ModelMeta {
  name: string;
  loadStrategy: LoadStrategy;
  usedForPartialIndexes: boolean;
  properties: Map<string, PropertyMeta>;
  actions: Set<string>;
  computedProps: Set<string>;
  ctor: new () => BaseModel;
  schemaVersion: number;
}

/** Tracks what changed on a property: old value and new value. */
export interface PropertyChange {
  oldValue: unknown;
  newValue: unknown;
}

/** Behavior when the parent of a `Reference` / `BackReference` is deleted. */
export type OnDelete = "cascade" | "nullify" | "restrict";

// ---------------------------------------------------------------------------
// Minimal interfaces used by BaseModel to avoid circular imports
// ---------------------------------------------------------------------------

/** Object pool interface as seen from BaseModel. Avoids importing ObjectPool directly. */
export interface IObjectPool {
  getById<T extends BaseModel = BaseModel>(
    modelName: string,
    id: string,
  ): T | undefined;
  put(modelName: string, instance: BaseModel): void;
  /**
   * Notify the pool that a child's foreign-key property changed so it can
   * detach from the old parent's RefCollection / BackRef and attach to the
   * new one. Called by BaseModel from `propertyChanged` and from `hydrate`
   * when an in-pool model receives a delta-driven box update.
   */
  notifyReferenceChange(
    child: BaseModel,
    childModelName: string,
    fkName: string,
    oldId: string | null,
    newId: string | null,
  ): void;
  /**
   * Register a tracked MobX dependency on the pool entry for `(modelName, id)`.
   * The pool fires the corresponding atom on insert / removal / identity swap,
   * so observers reading the entry through `@Reference` re-evaluate even when
   * the holder's foreign key didn't change.
   */
  trackModel(modelName: string, id: string): void;
}

/** Store manager interface as seen from BaseModel. Avoids importing StoreManager directly. */
export interface IStoreManager {
  readonly objectPool: IObjectPool;
  /** How deep `RefCollection` walks the parent FK graph to auto-derive
   * covering axes. Configurable via `StoreManagerConfig.transientIndexDepth`
   * (default 3). Capped at the registry-walk implementation's max depth. */
  readonly transientIndexDepth: number;
  commitCreate(model: BaseModel): void;
  commitUpdate(
    modelId: string,
    modelName: string,
    changes: Record<string, PropertyChange>,
  ): void;
  getOrLoadCollection(
    modelName: string,
    key: string,
    value: string,
  ): Promise<BaseModel[]>;
  getOrLoadByIds(modelName: string, ids: string[]): Promise<BaseModel[]>;
  getOrLoadById(modelName: string, id: string): Promise<BaseModel | null>;
  emitError(err: unknown, context: EngineErrorContext): void;
  /** Mint a fresh id for a newly-constructed client-side model. Honors
   * `StoreManagerConfig.identifierFn` if configured; otherwise falls back
   * to `crypto.randomUUID()`. */
  mintId(instance: BaseModel): string;
}

/**
 * Tagged union describing where in the engine an error originated. Passed to
 * `StoreManagerConfig.onError` so adopters can route into Sentry/Datadog/console
 * with the right metadata. Each tag carries fields specific to its failure site.
 */
export type EngineErrorContext =
  | { kind: "eagerReferenceLoad"; modelName: string; id: string }
  | {
      kind: "eagerCollectionLoad";
      modelName: string;
      parentModelName: string;
      parentId: string;
    }
  | {
      kind: "lazyCollectionLoad";
      modelName: string;
      parentModelName: string;
      parentId: string;
    }
  | { kind: "lazyOwnedCollectionLoad"; modelName: string }
  | { kind: "lazyBackRefLoad"; modelName: string; parentId: string }
  | { kind: "deferredBootstrap"; modelNames: string[] }
  | { kind: "newModelsBootstrap"; modelNames: string[] }
  | {
      kind: "transactionDiscarded";
      modelName: string;
      modelId: string;
      action: string;
      reason: "target-deleted";
    }
  | { kind: "syncGroupFetch"; groups: string[] }
  | { kind: "ssePacketParse"; url: string; raw: string }
  | { kind: "sseConstruction"; url: string }
  | { kind: "transactionSend"; batchSize: number }
  | { kind: "onSyncGroupDelete"; groupId: string }
  | {
      kind: "undoableAction";
      phase: "undo" | "redo";
      changeLogId: string;
      actionType?: string;
    };

export type EngineErrorHandler = (
  err: Error,
  context: EngineErrorContext,
) => void;

/** Coerce an `unknown` from a `catch` clause into a real `Error` instance. */
export const toError = (err: unknown): Error =>
  err instanceof Error ? err : new Error(String(err));
