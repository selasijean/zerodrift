// Types & enums
export * from "./types";

// Model definition
export { ModelRegistry } from "./ModelRegistry";
export { defineObservableProperty } from "./observability";
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

// Bootstrapping
export { ObjectPool } from "./ObjectPool";
export { Database, BootstrapType } from "./Database";
export type { DatabaseMeta, StorageAdapter } from "./Database";
export { MemoryAdapter } from "./MemoryAdapter";
export { FullStore, PartialStore, ModelStore } from "./Store";
export { StoreManager, RestrictDeleteError } from "./StoreManager";
export type {
  BootstrapResponse,
  BootstrapFetcher,
  BootstrapFetcherOptions,
  StoreManagerConfig,
} from "./StoreManager";

// Collection runtime objects
export { RefCollection, BackRef, CollectionState } from "./LazyCollection";
export { OwnedRefs } from "./LazyOwnedCollection";

// Transactions
export {
  BaseTransaction,
  UpdateTransaction,
  CreateTransaction,
  DeleteTransaction,
  ArchiveTransaction,
} from "./Transaction";
export type { UndoableAction } from "./Transaction";
export { TransactionQueue } from "./TransactionQueue";
export type {
  TransactionSender,
  BatchResponse,
  UndoableActionHandlers,
  UndoResult,
} from "./TransactionQueue";

// Sync
export { SyncConnection } from "./SyncConnection";
export type {
  SyncAction,
  DeltaPacket,
  SyncMessageTransform,
} from "./SyncConnection";
export { ModelStream } from "./ModelStream";
export type { ModelUpdate, ModelStreamMessageTransform } from "./ModelStream";
