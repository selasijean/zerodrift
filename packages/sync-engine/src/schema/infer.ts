import type { EntityDef, FieldBuilder, FieldMeta, SchemaDef } from "./types";

type FieldType<F> = F extends FieldBuilder<infer T, FieldMeta> ? T : never;

type FieldIsNullable<F> = null extends FieldType<F> ? true : false;

type FieldIsIndexed<F> = F extends FieldBuilder<unknown, infer M>
  ? M extends { indexed: true }
    ? true
    : false
  : false;

export type EntityKey<S extends SchemaDef> = keyof S["entities"] & string;

/**
 * Field keys on an entity that were declared with `.indexed()`. Used to
 * constrain `store.<entity>.loadByIndex(key, value)` so callers can only pass
 * indexes that actually exist on disk.
 */
export type IndexedFieldKeys<
  S extends SchemaDef,
  K extends EntityKey<S>,
> = {
  [P in keyof EntityFieldsRecord<S, K>]: FieldIsIndexed<
    EntityFieldsRecord<S, K>[P]
  > extends true
    ? P
    : never;
}[keyof EntityFieldsRecord<S, K>] &
  string;

type EntityFieldsRecord<
  S extends SchemaDef,
  K extends EntityKey<S>,
> = S["entities"][K] extends EntityDef<infer F> ? F : never;

/**
 * Stub shape for the reactive lazy-collection wrapper that today's
 * `RefCollection` / `BackRef` runtime classes return. The schema-typed
 * record can't extend `BaseModel` without coupling the type wall the
 * proxy is meant to abstract, so we expose a narrow interface here and
 * project `RefCollection` onto it when the typed client lands (Phase 3).
 */
export interface RelationCollection<T> {
  load(): Promise<readonly T[]>;
  readonly items: readonly T[];
  /**
   * Fires whenever the collection's items list changes (records added,
   * removed, or replaced). Payload-less — re-read `items` inside `cb`.
   * Returns an unsubscribe function. Same verb as `record.watch` /
   * `store.<entity>.watchAll`.
   */
  watch(cb: () => void): () => void;
}

type EntityFieldTypes<S extends SchemaDef, K extends EntityKey<S>> = {
  -readonly [P in keyof EntityFieldsRecord<S, K>]: FieldType<
    EntityFieldsRecord<S, K>[P]
  >;
};

type SingularRelationKey<
  S extends SchemaDef,
  K extends EntityKey<S>,
  LK extends keyof S["links"],
> = S["links"][LK] extends {
  from: { entity: K; as: infer A extends string };
}
  ? A
  : never;

type SingularRelationValue<
  S extends SchemaDef,
  K extends EntityKey<S>,
  LK extends keyof S["links"],
> = S["links"][LK] extends {
  from: { entity: K; field: infer FFK };
  to: { entity: infer TE extends string };
}
  ? TE extends EntityKey<S>
    ? FFK extends keyof EntityFieldsRecord<S, K>
      ? FieldIsNullable<EntityFieldsRecord<S, K>[FFK]> extends true
        ? InferEntity<S, TE> | null
        : InferEntity<S, TE>
      : never
    : never
  : never;

type SingularRelations<S extends SchemaDef, K extends EntityKey<S>> = {
  [LK in keyof S["links"] as SingularRelationKey<
    S,
    K,
    LK
  >]: SingularRelationValue<S, K, LK>;
};

type ReverseCollectionKey<
  S extends SchemaDef,
  K extends EntityKey<S>,
  LK extends keyof S["links"],
> = S["links"][LK] extends {
  to: { entity: K; many: infer M extends string };
}
  ? M
  : never;

type ReverseCollectionValue<
  S extends SchemaDef,
  LK extends keyof S["links"],
> = S["links"][LK] extends { from: { entity: infer FE extends string } }
  ? FE extends EntityKey<S>
    ? RelationCollection<InferEntity<S, FE>>
    : never
  : never;

type ReverseCollections<S extends SchemaDef, K extends EntityKey<S>> = {
  [LK in keyof S["links"] as ReverseCollectionKey<
    S,
    K,
    LK
  >]: ReverseCollectionValue<S, LK>;
};

/**
 * The record shape for a schema entity: declared fields, plus singular
 * relation properties for every link that originates on this entity, plus
 * reverse-collection properties for every link that targets it.
 *
 * Does not include extension members (computed / actions) — those are layered
 * in by `InferRecord` once `extend(...)` lands.
 *
 * Returned as a plain intersection — wrapping in a `Prettify` mapped type
 * would force TS to materialize a fresh object per relation step every time
 * `InferEntity` recurses through a link. Users can pretty their own aliases
 * with a one-line helper at the call site if they want.
 */
export type InferEntity<S extends SchemaDef, K extends EntityKey<S>> =
  EntityFieldTypes<S, K> & SingularRelations<S, K> & ReverseCollections<S, K>;

/**
 * A create-input field is optional when the runtime can fill it without
 * the caller: id-kind (BaseModel auto-assigns a UUID), defaulted fields,
 * and schema fields explicitly marked optional (e.g. via Zod's `.optional()`).
 */
type IsOptionalCreateField<F> = F extends FieldBuilder<unknown, infer M>
  ? M extends { kind: "id" } | { default: unknown }
    ? true
    : M extends { optional: true }
      ? true
      : false
  : false;

export type InferCreateInput<S extends SchemaDef, K extends EntityKey<S>> = {
  [P in keyof EntityFieldsRecord<S, K> as IsOptionalCreateField<
    EntityFieldsRecord<S, K>[P]
  > extends true
    ? never
    : P]: FieldType<EntityFieldsRecord<S, K>[P]>;
} & {
  [P in keyof EntityFieldsRecord<S, K> as IsOptionalCreateField<
    EntityFieldsRecord<S, K>[P]
  > extends true
    ? P
    : never]?: FieldType<EntityFieldsRecord<S, K>[P]>;
};

export type InferUpdateInput<
  S extends SchemaDef,
  K extends EntityKey<S>,
> = Partial<EntityFieldTypes<S, K>>;
