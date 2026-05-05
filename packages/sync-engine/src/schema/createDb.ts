import { action, computed } from "mobx";
import type { BaseModel } from "../core/BaseModel";
import { ModelRegistry } from "../core/ModelRegistry";
import {
  installActionMethod,
  installComputedAccessor,
} from "../core/refAccessors";
import type { StoreManager } from "../core/StoreManager";
import type { UndoResult } from "../core/TransactionQueue";
import { compileSchema } from "./compile";
import type {
  ActionFn,
  ComputedFn,
  ExtensionDescriptor,
  MergedExtensionMembers,
} from "./extend";
import type {
  EntityKey,
  IndexedFieldKeys,
  InferCreateInput,
  InferEntity,
  InferUpdateInput,
} from "./infer";
import type { SchemaDef } from "./types";

/**
 * Curated subset of `BaseModel` lifecycle methods we expose on records so
 * imperative "mutate fields then commit" workflows have a typed path. Keeps
 * the rest of `BaseModel`'s internals (`hydrate`, `serialize`, `assign`,
 * `__mobx`, …) hidden so the public surface stays schema-driven.
 */
export interface RecordCommitInterface {
  /** Flush pending field changes to the transaction queue. */
  save(): void;
  /** True iff there is at least one pending change since the last save. */
  readonly hasUnsavedChanges: boolean;
  /** Drop pending changes and reset to the last-saved values. */
  discardUnsavedChanges(): void;
  /**
   * MobX-tracked subscription. The selector reads any reactive field or
   * derivation on this record; `cb` fires whenever its result changes.
   * Returns an unsubscribe function.
   *
   *     record.watch(r => r.title, (next, prev) => …)
   *
   * Inside React, prefer `useModel` / `useCollection` — they wire the same
   * thing through `useSyncExternalStore`. This is the imperative path.
   */
  watch<T>(
    selector: (record: this) => T,
    cb: (next: T, prev: T) => void,
  ): () => void;
}

export type RecordWithExtensions<
  S extends SchemaDef,
  K extends EntityKey<S>,
  Exts extends readonly ExtensionDescriptor<S>[],
> = InferEntity<S, K> &
  MergedExtensionMembers<S, K, Exts> &
  RecordCommitInterface;

export interface EntityNamespace<
  S extends SchemaDef,
  K extends EntityKey<S>,
  Exts extends readonly ExtensionDescriptor<S>[],
> {
  // ── Reads ────────────────────────────────────────────────────────────────
  // The default read flavor is async: `get` resolves with whatever the engine
  // can supply (pool first, then IDB / network). The `peek` family is the
  // sync escape hatch that returns the pool snapshot only — for code paths
  // that genuinely cannot await (render-time reads, synchronous assertions).

  /**
   * Resolve a single record. Pool-first under the hood, so a hit costs only
   * a microtask; a miss falls back to IDB and (if configured) the on-demand
   * fetcher.
   */
  get(id: string): Promise<RecordWithExtensions<S, K, Exts> | null>;
  /** Resolve many records by id. Pool-first per id; missing ones are loaded together. */
  getByIds(
    ids: readonly string[],
  ): Promise<ReadonlyArray<RecordWithExtensions<S, K, Exts>>>;
  /**
   * Resolve every record matching `value` on a declared `.indexed()` field.
   * The `key` is constrained at the type level to fields actually marked
   * indexed in the schema.
   *
   * `value` is `string` because IDB indexes are string-typed; values from
   * non-string indexed fields (numbers, dates, refIds) need to be stringified
   * the same way the runtime serializes them. Future versions may type the
   * value against the field's TS type once StoreManager.loadCollection
   * accepts non-string values.
   */
  getByIndex(
    key: IndexedFieldKeys<S, K>,
    value: string,
  ): Promise<ReadonlyArray<RecordWithExtensions<S, K, Exts>>>;
  /**
   * Resolve every record of this entity. Hydrates from IDB on first call,
   * relies on partial-index coverage and SSE deltas on subsequent calls.
   */
  getAll(): Promise<ReadonlyArray<RecordWithExtensions<S, K, Exts>>>;

  /**
   * Sync pool snapshot for a single record. Returns `null` if the record
   * isn't currently hydrated — `null` does NOT mean "doesn't exist," it
   * means "not in this microtask's pool." Use `get(id)` if you want the
   * engine to fetch.
   */
  peek(id: string): RecordWithExtensions<S, K, Exts> | null;
  /** Sync pool snapshot of every record currently hydrated for this entity. */
  peekAll(): ReadonlyArray<RecordWithExtensions<S, K, Exts>>;
  /**
   * Sync pool filter: every pooled record where `record[key] === value`.
   * `key` is constrained to fields actually marked `.indexed()` in the
   * schema, mirroring `getByIndex` — querying non-indexed fields here is
   * usually a sign you wanted `getByIndex` (which can fall back to IDB).
   */
  peekByIndex(
    key: IndexedFieldKeys<S, K>,
    value: string,
  ): ReadonlyArray<RecordWithExtensions<S, K, Exts>>;

  // ── Writes ───────────────────────────────────────────────────────────────
  /** Allocate, hydrate, and enqueue a create transaction. */
  create(input: InferCreateInput<S, K>): RecordWithExtensions<S, K, Exts>;
  /**
   * Apply a partial update to a record already in the pool. Throws if no
   * record with `id` is found — to fetch and update lazy-loaded records,
   * `await db.<entity>.get(id)` first.
   */
  update(id: string, input: InferUpdateInput<S, K>): void;
  /** Delete the record with full cascade / restrict semantics. */
  delete(id: string): void;
  /** Soft-delete (archive) the record with full cascade / restrict semantics. */
  archive(id: string): void;
  /**
   * Hydrate records straight into the pool — no transactions enqueued, no
   * IDB writes. Re-seeding an existing id refreshes that instance in place.
   * For tests and stories, not production.
   */
  seed(
    records: ReadonlyArray<Partial<InferCreateInput<S, K>>>,
  ): ReadonlyArray<RecordWithExtensions<S, K, Exts>>;

  // ── Force-fetch ──────────────────────────────────────────────────────────
  /** Force a network re-fetch of the listed ids. */
  refresh(
    ids: readonly string[],
  ): Promise<ReadonlyArray<RecordWithExtensions<S, K, Exts>>>;
  /** Force a network re-fetch of every record of this entity. */
  refreshAll(): Promise<void>;
  /**
   * Force a network re-fetch of every record matching `value` on a declared
   * `.indexed()` field. Evicts the partial-index coverage cache first so the
   * next load is guaranteed to hit the server.
   */
  refreshByIndex(
    key: IndexedFieldKeys<S, K>,
    value: string,
  ): Promise<ReadonlyArray<RecordWithExtensions<S, K, Exts>>>;

  // ── Subscriptions ────────────────────────────────────────────────────────
  /**
   * Subscribe to pool-level changes for this entity. The callback fires
   * payload-less — re-read with `peekAll` / `peekByIndex` / `peek` inside
   * the handler. Returns an unsubscribe function.
   *
   * Inside React, prefer `useModels` — it wires the same primitive through
   * `useSyncExternalStore`. This is the imperative path for headless code.
   */
  watchAll(cb: () => void): () => void;
}

/**
 * Top-level `db` methods that aren't entity namespaces. Kept on a sibling
 * intersection so `Db<S>` stays "one entry per entity key" — the schema
 * compiler reserves these names so an entity can't shadow them.
 *
 * For React, prefer `useUndoRedo()` from `sync-engine/react` — it
 * subscribes to the transaction queue so `canUndo` / `canRedo` are
 * reactive. These methods are the imperative path for non-React
 * consumers (CLI tools, headless agents, tests).
 */
export interface DbTopLevel {
  /**
   * Run `fn` inside a transaction batch. Every `db.<entity>.create / update /
   * delete` call inside shares a single `batchId`, ships in one HTTP POST,
   * and reverses as one unit on undo. Returns the `batchId`.
   *
   * Accepts both sync and async functions — `endBatch` always fires after
   * the function (or its returned Promise) completes, even on throw.
   *
   * The async overload is declared first so an `async () => {}` literal
   * picks it; a sync `() => {}` returns `void` which can't satisfy
   * `Promise<void>`, so it falls through to the sync overload.
   */
  batch(fn: () => Promise<void>): Promise<string>;
  batch(fn: () => void): string;
  /** Pop and revert the top of the undo stack. */
  undo(): Promise<UndoResult | null>;
  /** Re-apply the top of the redo stack. */
  redo(): Promise<UndoResult | null>;
  /** Number of entries currently on the undo stack. */
  readonly undoDepth: number;
  /** Number of entries currently on the redo stack. */
  readonly redoDepth: number;
  /**
   * Run a remote side-effect that returns a `changeLogId`, recording it on
   * the undo stack so the next `db.undo()` invokes the
   * `undoableActions.undo` handler with that id. `fn` may return either the
   * `changeLogId` directly or any object carrying one. Inside an open
   * `db.batch(...)`, the action joins the batch.
   */
  runUndoable<T extends string | { changeLogId: string }>(
    fn: () => Promise<T> | T,
    opts?: { actionType?: string; metadata?: Record<string, unknown> },
  ): Promise<T>;
}

export type Db<
  S extends SchemaDef,
  Exts extends readonly ExtensionDescriptor<S>[] = readonly [],
> = {
  [K in EntityKey<S>]: EntityNamespace<S, K, Exts>;
} & DbTopLevel;

interface ExtensionBucket {
  computed: Record<string, ComputedFn<SchemaDef, string>>;
  actions: Record<string, ActionFn<SchemaDef, string>>;
}

/**
 * Project a `SchemaDef` over a live `StoreManager`. The runtime values are
 * `BaseModel` instances that structurally satisfy the inferred record type;
 * the proxy-based public surface described in the RFC lands later.
 */
export function createDb<
  S extends SchemaDef,
  const Exts extends readonly ExtensionDescriptor<S>[] = readonly [],
>(opts: {
  schema: S;
  storeManager: StoreManager;
  extensions?: Exts;
}): Db<S, Exts> {
  const compiled = compileSchema(opts.schema);
  const sm = opts.storeManager;
  const merged = mergeExtensions(opts.extensions);

  for (const [entityKey, registryName] of compiled.nameByKey) {
    const defs = merged.get(entityKey);
    if (defs == null) {
      continue;
    }
    applyExtension(registryName, defs, sm);
  }

  const db: Record<string, unknown> = {
    batch: sm.batch.bind(sm) as DbTopLevel["batch"],
    undo: () => sm.undo(),
    redo: () => sm.redo(),
    get undoDepth() {
      return sm.transactionQueue.undoDepth;
    },
    get redoDepth() {
      return sm.transactionQueue.redoDepth;
    },
    // Dynamic delegate (not `.bind(sm)`) so test-time `vi.spyOn(sm, "runUndoable")`
    // intercepts calls. `bind` would capture the original at construction time.
    runUndoable: ((fn, opts) =>
      sm.runUndoable(fn, opts)) as DbTopLevel["runUndoable"],
  };
  for (const [entityKey, registryName] of compiled.nameByKey) {
    db[entityKey] = createEntityNamespace(registryName, sm);
  }
  return db as Db<S, Exts>;
}

function mergeExtensions<S extends SchemaDef>(
  extensions: readonly ExtensionDescriptor<S>[] | undefined,
): Map<string, ExtensionBucket> {
  const out = new Map<string, ExtensionBucket>();
  if (extensions == null) {
    return out;
  }
  for (const ext of extensions) {
    for (const [entityKey, defs] of Object.entries(ext.byEntity)) {
      if (defs == null) {
        continue;
      }
      let bucket = out.get(entityKey);
      if (bucket == null) {
        bucket = { computed: {}, actions: {} };
        out.set(entityKey, bucket);
      }
      Object.assign(bucket.computed, defs.computed);
      Object.assign(bucket.actions, defs.actions);
    }
  }
  return out;
}

function applyExtension(
  registryName: string,
  defs: ExtensionBucket,
  sm: StoreManager,
): void {
  const meta = ModelRegistry.getModelMeta(registryName);
  if (meta == null) {
    return;
  }
  const prototype = meta.ctor.prototype as object;

  for (const [name, fn] of Object.entries(defs.computed)) {
    installComputedAccessor(prototype, name, fn as (record: object) => unknown);
    meta.computedProps.add(name);
    rebindComputedInstances(sm, registryName, name);
  }
  for (const [name, fn] of Object.entries(defs.actions)) {
    installActionMethod(
      prototype,
      name,
      fn as (record: object, ...args: never[]) => unknown,
    );
    meta.actions.add(name);
    rebindActionInstances(sm, registryName, name);
  }
}

function rebindComputedInstances(
  sm: StoreManager,
  registryName: string,
  name: string,
): void {
  for (const instance of sm.objectPool.getAll(registryName)) {
    const descriptor = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(instance),
      name,
    );
    if (descriptor?.get == null) {
      continue;
    }
    const fn: () => unknown = descriptor.get.bind(instance);
    const memo = computed(fn);
    Object.defineProperty(instance, name, {
      get: () => memo.get(),
      configurable: true,
    });
  }
}
function rebindActionInstances(
  sm: StoreManager,
  registryName: string,
  name: string,
): void {
  for (const instance of sm.objectPool.getAll(registryName)) {
    const method = (Object.getPrototypeOf(instance) as Record<string, unknown>)[
      name
    ];
    if (typeof method !== "function") {
      continue;
    }
    Object.defineProperty(instance, name, {
      configurable: true,
      writable: true,
      value: action(method.bind(instance)),
    });
  }
}

function createEntityNamespace(
  registryName: string,
  sm: StoreManager,
): EntityNamespace<
  SchemaDef,
  string,
  readonly ExtensionDescriptor<SchemaDef>[]
> {
  const meta = ModelRegistry.getModelMeta(registryName);
  if (meta == null) {
    throw new Error(
      `createDb: model "${registryName}" is not in ModelRegistry. ` +
        `Did the schema fail to compile?`,
    );
  }
  const Ctor = meta.ctor;
  type Rec = RecordWithExtensions<
    SchemaDef,
    string,
    readonly ExtensionDescriptor<SchemaDef>[]
  >;
  const toRecord = (model: BaseModel): Rec => model as unknown as Rec;

  const recordsFrom = (
    list: readonly BaseModel[],
  ): ReadonlyArray<Rec> => list.map(toRecord);

  return {
    peek(id) {
      const model = sm.objectPool.getById(registryName, id);
      return model == null ? null : toRecord(model);
    },
    peekAll() {
      return recordsFrom(sm.objectPool.getAll(registryName));
    },
    peekByIndex(key, value) {
      return recordsFrom(sm.peekByIndex(registryName, key, value));
    },
    async get(id) {
      const model = await sm.loadOne(registryName, id);
      return model == null ? null : toRecord(model);
    },
    async getByIds(ids) {
      const list = await sm.loadByIds(registryName, [...ids]);
      return recordsFrom(list);
    },
    async getByIndex(key, value) {
      const list = await sm.loadCollection(registryName, key, value);
      return recordsFrom(list);
    },
    async getAll() {
      const list = await sm.getOrLoadAll(registryName);
      return recordsFrom(list);
    },
    create(input) {
      const instance = new Ctor();
      // BaseModel.update routes through hydrate+save when store is null,
      // which fires commitCreate via BaseModel.storeManager.
      instance.update(input);
      return toRecord(instance);
    },
    update(id, input) {
      const model = requireInstance(sm, registryName, id, "update");
      model.update(input);
    },
    delete(id) {
      const model = requireInstance(sm, registryName, id, "delete");
      sm.deleteModel(model);
    },
    archive(id) {
      const model = requireInstance(sm, registryName, id, "archive");
      sm.archiveModel(model);
    },
    seed(records) {
      const seeded = sm.seed(
        registryName,
        records as Record<string, unknown>[],
      );
      return seeded.map(toRecord);
    },
    async refresh(ids) {
      const list = await sm.refreshModels(registryName, [...ids]);
      return recordsFrom(list);
    },
    async refreshAll() {
      await sm.refreshAllOfModel(registryName);
    },
    async refreshByIndex(key, value) {
      // Delegates to StoreManager.refreshCollection which diffs previous vs
      // fresh ids — server-removed records leave the pool, surviving
      // instances are updated in place so held references stay valid.
      const list = await sm.refreshCollection(registryName, key, value);
      return recordsFrom(list);
    },
    watchAll(cb) {
      return sm.objectPool.subscribe(registryName, cb);
    },
  };
}

function requireInstance(
  sm: StoreManager,
  registryName: string,
  id: string,
  action: "update" | "delete" | "archive",
): BaseModel {
  const model = sm.objectPool.getById(registryName, id);
  if (model == null) {
    throw new Error(
      `createDb.${registryName}.${action}: no record with id "${id}" in the pool.`,
    );
  }
  return model;
}
