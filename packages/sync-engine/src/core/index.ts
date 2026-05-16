// `sync-engine` — the curated, stable adopter surface. The engine's runtime
// machinery lives behind `sync-engine/internal` (see internal.ts).

// ── Enums & serializers ────────────────────────────────────────────────────
export {
  LoadStrategy,
  PropertyType,
  BootstrapPhase,
  TransactionState,
} from "./types";
export { dateSerializer, dateDeserializer } from "./serializers";

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
} from "./types";

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
} from "./decorators";
export { BaseModel } from "./BaseModel";

// Relation field types — adopters annotate model fields with these
// (`public issues: RefCollection<Issue>`), so they stay on the curated
// surface even though their construction is engine-internal.
export { RefCollection, BackRef, CollectionState } from "./LazyCollection";
export { OwnedRefs } from "./LazyOwnedCollection";

// ── Storage ────────────────────────────────────────────────────────────────
export { MemoryAdapter } from "./MemoryAdapter";
export { BootstrapType } from "./Database";
export type { DatabaseMeta, StorageAdapter } from "./Database";

// ── Engine ─────────────────────────────────────────────────────────────────
export { StoreManager, RestrictDeleteError } from "./StoreManager";
export type {
  BootstrapResponse,
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
} from "./StoreManager";

// ── Transactions & undo (config / runUndoable surface) ─────────────────────
export type { UndoableAction } from "./Transaction";
export type {
  TransactionSender,
  BatchResponse,
  UndoableActionHandlers,
  UndoResult,
} from "./TransactionQueue";

// ── Sync (config: syncTransform / modelStreams) ────────────────────────────
export type {
  SyncAction,
  DeltaPacket,
  SyncMessageTransform,
} from "./SyncConnection";
export type { ModelUpdate, ModelStreamMessageTransform } from "./ModelStream";
