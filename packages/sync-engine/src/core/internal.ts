/**
 * `sync-engine/internal` — engine internals with NO stability promise.
 *
 * These are the runtime machinery the curated `sync-engine` entry point
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

export { ObjectPool } from "./ObjectPool";
export { Database } from "./Database";
export { ModelRegistry } from "./ModelRegistry";
export { defineObservableProperty } from "./observability";

export { FullStore, PartialStore, ModelStore } from "./Store";

export {
  BaseTransaction,
  UpdateTransaction,
  CreateTransaction,
  DeleteTransaction,
  ArchiveTransaction,
} from "./Transaction";
export { TransactionQueue } from "./TransactionQueue";

export { SyncConnection } from "./SyncConnection";
export { ModelStream } from "./ModelStream";

export { normalizeConfig } from "./StoreManager";
export type { NormalizedConfig } from "./StoreManager";

export type {
  IObjectPool,
  IStoreManager,
  CoveringPath,
} from "./types";
export { DEFAULT_TRANSIENT_INDEX_DEPTH, toError } from "./types";
