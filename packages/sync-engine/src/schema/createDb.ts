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
  InferCreateInput,
  InferEntity,
  InferUpdateInput,
} from "./infer";
import type { SchemaDef } from "./types";

export type RecordWithExtensions<
  S extends SchemaDef,
  K extends EntityKey<S>,
  Exts extends readonly ExtensionDescriptor<S>[],
> = InferEntity<S, K> & MergedExtensionMembers<S, K, Exts>;

export interface EntityNamespace<
  S extends SchemaDef,
  K extends EntityKey<S>,
  Exts extends readonly ExtensionDescriptor<S>[],
> {
  /** Read a record from the in-memory pool by id. */
  findById(id: string): RecordWithExtensions<S, K, Exts> | null;
  /** Allocate, hydrate, and enqueue a create transaction. */
  create(input: InferCreateInput<S, K>): RecordWithExtensions<S, K, Exts>;
  /**
   * Apply a partial update to a record already in the pool. Throws if no
   * record with `id` is found — V1 makes no attempt to lazy-load.
   */
  update(id: string, input: InferUpdateInput<S, K>): void;
  /** Delete the record with full cascade / restrict semantics. */
  delete(id: string): void;
  /**
   * Hydrate records straight into the pool — no transactions enqueued, no
   * IDB writes. Re-seeding an existing id refreshes that instance in place.
   * For tests and stories, not production.
   */
  seed(
    records: ReadonlyArray<Partial<InferCreateInput<S, K>>>,
  ): ReadonlyArray<RecordWithExtensions<S, K, Exts>>;
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
   */
  batch(fn: () => void): string;
  batch(fn: () => Promise<void>): Promise<string>;
  /** Pop and revert the top of the undo stack. */
  undo(): Promise<UndoResult | null>;
  /** Re-apply the top of the redo stack. */
  redo(): Promise<UndoResult | null>;
  /** Number of entries currently on the undo stack. */
  readonly undoDepth: number;
  /** Number of entries currently on the redo stack. */
  readonly redoDepth: number;
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
    applyExtension(registryName, defs);
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

function applyExtension(registryName: string, defs: ExtensionBucket): void {
  const meta = ModelRegistry.getModelMeta(registryName);
  if (meta == null) {
    return;
  }
  const prototype = meta.ctor.prototype as object;

  // Idempotent: createDb may run more than once per app (tests, hot reload).
  // The synthetic prototype is shared, so we only install each accessor once
  // and rely on `meta.computedProps` / `meta.actions` as the canonical record
  // of what's already wired.
  for (const [name, fn] of Object.entries(defs.computed)) {
    if (meta.computedProps.has(name)) {
      continue;
    }
    installComputedAccessor(prototype, name, fn as (record: object) => unknown);
    meta.computedProps.add(name);
  }
  for (const [name, fn] of Object.entries(defs.actions)) {
    if (meta.actions.has(name)) {
      continue;
    }
    installActionMethod(
      prototype,
      name,
      fn as (record: object, ...args: never[]) => unknown,
    );
    meta.actions.add(name);
  }
}

function createEntityNamespace(
  registryName: string,
  sm: StoreManager,
): EntityNamespace<SchemaDef, string, readonly ExtensionDescriptor<SchemaDef>[]> {
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

  return {
    findById(id) {
      const model = sm.objectPool.getById(registryName, id);
      return model == null ? null : toRecord(model);
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
    seed(records) {
      const seeded = sm.seed(
        registryName,
        records as Record<string, unknown>[],
      );
      return seeded.map(toRecord);
    },
  };
}

function requireInstance(
  sm: StoreManager,
  registryName: string,
  id: string,
  action: "update" | "delete",
): BaseModel {
  const model = sm.objectPool.getById(registryName, id);
  if (model == null) {
    throw new Error(
      `createDb.${registryName}.${action}: no record with id "${id}" in the pool.`,
    );
  }
  return model;
}
