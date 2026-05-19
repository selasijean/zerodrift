/**
 * `zerodrift/internal` — engine internals with NO stability promise.
 *
 * These are the runtime machinery the curated `zerodrift` entry point
 * deliberately hides: the pool, storage, transaction queue/objects, the SSE
 * connection/stream, the per-strategy stores, the model registry, and the
 * config normalizer. They are exported only for tooling, tests, and the rare
 * adopter that genuinely needs to reach under the engine (e.g. a devtool
 * walking `ModelRegistry`, or a test driving `ObjectPool` directly).
 *
 * Anything here may change shape or vanish between releases without a major
 * bump. If you find yourself importing from here in app code, that's usually
 * a sign the curated surface is missing something — open an issue.
 */

export { ObjectPool } from "./ObjectPool.js";
export { Database } from "./Database.js";
export { ModelRegistry } from "./ModelRegistry.js";
export { defineObservableProperty } from "./observability.js";

export { FullStore, PartialStore, ModelStore } from "./Store.js";

export {
  BaseTransaction,
  UpdateTransaction,
  CreateTransaction,
  DeleteTransaction,
  ArchiveTransaction,
} from "./Transaction.js";
export { TransactionQueue } from "./TransactionQueue.js";

export { SyncConnection } from "./SyncConnection.js";
export { ModelStream } from "./ModelStream.js";

export { normalizeConfig } from "./StoreManager.js";
export type { NormalizedConfig } from "./StoreManager.js";

export type {
  IObjectPool,
  IStoreManager,
  CoveringPath,
} from "./types.js";
export { DEFAULT_TRANSIENT_INDEX_DEPTH, toError } from "./types.js";
