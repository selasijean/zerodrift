import { action, computed } from "mobx";
import type { BaseModel } from "../core/BaseModel.js";
import { ModelRegistry } from "../core/ModelRegistry.js";
import { prop } from "../core/ObjectPool.js";
import {
  installActionMethod,
  installComputedAccessor,
} from "../core/refAccessors.js";
import type { StoreManager } from "../core/StoreManager.js";
import type { UndoResult } from "../core/TransactionQueue.js";
import { compileSchema } from "./compile.js";
import type {
  ActionFn,
  ComputedFn,
  ExtensionDescriptor,
  MergedExtensionMembers,
} from "./extend.js";
import type {
  EntityKey,
  IndexedFieldKeys,
  InferCreateInput,
  InferEntity,
  InferUpdateInput,
} from "./infer.js";
import type { SchemaDef } from "./types.js";

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
   * This is the imperative path — inside React, `useWatch(record, selector)`
   * is this hook's counterpart (and compiler-safe); `useRecord` /
   * `useRelation` cover record lookup and membership.
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
   * value against the field's TS type once StoreManager.getOrLoadCollection
   * accepts non-string values.
   */
  getByIndex(
    key: IndexedFieldKeys<S, K>,
    value: string,
  ): Promise<ReadonlyArray<RecordWithExtensions<S, K, Exts>>>;
  /**
   * Resolve every record matching any of `values` on a declared `.indexed()`
   * field. Fans out one `getByIndex` call per value in parallel; the pool
   * dedupes if records appear in multiple buckets. Records are returned in
   * input-`values` order, with duplicates collapsed to first occurrence.
   *
   * If your backend supports compound index queries, opt in via
   * `serverSupportsCompoundIndexKeys: true` + `onDemandIndexBatchFetcher` to
   * collapse the fan-out into one server round-trip when the values share a
   * parent FK. See `agent-docs/04-lazy-loading.md`.
   */
  getByIndexValues(
    key: IndexedFieldKeys<S, K>,
    values: readonly string[],
  ): Promise<ReadonlyArray<RecordWithExtensions<S, K, Exts>>>;
  /**
   * Resolve every record of this entity. Hydrates from IDB on first call,
   * relies on partial-index coverage and SSE deltas on subsequent calls.
   */
  getAll(): Promise<ReadonlyArray<RecordWithExtensions<S, K, Exts>>>;

  /**
   * Sync pool snapshot for a single record. Returns `undefined` if the
   * record isn't currently hydrated — `undefined` means "not in this
   * microtask's pool," **not** "doesn't exist." (Mirrors
   * `objectPool.getById`; distinct from `get`, which resolves `null` only
   * after a fetch confirms absence.) Use `get(id)` to fetch, or `has(id)`
   * for a boolean membership check.
   */
  peek(id: string): RecordWithExtensions<S, K, Exts> | undefined;
  /** Sync: is this record currently hydrated in the pool? Pairs with `peek`
   * for code that only needs presence, not the record. */
  has(id: string): boolean;
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
  // Commit model: `create` / `patch` / `delete` / `archive` commit at the
  // current transaction boundary (standalone, or folded into an open
  // `store.batch(...)` / `store.atomic(...)`). `draft(...)` is the only
  // staged path — mutate the returned record, then `save()` to commit or
  // `discardUnsavedChanges()` to roll back. Nothing both stages and commits.

  /**
   * Create a record and commit it at the current boundary. Returns the live
   * record (already in the pool, transaction enqueued). For a record you
   * want to build up before committing — e.g. a "create on submit, abandon
   * on cancel" form — use `draft(input)` instead.
   */
  create(input: InferCreateInput<S, K>): RecordWithExtensions<S, K, Exts>;
  /**
   * Apply a partial field update and commit it at the current boundary.
   * Returns the record so callers can chain. Throws if no record with `id`
   * is in the pool — to patch a lazy-loaded record, `await get(id)` (or use
   * `draft(id)`) first.
   */
  patch(
    id: string,
    fields: InferUpdateInput<S, K>,
  ): RecordWithExtensions<S, K, Exts>;
  /**
   * Open a staged editing buffer. Nothing is committed until the returned
   * record's `save()` runs (or an enclosing `batch`/`atomic` flushes it);
   * `discardUnsavedChanges()` rolls back.
   *
   * - `draft(id)` — resolves the existing record (pool → IDB → on-demand,
   *   same as `get`) and hands it back in staging mode. Async. Rejects if
   *   no record with `id` exists.
   * - `draft(input?)` — a brand-new uncommitted record with its `id` minted
   *   up front (so relations can point at it). Sync. Abandoning it without
   *   `save()` leaves nothing behind.
   */
  draft(id: string): Promise<RecordWithExtensions<S, K, Exts>>;
  draft(
    input?: Partial<InferCreateInput<S, K>>,
  ): RecordWithExtensions<S, K, Exts>;
  /** Delete the record with full cascade / restrict semantics. Commits at
   * the current boundary. */
  delete(id: string): void;
  /** Soft-delete (archive) the record with full cascade / restrict
   * semantics. Commits at the current boundary. */
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
   * Inside React, prefer `useRecords` — it wires the same primitive through
   * `useSyncExternalStore`. This is the imperative path for headless code.
   */
  watchAll(cb: () => void): () => void;
  /**
   * Subscribe to pool-level changes filtered by `record[key] === value`.
   * The pool runs the predicate at write-time and only invokes `cb` when a
   * matching record was added or removed. Cheaper than `watchAll` followed
   * by an in-handler `peekByIndex` filter.
   *
   * Caveat: this fires on **set-membership changes**, not field
   * reassignments. A record moving between buckets via a setter
   * (`record[key] = newValue`) goes through MobX boxes, not pool notify —
   * pair with `record.watch(r => r[key], cb)` if you need that case too.
   */
  watchByIndex(
    key: IndexedFieldKeys<S, K>,
    value: string,
    cb: () => void,
  ): () => void;
}

/**
 * Top-level `store` methods that aren't entity namespaces. Kept on a sibling
 * intersection so `EntityStore<S>` stays "one entry per entity key" — the schema
 * compiler reserves these names so an entity can't shadow them.
 *
 * For React, prefer `useUndoRedo()` from `zerodrift/react` — it
 * subscribes to the transaction queue so `canUndo` / `canRedo` are
 * reactive. These methods are the imperative path for non-React
 * consumers (CLI tools, headless agents, tests).
 */
export interface StoreApi {
  /**
   * Run `fn` inside a transaction batch. Every `store.<entity>.create / update /
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
  /**
   * Stage optimistic edits with all-or-nothing local commit semantics.
   * Every model touched inside `fn` is `save()`d on success (in one batch
   * → one undo entry) or `discardUnsavedChanges()`d on throw. See
   * `StoreManager.atomic` for the full contract (SSE rebasing during
   * await, runUndoable side effects, no nesting).
   */
  atomic<T>(fn: () => Promise<T>): Promise<T>;
  atomic<T>(fn: () => T): T;
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
   * the undo stack so the next `store.undo()` invokes the
   * `undoableActions.undo` handler with that id. `fn` may return either the
   * `changeLogId` directly or any object carrying one. Inside an open
   * `store.batch(...)`, the action joins the batch.
   */
  runUndoable<T extends string | { changeLogId: string }>(
    fn: () => Promise<T> | T,
    opts?: { actionType?: string; metadata?: Record<string, unknown> },
  ): Promise<T>;
}

export type EntityStore<
  S extends SchemaDef,
  Exts extends readonly ExtensionDescriptor<S>[] = readonly [],
> = {
  [K in EntityKey<S>]: EntityNamespace<S, K, Exts>;
} & StoreApi;

interface ExtensionBucket {
  computed: Record<string, ComputedFn<SchemaDef, string>>;
  actions: Record<string, ActionFn<SchemaDef, string>>;
}

/**
 * Project a `SchemaDef` over a live `StoreManager`. The runtime values are
 * `BaseModel` instances that structurally satisfy the inferred record type;
 * the proxy-based public surface described in the RFC lands later.
 */
export function createStore<
  S extends SchemaDef,
  const Exts extends readonly ExtensionDescriptor<S>[] = readonly [],
>(opts: {
  schema: S;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  storeManager: StoreManager<any>;
  extensions?: Exts;
}): EntityStore<S, Exts> {
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

  const store: Record<string, unknown> = {
    batch: sm.batch.bind(sm) as StoreApi["batch"],
    atomic: sm.atomic.bind(sm) as StoreApi["atomic"],
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
      sm.runUndoable(fn, opts)) as StoreApi["runUndoable"],
  };
  for (const [entityKey, registryName] of compiled.nameByKey) {
    store[entityKey] = createEntityNamespace(registryName, sm);
  }
  return store as EntityStore<S, Exts>;
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
      `createStore: model "${registryName}" is not in ModelRegistry. ` +
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

  // Overloaded so the union return type doesn't break the structural check
  // on `return ns` (a single union-typed member isn't assignable to the
  // overloaded interface signature; per-overload declarations are).
  function draft(id: string): Promise<Rec>;
  function draft(input?: Record<string, unknown>): Rec;
  function draft(arg?: string | Record<string, unknown>): Promise<Rec> | Rec {
    if (typeof arg === "string") {
      return sm.getOrLoadById(registryName, arg).then((model) => {
        if (model == null) {
          throw noRecordError(registryName, "draft", arg);
        }
        return toRecord(model);
      });
    }
    const instance = new Ctor();
    if (arg != null) {
      instance.hydrate(arg);
    }
    // Make it observable now (still store===null, not pooled) so fields set
    // between `draft(input)` and `save()` route through the property setter,
    // not a shadowing own-property that makeModelObservable would later
    // discard for the hydrated __raw_ value. Trade-off: a non-lazy
    // @Reference / @ReferenceCollection eager-loads at draft() time rather
    // than save() time (same load surface as create, earlier).
    instance.makeModelObservable();
    return toRecord(instance);
  }

  const ns: EntityNamespace<
    SchemaDef,
    string,
    readonly ExtensionDescriptor<SchemaDef>[]
  > = {
    peek(id) {
      const model = sm.objectPool.getById(registryName, id);
      return model == null ? undefined : toRecord(model);
    },
    has(id) {
      return sm.objectPool.getById(registryName, id) != null;
    },
    peekAll() {
      return recordsFrom(sm.objectPool.getAll(registryName));
    },
    peekByIndex(key, value) {
      return recordsFrom(sm.peekByIndex(registryName, key, value));
    },
    async get(id) {
      const model = await sm.getOrLoadById(registryName, id);
      return model == null ? null : toRecord(model);
    },
    async getByIds(ids) {
      const list = await sm.getOrLoadByIds(registryName, [...ids]);
      return recordsFrom(list);
    },
    async getByIndex(key, value) {
      const list = await sm.getOrLoadCollection(registryName, key, value);
      return recordsFrom(list);
    },
    async getByIndexValues(key, values) {
      // Fan out in parallel; getOrLoadCollection is a no-op for already-covered
      // (key, value) pairs, so re-firing for stale buckets is cheap.
      await Promise.all(
        values.map((v) => sm.getOrLoadCollection(registryName, key, v)),
      );
      // After every bucket is loaded, walk the pool once per value to
      // preserve input order, deduping records that match multiple values.
      const seen = new Set<string>();
      const out: BaseModel[] = [];
      for (const v of values) {
        for (const m of sm.peekByIndex(registryName, key, v)) {
          if (!seen.has(m.id)) {
            seen.add(m.id);
            out.push(m);
          }
        }
      }
      return recordsFrom(out);
    },
    async getAll() {
      const list = await sm.getOrLoadAll(registryName);
      return recordsFrom(list);
    },
    create(input) {
      // store===null on a fresh instance, so commitCreate (not assign+save)
      // is the create path; it folds into an open batch/atomic via the queue.
      const instance = new Ctor();
      instance.hydrate(input as Record<string, unknown>);
      sm.commitCreate(instance);
      return toRecord(instance);
    },
    patch(id, fields) {
      const model = requireInstance(sm, registryName, id, "patch");
      model.assign(fields as Record<string, unknown>);
      model.save();
      return toRecord(model);
    },
    delete(id) {
      const model = requireInstance(sm, registryName, id, "delete");
      sm.deleteModel(model);
    },
    archive(id) {
      const model = requireInstance(sm, registryName, id, "archive");
      sm.archiveModel(model);
    },
    draft,
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
    watchByIndex(key, value, cb) {
      return sm.objectPool.subscribe(
        registryName,
        (m) => prop(m, key) === value,
        cb,
      );
    },
  };
  // Stash the registry name on the namespace so the typed React hooks can
  // recover it without forcing every callsite to repeat the string. Hidden
  // from enumeration so it doesn't leak into JSON serialization or hover
  // tooltips on the public surface.
  Object.defineProperty(ns, REGISTRY_NAME, {
    value: registryName,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return ns;
}

/** @internal Symbol carrying the ModelRegistry name on each namespace. */
export const REGISTRY_NAME: unique symbol = Symbol("syncEngine/registryName");

/** @internal Read the registry name a namespace was built for. */
export function entityNamespaceRegistryName(
  ns: EntityNamespace<SchemaDef, string, readonly ExtensionDescriptor<SchemaDef>[]>,
): string {
  return (ns as unknown as { [REGISTRY_NAME]: string })[REGISTRY_NAME];
}

/** Shared "namespace write referenced a missing record" error. `scope`
 * qualifies where we looked — pool-only (`requireInstance`) vs. fully
 * resolved (`draft(id)` via getOrLoadById). */
function noRecordError(
  registryName: string,
  action: string,
  id: string,
  scope = "",
): Error {
  return new Error(
    `createStore.${registryName}.${action}: no record with id "${id}"${scope}.`,
  );
}

function requireInstance(
  sm: StoreManager,
  registryName: string,
  id: string,
  action: "patch" | "delete" | "archive",
): BaseModel {
  const model = sm.objectPool.getById(registryName, id);
  if (model == null) {
    throw noRecordError(registryName, action, id, " in the pool");
  }
  return model;
}
