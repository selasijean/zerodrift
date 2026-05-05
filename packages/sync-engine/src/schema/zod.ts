import type { z } from "zod";
import type { LoadStrategy } from "../core/types";
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

type FieldsFromZodObject<Z extends z.ZodObject> = {
  [K in keyof z.infer<Z>]: FieldBuilder<z.infer<Z>[K]>;
};

/**
 * Per-field override for `entityFromZod`. Either a chaining function
 * (modifies the auto-derived `FieldBuilder`) or a full `FieldBuilder`
 * (replaces it — useful for FKs and other shapes Zod can't model).
 */
export type EntityFromZodFieldOverride =
  | AnyFieldBuilder
  | ((auto: AnyFieldBuilder) => AnyFieldBuilder);

export interface EntityFromZodOpts<Z extends z.ZodObject = z.ZodObject> {
  loadStrategy: LoadStrategy;
  usedForPartialIndexes?: boolean;
  /** Override the registry name. Defaults to PascalCase of the entity key at compile time. */
  name?: string;
  /** Forces a schemaVersion override. Otherwise computed by the compiler. */
  version?: number;
  /**
   * Per-field overrides applied after the Zod-derived `FieldBuilder`.
   * Keys are constrained to fields actually declared on the Zod object,
   * so typos surface at compile time.
   *
   *     entityFromZod(ZodIssue, {
   *       loadStrategy: LoadStrategy.Instant,
   *       fields: {
   *         teamId:    s.refId("team").nullable().indexed(),  // replace
   *         email:     (b) => b.indexed(),                     // chain
   *         draftNote: (b) => b.ephemeral(),
   *       },
   *     });
   */
  fields?: Partial<
    Record<keyof z.infer<Z> & string, EntityFromZodFieldOverride>
  >;
}

/**
 * Convert a `z.object({ ... })` into an `EntityDef`. Each key on the Zod
 * object becomes a field via `fromZod`, then `opts.fields[key]` (if
 * present) is applied — either chained onto the auto-derived builder, or
 * used as a full replacement.
 *
 * Only single-record entities are produced; relations still belong in the
 * schema's `links` block. Treat the Zod object as the source of field
 * shape and validation; `link(...)` remains the source of truth for the
 * graph.
 */
export function entityFromZod<Z extends z.ZodObject>(
  zSchema: Z,
  opts: EntityFromZodOpts<Z>,
): EntityDef<FieldsFromZodObject<Z>> {
  const overrides = opts.fields ?? {};
  const fieldsRecord: Record<string, AnyFieldBuilder> = {};
  for (const [key, fieldSchema] of Object.entries(zSchema.shape)) {
    const auto = key === "id" ? fields.id() : fromZod(fieldSchema);
    const override = (overrides as Record<string, EntityFromZodFieldOverride>)[key];
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
  }) as EntityDef<FieldsFromZodObject<Z>>;
}
