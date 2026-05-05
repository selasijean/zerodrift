// Public schema-authoring surface. See agent-docs/RFC-schema-first-authoring.md.

export { LoadStrategy } from "../core/types";

export { defineSchema, entity, link, fields } from "./builders";
export { fields as s } from "./builders";
export { compileSchema } from "./compile";
export type { CompiledSchema } from "./compile";

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
  FieldIsNullable,
  FieldRefTarget,
  FieldType,
  InferCreateInput,
  InferEntity,
  InferUpdateInput,
  RelationCollection,
} from "./infer";
