// Public schema-authoring surface. See agent-docs/RFC-schema-first-authoring.md.

export { LoadStrategy } from "../core/types";

export { defineSchema, entity, link, fields } from "./builders";
export { fields as s } from "./builders";
export { compileSchema } from "./compile";
export type { CompiledSchema } from "./compile";
export { createStore } from "./createStore";
export type {
  EntityStore,
  EntityNamespace,
  RecordWithExtensions,
  StoreApi,
} from "./createStore";

export { extend } from "./extend";
export type {
  ActionFn,
  ComputedFn,
  ExtensionDef,
  ExtensionDescriptor,
  ExtensionMap,
  MergedExtensionMembers,
} from "./extend";

export { fromZod, entityFromZod } from "./zod";
export type { EntityFromZodFieldOverride, EntityFromZodOpts } from "./zod";

export type {
  EntityDef,
  FieldBuilder,
  FieldKind,
  FieldMeta,
  LinkDef,
  LinkFromSpec,
  LinkToSpec,
  OnDelete,
  SchemaDef,
} from "./types";

export type {
  EntityKey,
  IndexedFieldKeys,
  InferCreateInput,
  InferEntity,
  InferUpdateInput,
  RelationCollection,
} from "./infer";
