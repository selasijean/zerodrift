import type { z } from "zod";
import { fields, entity, rebuildFieldBuilder } from "./builders.js";
import type {
  AnyFieldBuilder,
  EntityDef,
  FieldBuilder,
  FieldKind,
  FieldMeta,
} from "./types.js";

/**
 * Minimal structural shape used to walk a Zod schema at runtime without
 * importing Zod's class symbols. Mirrors `z._zod.def` in Zod v4 — an
 * internal API; if Zod changes its discriminator shape across a major,
 * this file is the only place that needs to follow.
 */
interface ZodLike {
  _zod: {
    def: {
      type: string;
      innerType?: ZodLike;
      defaultValue?: unknown;
      getter?: () => ZodLike;
    };
  };
}

/** Resolve `z.lazy(...)` wrappers to the schema they defer to. Codegen tools
 * emit lazy for recursive / forward-referenced schemas; by the time
 * `entityFromZod` runs, the referenced binding exists, so eager resolution
 * is safe. */
function unwrapLazy(schema: ZodLike): ZodLike {
  let current = schema;
  while (current._zod.def.type === "lazy" && current._zod.def.getter != null) {
    current = current._zod.def.getter();
  }
  return current;
}

const PRIMITIVE_KIND = new Map<
  string,
  () => AnyFieldBuilder
>([
  ["string", fields.string],
  ["number", fields.number],
  ["int", fields.number],
  ["boolean", fields.boolean],
  ["date", fields.date],
]);

/**
 * Convert any Zod schema into the equivalent schema-first `FieldBuilder`.
 * Handles the common nullable / optional / default / lazy modifiers (lazy
 * wrappers are resolved eagerly); anything more structured (objects, arrays,
 * unions, enums) collapses to `s.json<T>()` so the runtime stores the raw
 * value and the TS type still flows from Zod.
 *
 * Zod is an optional peer dependency — calling this function requires the
 * caller to have installed `zod`.
 */
export function fromZod<Z extends z.ZodType>(
  zSchema: Z,
): FieldBuilder<z.infer<Z>> {
  let current = zSchema as unknown as ZodLike;
  let nullable = false;
  let optional = false;
  let defaultValue: unknown = undefined;

  while (true) {
    current = unwrapLazy(current);
    const { type, innerType, defaultValue: inner } = current._zod.def;
    if (type === "nullable" && innerType != null) {
      nullable = true;
      current = innerType;
      continue;
    }
    if (type === "optional" && innerType != null) {
      optional = true;
      current = innerType;
      continue;
    }
    if (type === "default" && innerType != null) {
      defaultValue = inner;
      current = innerType;
      continue;
    }
    break;
  }

  const factory = PRIMITIVE_KIND.get(current._zod.def.type) ?? fields.json;
  let builder = factory();
  if (defaultValue !== undefined) {
    builder = builder.default(defaultValue);
  }
  if (nullable) {
    builder = builder.nullable();
  }
  if (optional) {
    builder = rebuildFieldBuilder<z.infer<Z>, typeof builder.meta>({
      ...builder.meta,
      optional: true,
    });
  }
  return builder as FieldBuilder<z.infer<Z>>;
}

/**
 * Maps Zod's `_zod.def.type` discriminator to a schema `FieldKind`. Mirrors
 * the runtime `PRIMITIVE_KIND` map; anything not covered collapses to `"json"`,
 * matching `fromZod`'s fallback.
 */
type ZodKindFromTypeName<T> = T extends "string"
  ? "string"
  : T extends "number" | "int"
    ? "number"
    : T extends "boolean"
      ? "boolean"
      : T extends "date"
        ? "date"
        : "json";

/**
 * Type-level analogue of `fromZod`'s runtime walker: peels off `nullable` /
 * `optional` / `default` wrappers, stamping each on the accumulator, then
 * collapses the leaf to a kind via `ZodKindFromTypeName`. The result is
 * intersected with `FieldMeta` so `IsOptionalCreateField` sees the same
 * `{kind, optional, default}` flags the runtime produces — keeping
 * create-input optionality aligned for `.optional()` and `.default(...)`
 * Zod fields, not just `id`.
 */
type ZodToFieldMeta<Z, Accum = Record<never, never>> = Z extends {
  _zod: { def: { type: "lazy"; getter: () => infer I } };
}
  ? ZodToFieldMeta<I, Accum>
  : Z extends { _zod: { def: { type: "nullable"; innerType: infer I } } }
    ? ZodToFieldMeta<I, Accum & { nullable: true }>
    : Z extends { _zod: { def: { type: "optional"; innerType: infer I } } }
      ? ZodToFieldMeta<I, Accum & { optional: true }>
      : Z extends { _zod: { def: { type: "default"; innerType: infer I } } }
        ? ZodToFieldMeta<I, Accum & { default: unknown }>
        : Z extends { _zod: { def: { type: infer T extends string } } }
          ? Accum & { kind: ZodKindFromTypeName<T> }
          : Accum;

/**
 * A Zod object, possibly wrapped in `z.lazy(...)`. Codegen emits
 * `z.lazy(() => Shape)` for recursive / forward-referenced schemas;
 * `entityFromZod` accepts either form and derives fields from the resolved
 * object.
 */
export type ZodObjectOrLazy = z.ZodObject | z.ZodLazy<z.ZodObject>;

/** Type-level analogue of the runtime `unwrapLazy`: peel `z.lazy(...)`
 * wrappers until the deferred schema surfaces. */
type UnwrapZodLazy<Z> = Z extends {
  _zod: { def: { type: "lazy"; getter: () => infer I } };
}
  ? UnwrapZodLazy<I>
  : Z;

/** Shape record of a (possibly lazy-wrapped) Zod object. Every helper below
 * reads the shape through this so lazy-wrapped schemas infer identically to
 * bare `z.object(...)` ones. */
type ShapeOf<Z> = UnwrapZodLazy<Z> extends { shape: infer S } ? S : never;

/** Empty meta marker — convention-driven flags (autoIndex) layer on top.
 * `id` is excluded because the storage layer treats the PK specially and
 * never materializes a secondary index for it; the empty-string suffix is
 * excluded so a defaulted/blank config value doesn't index every field. */
type AutoIndexMeta<
  K,
  AI extends string | undefined,
> = K extends "id"
  ? Record<never, never>
  : AI extends ""
    ? Record<never, never>
    : AI extends string
      ? K extends `${string}${AI}`
        ? { indexed: true }
        : Record<never, never>
      : Record<never, never>;

/**
 * Auto-derived `FieldBuilder` type for a Zod-object key. The `id` key is
 * special-cased to carry `{kind: "id"}` (the runtime routes `id` through
 * `fields.id()` regardless of the Zod-declared id type). Every other key
 * walks its Zod schema via `ZodToFieldMeta` so PK, optional, and default
 * flags all flow into the field's create-input optionality the same way.
 * `AI` is the opts.autoIndex suffix — matching keys pick up `{indexed: true}`.
 */
type AutoFieldFromZod<
  K,
  ZS,
  AI extends string | undefined = undefined,
> = K extends "id"
  ? FieldBuilder<string, FieldMeta & { kind: "id" } & AutoIndexMeta<K, AI>>
  : ZS extends z.ZodType
    ? FieldBuilder<
        z.infer<ZS>,
        FieldMeta & ZodToFieldMeta<ZS> & AutoIndexMeta<K, AI>
      >
    : FieldBuilder<unknown, FieldMeta & { kind: FieldKind }>;

/**
 * Per-field override for `entityFromZod`. Either a chaining function
 * (modifies the auto-derived `FieldBuilder`) or a full `FieldBuilder`
 * (replaces it — useful for FKs and other shapes Zod can't model).
 */
export type EntityFromZodFieldOverride<AutoT = unknown> =
  | AnyFieldBuilder
  | ((auto: FieldBuilder<AutoT>) => AnyFieldBuilder);

type EntityFromZodFieldOverrides<
  Z extends ZodObjectOrLazy,
  AI extends string | undefined = undefined,
> = {
  [K in keyof ShapeOf<Z> & string]?:
    | AnyFieldBuilder
    | ((auto: AutoFieldFromZod<K, ShapeOf<Z>[K], AI>) => unknown);
};

/**
 * Maps any `opts.fields` key that isn't declared on the Zod object to a
 * branded error-string type. The intersection with the override map then
 * forces TS to surface "is not assignable to type \"Error: 'foo' is not a
 * field…\"" — naming the offender — instead of the bare "not assignable to
 * type 'never'" the previous `Record<…, never>` form produced.
 */
type NoExtraZodFieldKeys<Z extends ZodObjectOrLazy, F> = {
  [K in keyof F as K extends keyof ShapeOf<Z> ? never : K]: `Error: '${K &
    string}' is not a field declared on the Zod object passed to entityFromZod`;
};

/**
 * Resolve the field type contributed by an override entry. Functions are
 * unwrapped via their inferred return type so chained modifiers like
 * `.indexed()` carry their narrowed `M` into the entity's inferred fields;
 * direct `FieldBuilder` overrides are used as-is. When no override is
 * provided the auto-derived `Auto` field stands.
 */
type FieldFromOverride<O, Auto> = O extends (...args: never[]) => infer R
  ? R extends FieldBuilder<infer RT, infer RM>
    ? [unknown] extends [RT]
      ? Auto extends FieldBuilder<infer AT, FieldMeta>
        ? FieldBuilder<AT, RM>
        : never
      : R
    : Auto
  : O extends AnyFieldBuilder
    ? O
    : Auto;

/**
 * Per-key merge of the Zod-inferred fields with `opts.fields` overrides.
 * Override metadata (`.indexed()`, refId target, …) propagates into the
 * entity's TS type so downstream helpers like `IndexedFieldKeys` see them.
 */
type MergedFieldsFromZodObject<
  Z extends ZodObjectOrLazy,
  F,
  Om extends readonly string[] = readonly [],
  AI extends string | undefined = undefined,
> = {
  [K in keyof ShapeOf<Z> as K extends Om[number]
    ? never
    : K]: K extends keyof F
    ? FieldFromOverride<F[K], AutoFieldFromZod<K, ShapeOf<Z>[K], AI>>
    : AutoFieldFromZod<K, ShapeOf<Z>[K], AI>;
};

/** Non-`fields` portion of the opts — shared across the public type and
 * the function's inferred-`F` signature. Tracks `EntityDef` so any new
 * top-level knob (like `external`) has to be added here intentionally. */
type EntityFromZodOptsBase = Pick<
  EntityDef,
  | "loadStrategy"
  | "eviction"
  | "usedForPartialIndexes"
  | "name"
  | "version"
  | "idStrategy"
>;

export interface EntityFromZodOpts<Z extends ZodObjectOrLazy = z.ZodObject>
  extends EntityFromZodOptsBase {
  /**
   * Per-field overrides applied after the Zod-derived `FieldBuilder`.
   * Keys are constrained to fields actually declared on the Zod object,
   * so typos surface at compile time.
   *
   *     entityFromZod(ZodIssue, {
   *       loadStrategy: LoadStrategy.Eager,
   *       fields: {
   *         teamId:    s.refId("team").nullable().indexed(),  // replace
   *         email:     (b) => b.indexed(),                     // chain
   *         draftNote: (b) => b.ephemeral(),
   *       },
   *     });
   */
  fields?: {
    [K in keyof ShapeOf<Z> & string]?:
      | AnyFieldBuilder
      | ((auto: AutoFieldFromZod<K, ShapeOf<Z>[K]>) => AnyFieldBuilder);
  };
  /** Fields whose Zod name ends with this suffix pick up `.indexed()` —
   * intended for the common FK-naming convention (`/ID$/` → `autoIndex: "ID"`).
   * Suppressed for any key that supplies a builder-form override. */
  autoIndex?: string;
  /** Field names to drop entirely from the produced entity. Common when the
   * source Zod was generated from a DTO that carries transport-only keys. */
  omit?: readonly string[];
}

/**
 * Convert a `z.object({ ... })` — or a `z.lazy(() => z.object({ ... }))`,
 * as codegen emits for recursive / forward-referenced schemas — into an
 * `EntityDef`. Each key on the (resolved) Zod object becomes a field via
 * `fromZod`, then `opts.fields[key]` (if present) is applied — either
 * chained onto the auto-derived builder, or used as a full replacement.
 * Override keys that aren't declared on the Zod object throw (they'd
 * otherwise be dropped silently).
 *
 * The override map is captured via a `const`-modified generic so per-field
 * metadata (`.indexed()`, refId target, …) flows into the returned
 * `EntityDef` — `IndexedFieldKeys`, `getByIndex`, `peekByIndex`, and the
 * typed React hooks all see Zod-built entities the same way they see
 * hand-written ones.
 *
 * `F` is inferred from the provided `fields` map while an intersected
 * override-map type supplies allowed keys and key-specific contextual typing
 * for the `(auto) => ...` parameter. When no `fields` map is provided, `F`
 * defaults to an empty record so untouched Zod fields stay on the auto-derived
 * `FieldBuilder<z.infer<...>>` path.
 * `EntityFromZodOpts<Z>` keeps the strict union for users who pre-type
 * their opts variables.
 *
 * Only single-record entities are produced; relations still belong in the
 * schema's `links` block. Treat the Zod object as the source of field
 * shape and validation; `link(...)` remains the source of truth for the
 * graph.
 */
export function entityFromZod<
  Z extends ZodObjectOrLazy,
  const F = Record<never, never>,
  const Om extends readonly (keyof ShapeOf<Z> & string)[] = readonly [],
  const AI extends string | undefined = undefined,
>(
  zSchema: Z,
  opts: EntityFromZodOptsBase & {
    fields?: F & EntityFromZodFieldOverrides<Z, AI> & NoExtraZodFieldKeys<Z, F>;
    autoIndex?: AI;
    omit?: Om;
  },
): EntityDef<MergedFieldsFromZodObject<Z, F, Om, AI>> {
  const resolved = unwrapLazy(zSchema as unknown as ZodLike);
  const shape = (resolved as unknown as z.ZodObject).shape as
    | Record<string, z.ZodType>
    | undefined;
  if (shape == null) {
    throw new Error(
      `entityFromZod: expected a z.object(...) schema (optionally wrapped ` +
        `in z.lazy), got "${resolved._zod.def.type}".`,
    );
  }
  const overrides = (opts.fields ?? {}) as Record<
    string,
    EntityFromZodFieldOverride
  >;
  const unknownOverrideKeys = Object.keys(overrides).filter(
    (key) => !(key in shape),
  );
  if (unknownOverrideKeys.length > 0) {
    throw new Error(
      `entityFromZod: fields override${unknownOverrideKeys.length > 1 ? "s" : ""} ` +
        `[${unknownOverrideKeys.join(", ")}] not declared on the Zod object ` +
        `(declared: ${Object.keys(shape).join(", ")}).`,
    );
  }
  const omitted = new Set<string>(opts.omit ?? []);
  const autoIndexSuffix =
    opts.autoIndex != null && opts.autoIndex !== "" ? opts.autoIndex : null;
  const fieldsRecord: Record<string, AnyFieldBuilder> = {};
  for (const [key, fieldSchema] of Object.entries(shape)) {
    if (omitted.has(key)) {
      continue;
    }
    let auto: AnyFieldBuilder =
      key === "id" ? fields.id() : fromZod(fieldSchema);
    if (
      autoIndexSuffix != null &&
      key !== "id" &&
      key.endsWith(autoIndexSuffix)
    ) {
      auto = auto.indexed();
    }
    const override = overrides[key];
    fieldsRecord[key] =
      typeof override === "function"
        ? override(auto)
        : (override ?? auto);
  }
  return entity({
    loadStrategy: opts.loadStrategy,
    eviction: opts.eviction,
    usedForPartialIndexes: opts.usedForPartialIndexes,
    name: opts.name,
    version: opts.version,
    idStrategy: opts.idStrategy,
    fields: fieldsRecord,
  }) as EntityDef<MergedFieldsFromZodObject<Z, F, Om, AI>>;
}

/**
 * Map a whole `{key: ZodObject}` module (e.g. an OpenAPI-generated barrel)
 * into an entities record by calling `entityFromZod` per key with shared
 * opts. The entity key in the returned record is the input key; the registry
 * name is auto-derived (PascalCase of the key) by `compileSchema` — no need
 * to spell `name` per entity.
 *
 *     const entities = entitiesFromZod(generatedZods, {
 *       loadStrategy: LoadStrategy.Eager,
 *       autoIndex: "ID",
 *       omit: ["createdAt", "updatedAt"],
 *     });
 *     const schema = defineSchema({ entities, links: { ... } });
 *
 * Per-entity overrides are not threaded — drop down to `entityFromZod` for
 * the handful that need a custom `fields` map or distinct `loadStrategy`.
 */
type EntitiesFromZodResult<
  Zods extends Record<string, ZodObjectOrLazy>,
  Om extends readonly string[],
  AI extends string | undefined,
> = {
  [K in keyof Zods]: EntityDef<
    MergedFieldsFromZodObject<Zods[K], Record<never, never>, Om, AI>
  >;
};

export function entitiesFromZod<
  Zods extends Record<string, ZodObjectOrLazy>,
  const Om extends readonly string[] = readonly [],
  const AI extends string | undefined = undefined,
>(
  zods: Zods,
  opts: Pick<EntityFromZodOptsBase, "loadStrategy" | "eviction" | "usedForPartialIndexes"> & {
    autoIndex?: AI;
    omit?: Om;
  },
): EntitiesFromZodResult<Zods, Om, AI> {
  const out: Record<string, EntityDef> = {};
  for (const [key, zod] of Object.entries(zods)) {
    out[key] = entityFromZod(zod, {
      loadStrategy: opts.loadStrategy,
      eviction: opts.eviction,
      usedForPartialIndexes: opts.usedForPartialIndexes,
      autoIndex: opts.autoIndex,
      omit: opts.omit as readonly never[] | undefined,
    });
  }
  return out as EntitiesFromZodResult<Zods, Om, AI>;
}
