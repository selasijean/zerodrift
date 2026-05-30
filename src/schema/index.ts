// Public schema-authoring surface. See agent-docs/RFC-schema-first-authoring.md.

export { LoadStrategy } from "../core/types.js";

export { defineSchema, entity, link, fields } from "./builders.js";
export { fields as s } from "./builders.js";
export { compileSchema } from "./compile.js";
export type { CompiledSchema } from "./compile.js";
export { createStore } from "./createStore.js";
export type {
  EntityStore,
  EntityNamespace,
  RecordWithExtensions,
  StoreApi,
} from "./createStore.js";

export { extend } from "./extend.js";
export type {
  ActionFn,
  ComputedFn,
  ExtensionDef,
  ExtensionDescriptor,
  ExtensionMap,
  MergedExtensionMembers,
} from "./extend.js";

export { fromZod, entityFromZod, entitiesFromZod } from "./zod.js";
export type { EntityFromZodFieldOverride, EntityFromZodOpts } from "./zod.js";

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
} from "./types.js";

export type {
  EntityKey,
  IndexedFieldKeys,
  InferCreateInput,
  InferEntity,
  InferRecord,
  InferUpdateInput,
  RelationCollection,
} from "./infer.js";
