import type { z } from "zod";
import { fields, entity, rebuildFieldBuilder } from "./builders";
import type { AnyFieldBuilder, EntityDef, FieldBuilder } from "./types";

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
    };
  };
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
 * Handles the common nullable / optional / default modifiers; anything more
 * structured (objects, arrays, unions, enums) collapses to `s.json<T>()` so
 * the runtime stores the raw value and the TS type still flows from Zod.
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
 * Per-field override for `entityFromZod`. Either a chaining function
 * (modifies the auto-derived `FieldBuilder`) or a full `FieldBuilder`
 * (replaces it — useful for FKs and other shapes Zod can't model).
 */
export type EntityFromZodFieldOverride<AutoT = unknown> =
  | AnyFieldBuilder
  | ((auto: FieldBuilder<AutoT>) => AnyFieldBuilder);

type EntityFromZodFieldOverrides<Z extends z.ZodObject> = {
  [K in keyof z.infer<Z> & string]?:
    | AnyFieldBuilder
    | ((auto: FieldBuilder<z.infer<Z>[K]>) => unknown);
};

type NoExtraZodFieldKeys<Z extends z.ZodObject, F> = Record<
  Exclude<keyof F, keyof z.infer<Z> & string>,
  never
>;

/**
 * Resolve the field type contributed by an override entry. Functions are
 * unwrapped via their inferred return type so chained modifiers like
 * `.indexed()` carry their narrowed `M` into the entity's inferred fields;
 * direct `FieldBuilder` overrides are used as-is. When no override is
 * provided the auto-derived `FieldBuilder<AutoT>` from Zod stands.
 */
type FieldFromOverride<O, AutoT> = O extends (...args: never[]) => infer R
  ? R extends FieldBuilder<infer RT, infer RM>
    ? [unknown] extends [RT]
      ? FieldBuilder<AutoT, RM>
      : R
    : FieldBuilder<AutoT>
  : O extends AnyFieldBuilder
    ? O
    : FieldBuilder<AutoT>;

/**
 * Per-key merge of the Zod-inferred fields with `opts.fields` overrides.
 * Override metadata (`.indexed()`, refId target, …) propagates into the
 * entity's TS type so downstream helpers like `IndexedFieldKeys` see them.
 */
type MergedFieldsFromZodObject<Z extends z.ZodObject, F> = {
  [K in keyof z.infer<Z>]: K extends keyof F
    ? FieldFromOverride<F[K], z.infer<Z>[K]>
    : FieldBuilder<z.infer<Z>[K]>;
};

/** Non-`fields` portion of the opts — shared across the public type and
 * the function's inferred-`F` signature. Tracks `EntityDef` so any new
 * top-level knob (like `external`) has to be added here intentionally. */
type EntityFromZodOptsBase = Pick<
  EntityDef,
  "loadStrategy" | "usedForPartialIndexes" | "name" | "version"
>;

export interface EntityFromZodOpts<Z extends z.ZodObject = z.ZodObject>
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
    [K in keyof z.infer<Z> & string]?: EntityFromZodFieldOverride<
      z.infer<Z>[K]
    >;
  };
}

/**
 * Convert a `z.object({ ... })` into an `EntityDef`. Each key on the Zod
 * object becomes a field via `fromZod`, then `opts.fields[key]` (if
 * present) is applied — either chained onto the auto-derived builder, or
 * used as a full replacement.
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
  Z extends z.ZodObject,
  const F = Record<never, never>,
>(
  zSchema: Z,
  opts: EntityFromZodOptsBase & {
    fields?: F & EntityFromZodFieldOverrides<Z> & NoExtraZodFieldKeys<Z, F>;
  },
): EntityDef<MergedFieldsFromZodObject<Z, F>> {
  const overrides = (opts.fields ?? {}) as Record<
    string,
    EntityFromZodFieldOverride
  >;
  const fieldsRecord: Record<string, AnyFieldBuilder> = {};
  for (const [key, fieldSchema] of Object.entries(zSchema.shape)) {
    const auto = key === "id" ? fields.id() : fromZod(fieldSchema);
    const override = overrides[key];
    fieldsRecord[key] =
      typeof override === "function"
        ? override(auto)
        : (override ?? auto);
  }
  return entity({
    loadStrategy: opts.loadStrategy,
    usedForPartialIndexes: opts.usedForPartialIndexes,
    name: opts.name,
    version: opts.version,
    fields: fieldsRecord,
  }) as EntityDef<MergedFieldsFromZodObject<Z, F>>;
}
