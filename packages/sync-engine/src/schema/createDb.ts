import type { BaseModel } from "../core/BaseModel";
import { ModelRegistry } from "../core/ModelRegistry";
import type { StoreManager } from "../core/StoreManager";
import { compileSchema } from "./compile";
import type {
  EntityKey,
  InferCreateInput,
  InferEntity,
  InferUpdateInput,
} from "./infer";
import type { SchemaDef } from "./types";

export interface EntityNamespace<
  S extends SchemaDef,
  K extends EntityKey<S>,
> {
  /** Read a record from the in-memory pool by id. */
  findById(id: string): InferEntity<S, K> | null;
  /** Allocate, hydrate, and enqueue a create transaction. */
  create(input: InferCreateInput<S, K>): InferEntity<S, K>;
  /**
   * Apply a partial update to a record already in the pool.
   * Throws if no record with `id` is found — V1 makes no attempt to
   * lazy-load. The typed client will grow `getOrLoad`-style helpers in a
   * follow-up phase if needed.
   */
  update(id: string, input: InferUpdateInput<S, K>): void;
  /** Delete the record with full cascade / restrict semantics. */
  delete(id: string): void;
}

export type Db<S extends SchemaDef> = {
  [K in EntityKey<S>]: EntityNamespace<S, K>;
};

/**
 * Project a `SchemaDef` over a live `StoreManager`. Compiles the schema (a
 * no-op when already compiled) and returns a typed namespace per entity key:
 *
 *     const db = createDb({ schema, storeManager });
 *     const issue = db.issue.findById("issue-1");
 *     await db.issue.create({ title: "Fix bug", teamId: "team-1" });
 *
 * The runtime values are `BaseModel` instances that structurally satisfy the
 * inferred record type. The proxy-based public surface described in the RFC
 * lands in a later phase; V1 returns the underlying instances directly.
 */
export function createDb<S extends SchemaDef>(opts: {
  schema: S;
  storeManager: StoreManager;
}): Db<S> {
  const compiled = compileSchema(opts.schema);
  const sm = opts.storeManager;
  const db: Record<string, EntityNamespace<SchemaDef, string>> = {};
  for (const [entityKey, registryName] of compiled.nameByKey) {
    db[entityKey] = createEntityNamespace(registryName, sm);
  }
  return db as Db<S>;
}

function createEntityNamespace(
  registryName: string,
  sm: StoreManager,
): EntityNamespace<SchemaDef, string> {
  const meta = ModelRegistry.getModelMeta(registryName);
  if (meta == null) {
    throw new Error(
      `createDb: model "${registryName}" is not in ModelRegistry. ` +
        `Did the schema fail to compile?`,
    );
  }
  const Ctor = meta.ctor;

  return {
    findById(id) {
      const model = sm.objectPool.getById(registryName, id);
      return (model ?? null) as InferEntity<SchemaDef, string> | null;
    },
    create(input) {
      const instance = new Ctor();
      // BaseModel.update routes through hydrate+save when store is null,
      // which fires commitCreate via BaseModel.storeManager.
      (instance as BaseModel).update(input as Record<string, unknown>);
      return instance as unknown as InferEntity<SchemaDef, string>;
    },
    update(id, input) {
      const model = requireInstance(sm, registryName, id, "update");
      model.update(input as Record<string, unknown>);
    },
    delete(id) {
      const model = requireInstance(sm, registryName, id, "delete");
      sm.deleteModel(model);
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
