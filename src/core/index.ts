// `zerodrift` — the curated, stable adopter surface. The engine's runtime
// machinery lives behind `zerodrift/internal` (see internal.ts).

// ── Enums & serializers ────────────────────────────────────────────────────
export {
  LoadStrategy,
  PropertyType,
  BootstrapPhase,
  TransactionState,
} from "./types.js";
export { dateSerializer, dateDeserializer } from "./serializers.js";

// ── Adopter-facing types ───────────────────────────────────────────────────
// Referenced by the public config / decorator / commit-routing surface.
export type {
  PropertyMeta,
  ModelMeta,
  FieldTransform,
  PropertyChange,
  CommitIntent,
  CommitRouteResult,
  CommitRouteHandler,
  OnModelTouchedHandler,
  OnDelete,
  EngineErrorContext,
  EngineErrorHandler,
} from "./types.js";

// ── Model definition ───────────────────────────────────────────────────────
export {
  ClientModel,
  Property,
  EphemeralProperty,
  Reference,
  LazyReference,
  ReferenceCollection,
  LazyReferenceCollection,
  OwnedCollection,
  LazyOwnedCollection,
  BackReference,
  ReferenceArray,
  Action,
  Computed,
} from "./decorators.js";
export { BaseModel } from "./BaseModel.js";

// Relation field types — adopters annotate model fields with these
// (`public issues: RefCollection<Issue>`), so they stay on the curated
// surface even though their construction is engine-internal.
export { RefCollection, BackRef, CollectionState } from "./LazyCollection.js";
export { OwnedRefs } from "./LazyOwnedCollection.js";

// ── Storage ────────────────────────────────────────────────────────────────
export { MemoryAdapter } from "./MemoryAdapter.js";
export { BootstrapType } from "./Database.js";
export type { DatabaseMeta, StorageAdapter } from "./Database.js";

// ── Engine ─────────────────────────────────────────────────────────────────
export { StoreManager, RestrictDeleteError } from "./StoreManager.js";
export type {
  BootstrapResponse,
  EvictOptions,
  BootstrapFetcher,
  BootstrapFetcherOptions,
  FetcherContext,
  StoreManagerConfig,
  TransportConfig,
  LoadingConfig,
  PersistenceConfig,
  HooksConfig,
  AdvancedConfig,
  OnDemandConfig,
  OnDemandFetcher,
  OnDemandBatchFetcher,
  ModelStreamConfig,
} from "./StoreManager.js";

// ── Transactions & undo (config / runUndoable surface) ─────────────────────
export type {
  UndoableAction,
  RemoteChange,
  RemoteUndoAction,
  RemoteUndoContext,
  RemoteUndoConfig,
  RemoteUndoHandlerResult,
} from "./Transaction.js";
export type {
  TransactionSender,
  BatchResponse,
  UndoableActionHandlers,
  UndoResult,
} from "./TransactionQueue.js";

// ── Sync (config: syncTransform / modelStreams) ────────────────────────────
export type {
  SyncAction,
  DeltaPacket,
  SSEEndpoint,
  SyncMessageTransform,
} from "./SyncConnection.js";
export type { ModelUpdate, ModelStreamMessageTransform } from "./ModelStream.js";
