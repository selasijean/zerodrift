import { dateDeserializer, dateSerializer } from "../core/serializers.js";
import type {
  AnyFieldBuilder,
  AnyLinkDef,
  EntityDef,
  FieldBuilder,
  FieldKind,
  FieldMeta,
  LinkDef,
  SchemaDef,
} from "./types.js";

function makeBuilder<T, M extends FieldMeta>(meta: M): FieldBuilder<T, M> {
  return {
    meta,
    nullable() {
      return makeBuilder<T | null, M>({ ...meta, nullable: true });
    },
    indexed() {
      return makeBuilder<T, Omit<M, "indexed"> & { indexed: true }>({
        ...meta,
        indexed: true,
      } as Omit<M, "indexed"> & { indexed: true });
    },
    default(value: T) {
      return makeBuilder<T, Omit<M, "default"> & { default: T }>({
        ...meta,
        default: value,
      } as Omit<M, "default"> & { default: T });
    },
    ephemeral() {
      return makeBuilder<T, M>({ ...meta, ephemeral: true });
    },
    serialize(fn) {
      return makeBuilder<T, M>({
        ...meta,
        serializer: fn as (value: unknown) => unknown,
      });
    },
    deserialize(fn) {
      return makeBuilder<T, M>({ ...meta, deserializer: fn });
    },
  };
}

export function rebuildFieldBuilder<T, M extends FieldMeta>(
  meta: M,
): FieldBuilder<T, M> {
  return makeBuilder<T, M>(meta);
}

const baseFlags = {
  nullable: false as const,
  optional: false as const,
  indexed: false as const,
  ephemeral: false as const,
};

function field<K extends FieldKind, T>(
  kind: K,
  extras?: Partial<FieldMeta>,
): FieldBuilder<T, FieldMeta & { kind: K }> {
  return makeBuilder<T, FieldMeta & { kind: K }>({
    kind,
    ...baseFlags,
    ...extras,
  } as FieldMeta & { kind: K });
}

const id = () => field<"id", string>("id");
const stringField = () => field<"string", string>("string");
const numberField = () => field<"number", number>("number");
const booleanField = () => field<"boolean", boolean>("boolean");
const date = () =>
  field<"date", Date>("date", {
    serializer: dateSerializer,
    deserializer: dateDeserializer,
  });
const json = <T = unknown>() => field<"json", T>("json");
const refId = <Target extends string>(
  target: Target,
): FieldBuilder<string, FieldMeta & { kind: "refId"; refTarget: Target }> =>
  makeBuilder<string, FieldMeta & { kind: "refId"; refTarget: Target }>({
    kind: "refId",
    refTarget: target,
    ...baseFlags,
  });

export const fields = {
  id,
  string: stringField,
  number: numberField,
  boolean: booleanField,
  date,
  json,
  refId,
};

export function entity<const F extends Record<string, AnyFieldBuilder>>(
  def: EntityDef<F>,
): EntityDef<F> {
  return def;
}

export function link<
  const FromEntity extends string,
  const FromField extends string,
  const As extends string,
  const ToEntity extends string,
  const Many extends string,
>(
  def: LinkDef<FromEntity, FromField, As, ToEntity, Many>,
): LinkDef<FromEntity, FromField, As, ToEntity, Many> {
  return def;
}

export function defineSchema<
  const E extends Record<string, EntityDef>,
  const L extends Record<string, AnyLinkDef>,
>(schema: SchemaDef<E, L>): SchemaDef<E, L> {
  return schema;
}
