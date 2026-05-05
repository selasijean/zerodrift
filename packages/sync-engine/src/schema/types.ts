import type { LoadStrategy, OnDelete } from "../core/types";

export type FieldKind =
  | "id"
  | "string"
  | "number"
  | "boolean"
  | "date"
  | "json"
  | "refId";

export interface FieldMeta {
  kind: FieldKind;
  nullable: boolean;
  indexed: boolean;
  ephemeral: boolean;
  default?: unknown;
  refTarget?: string;
  serializer?: (value: unknown) => unknown;
  deserializer?: (raw: unknown) => unknown;
}

/**
 * Carries two pieces of information through the type system:
 *   T — the TS type the field exposes (`string`, `number | null`, `Date`, …).
 *       `InferEntity` reads this to build the record shape.
 *   M — the runtime metadata, with literal-preserved fields like
 *       `kind: "refId"` and `refTarget: "team"` so `link(...)` / inference
 *       can pull relation targets back out of the schema at the type level.
 */
export interface FieldBuilder<T, M extends FieldMeta = FieldMeta> {
  /** @internal — phantom slot used only for type inference. */
  readonly _t?: T;
  readonly meta: M;
  nullable(): FieldBuilder<T | null, M>;
  indexed(): FieldBuilder<T, M>;
  default(value: T): FieldBuilder<T, Omit<M, "default"> & { default: T }>;
  ephemeral(): FieldBuilder<T, M>;
  serialize(fn: (value: T) => unknown): FieldBuilder<T, M>;
  deserialize(fn: (raw: unknown) => T): FieldBuilder<T, M>;
}

export type AnyFieldBuilder = FieldBuilder<unknown, FieldMeta>;

export interface EntityDef<
  F extends Record<string, AnyFieldBuilder> = Record<string, AnyFieldBuilder>,
> {
  loadStrategy: LoadStrategy;
  usedForPartialIndexes?: boolean;
  /** Override the registry name. Defaults to PascalCase of the entity key at compile time. */
  name?: string;
  /** Forces a schemaVersion override. Otherwise computed by the compiler. */
  version?: number;
  /**
   * Marks this entity as registered elsewhere (typically by `@ClientModel`).
   * The compiler skips class generation and property/link registration for
   * external entities, but still allows other schema entities to reference
   * them via `s.refId(...)` and `link({ to: { entity: ... } })`. `name` must
   * be set explicitly so the schema can resolve cross-references against the
   * existing registry entry.
   */
  external?: boolean;
  fields: F;
}

export interface LinkFromSpec<
  Entity extends string = string,
  Field extends string = string,
  As extends string = string,
> {
  entity: Entity;
  field: Field;
  as: As;
}

export interface LinkToSpec<
  Entity extends string = string,
  Many extends string = string,
> {
  entity: Entity;
  many: Many;
  lazy?: boolean;
}

export type { OnDelete };

export interface LinkDef<
  FromEntity extends string = string,
  FromField extends string = string,
  As extends string = string,
  ToEntity extends string = string,
  Many extends string = string,
> {
  from: LinkFromSpec<FromEntity, FromField, As>;
  to: LinkToSpec<ToEntity, Many>;
  onDelete?: OnDelete;
}

export type AnyLinkDef = LinkDef;

export interface SchemaDef<
  E extends Record<string, EntityDef> = Record<string, EntityDef>,
  L extends Record<string, AnyLinkDef> = Record<string, AnyLinkDef>,
> {
  entities: E;
  links: L;
}
