import { BaseModel } from "../core/BaseModel";
import { hashString } from "../core/hash";
import { ModelRegistry } from "../core/ModelRegistry";
import { defineObservableProperty } from "../core/observability";
import {
  installCollectionAccessor,
  installReferenceAccessor,
} from "../core/refAccessors";
import { PropertyType, type ModelMeta, type PropertyMeta } from "../core/types";
import type { AnyFieldBuilder, AnyLinkDef, EntityDef, SchemaDef } from "./types";

export interface CompiledSchema {
  /** Registry names of every entity that was compiled. */
  modelNames: readonly string[];
  /** Map from schema-entity key to registry name. */
  nameByKey: ReadonlyMap<string, string>;
  /** Snapshot of the global registry hash after compilation. */
  schemaHash: string;
}

/**
 * Compile a `SchemaDef` produced by `defineSchema(...)` into the existing
 * `ModelRegistry`. Each schema entity becomes a synthetic `BaseModel`
 * subclass, registered under its PascalCased key (or `entity({ name })`
 * override). After this returns, `ModelRegistry`, `StoreManager`, and the
 * sync runtime see schema-defined models exactly the way they see
 * decorator-defined ones.
 *
 * The function is pure with respect to the input `schema` object, but
 * registers globally as a side effect — same contract as `@ClientModel`.
 * Validation runs before any registry mutation; on failure the registry
 * is untouched.
 *
 * The four passes below have an ordering dependency: ctors must be created
 * before their fields can carry resolved `referenceTo` registry names; fields
 * must exist before `registerLink` can `updateProperty` the FK; and the
 * per-entity hash must run last so it captures every link side-effect.
 */
export function compileSchema(schema: SchemaDef): CompiledSchema {
  validateSchema(schema);

  const nameByKey = resolveNames(schema);
  const ctorByKey = new Map<string, typeof BaseModel>();
  const externalKeys = collectExternalKeys(schema);

  for (const [key, entityDef] of Object.entries(schema.entities)) {
    if (externalKeys.has(key)) {
      continue;
    }
    const name = nameByKey.get(key)!;
    const ctor = createSyntheticClass(name, entityDef);
    ctorByKey.set(key, ctor);

    const meta = ModelRegistry.registerModel(name, ctor);
    meta.loadStrategy = entityDef.loadStrategy;
    meta.usedForPartialIndexes = entityDef.usedForPartialIndexes ?? false;
    if (entityDef.version != null) {
      meta.schemaVersion = entityDef.version;
    }
  }

  for (const [key, entityDef] of Object.entries(schema.entities)) {
    if (externalKeys.has(key)) {
      continue;
    }
    const name = nameByKey.get(key)!;
    const ctor = ctorByKey.get(key)!;
    for (const [fieldName, builder] of Object.entries(entityDef.fields)) {
      registerField(ctor, name, fieldName, builder, nameByKey);
    }
  }

  for (const linkDef of Object.values(schema.links)) {
    registerLink(linkDef, externalKeys, ctorByKey, nameByKey);
  }

  for (const [key, entityDef] of Object.entries(schema.entities)) {
    if (externalKeys.has(key) || entityDef.version != null) {
      continue;
    }
    const name = nameByKey.get(key)!;
    const meta = ModelRegistry.getModelMeta(name)!;
    meta.schemaVersion = hashEntityMeta(meta);
  }

  return {
    modelNames: [...nameByKey.values()],
    nameByKey,
    schemaHash: ModelRegistry.schemaHash,
  };
}

/**
 * Entity keys that would collide with `store.<top-level>` methods (`store.batch`,
 * future additions). Validation rejects these up front so a schema can't
 * silently shadow the typed surface.
 */
const RESERVED_DB_KEYS: ReadonlySet<string> = new Set([
  "batch",
  "undo",
  "redo",
  "undoDepth",
  "redoDepth",
  "runUndoable",
]);

function validateSchema(schema: SchemaDef): void {
  const errors: string[] = [];
  const entityKeys = new Set(Object.keys(schema.entities));

  const seenRegistryNames = new Set<string>();
  for (const [key, entityDef] of Object.entries(schema.entities)) {
    if (RESERVED_DB_KEYS.has(key)) {
      errors.push(
        `entity key "${key}" collides with the reserved top-level \`store.${key}\`. ` +
          `Rename the entity (e.g. "${key}Entry") or override its registry name.`,
      );
    }
    if (entityDef.external === true && entityDef.name == null) {
      errors.push(
        `entity "${key}": external: true requires an explicit name so the ` +
          `compiler can resolve cross-references against the existing registry entry.`,
      );
    }
    const name = entityDef.name ?? pascalCase(key);
    if (entityDef.external === true && ModelRegistry.getModelMeta(name) == null) {
      errors.push(
        `entity "${key}": external model "${name}" is not registered in ` +
          `ModelRegistry. Import/run its @ClientModel definition before compiling the schema.`,
      );
    }
    if (seenRegistryNames.has(name)) {
      errors.push(
        `Two entities compile to the same registry name "${name}". ` +
          `Override one with \`entity({ name: "..." })\`.`,
      );
    }
    seenRegistryNames.add(name);

    let idCount = 0;
    for (const builder of Object.values(entityDef.fields)) {
      if (builder.meta.kind === "id") {
        idCount++;
      }
    }
    if (idCount > 1) {
      errors.push(`Entity "${key}" declares more than one s.id() field.`);
    }
  }

  const fkBacklinkCount = new Map<string, number>();
  const relationNamesByEntity = new Map<string, Set<string>>();

  for (const [linkKey, linkDef] of Object.entries(schema.links)) {
    const fromKey = linkDef.from.entity;
    const fieldKey = linkDef.from.field;
    const toKey = linkDef.to.entity;

    if (!entityKeys.has(fromKey)) {
      errors.push(
        `link "${linkKey}": from.entity "${fromKey}" is not a declared entity. ` +
          `Valid entities: ${[...entityKeys].join(", ")}.`,
      );
      continue;
    }
    if (!entityKeys.has(toKey)) {
      errors.push(
        `link "${linkKey}": to.entity "${toKey}" is not a declared entity. ` +
          `Valid entities: ${[...entityKeys].join(", ")}.`,
      );
      continue;
    }

    const fromEntity = schema.entities[fromKey];
    const fkBuilder: AnyFieldBuilder | undefined = fromEntity.fields[fieldKey];
    if (fkBuilder == null) {
      errors.push(
        `link "${linkKey}": field "${fieldKey}" does not exist on entity "${fromKey}".`,
      );
      continue;
    }
    if (fkBuilder.meta.kind !== "refId") {
      errors.push(
        `link "${linkKey}": field "${fromKey}.${fieldKey}" is ${fkBuilder.meta.kind}; ` +
          `link FKs must be declared with s.refId(...).`,
      );
      continue;
    }
    if (fkBuilder.meta.refTarget !== toKey) {
      errors.push(
        `link "${linkKey}": s.refId target is "${fkBuilder.meta.refTarget}" ` +
          `but link.to.entity is "${toKey}". They must match.`,
      );
      continue;
    }

    const fkBacklinkKey = `${fromKey}.${fieldKey}`;
    fkBacklinkCount.set(
      fkBacklinkKey,
      (fkBacklinkCount.get(fkBacklinkKey) ?? 0) + 1,
    );

    if (fromEntity.fields[linkDef.from.as] != null) {
      errors.push(
        `link "${linkKey}": from.as "${linkDef.from.as}" collides with a ` +
          `field already declared on entity "${fromKey}".`,
      );
    }
    const toEntity = schema.entities[toKey];
    if (toEntity.fields[linkDef.to.many] != null) {
      errors.push(
        `link "${linkKey}": to.many "${linkDef.to.many}" collides with a ` +
          `field already declared on entity "${toKey}".`,
      );
    }

    addRelationName(relationNamesByEntity, fromKey, linkDef.from.as, errors);
    addRelationName(relationNamesByEntity, toKey, linkDef.to.many, errors);
  }

  for (const [key, count] of fkBacklinkCount) {
    if (count > 1) {
      errors.push(
        `FK "${key}" is referenced by ${count} links — each refId field can ` +
          `back at most one link.`,
      );
    }
  }

  if (errors.length > 0) {
    throw new Error(`Schema validation failed:\n  - ${errors.join("\n  - ")}`);
  }
}

function addRelationName(
  relationNamesByEntity: Map<string, Set<string>>,
  entityKey: string,
  name: string,
  errors: string[],
): void {
  let names = relationNamesByEntity.get(entityKey);
  if (names == null) {
    names = new Set();
    relationNamesByEntity.set(entityKey, names);
  }
  if (names.has(name)) {
    errors.push(
      `entity "${entityKey}": relation property "${name}" is declared by ` +
        `more than one link.`,
    );
  } else {
    names.add(name);
  }
}

function collectExternalKeys(schema: SchemaDef): ReadonlySet<string> {
  const out = new Set<string>();
  for (const [key, entityDef] of Object.entries(schema.entities)) {
    if (entityDef.external === true) {
      out.add(key);
    }
  }
  return out;
}

function resolveNames(schema: SchemaDef): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, entityDef] of Object.entries(schema.entities)) {
    out.set(key, entityDef.name ?? pascalCase(key));
  }
  return out;
}

function pascalCase(input: string): string {
  if (input.length === 0) {
    return input;
  }
  return input[0].toUpperCase() + input.slice(1);
}

function createSyntheticClass(
  name: string,
  entityDef: EntityDef,
): typeof BaseModel {
  const defaults = collectDefaults(entityDef);
  const ctor =
    defaults.length === 0
      ? class extends BaseModel {}
      : class extends BaseModel {
          constructor() {
            super();
            for (const [key, value] of defaults) {
              (this as Record<string, unknown>)[key] = value;
            }
          }
        };

  Object.defineProperty(ctor, "name", { value: name });
  (ctor as { _modelName?: string })._modelName = name;
  return ctor;
}

function collectDefaults(
  entityDef: EntityDef,
): ReadonlyArray<readonly [string, unknown]> {
  const out: Array<[string, unknown]> = [];
  for (const [fieldName, builder] of Object.entries(entityDef.fields)) {
    if (builder.meta.kind === "id") {
      continue;
    }
    if ("default" in builder.meta && builder.meta.default !== undefined) {
      out.push([fieldName, builder.meta.default]);
    }
  }
  return out;
}

function registerField(
  ctor: typeof BaseModel,
  modelName: string,
  fieldName: string,
  builder: AnyFieldBuilder,
  nameByKey: ReadonlyMap<string, string>,
): void {
  const meta = builder.meta;
  if (meta.kind === "id") {
    return;
  }

  const propMeta: PropertyMeta = {
    name: fieldName,
    type:
      meta.kind === "refId"
        ? PropertyType.Reference
        : meta.ephemeral
          ? PropertyType.EphemeralProperty
          : PropertyType.Property,
  };
  if (meta.indexed) {
    propMeta.indexed = true;
  }
  if (meta.nullable) {
    propMeta.nullable = true;
  }
  if (meta.serializer != null) {
    propMeta.serializer = meta.serializer;
  }
  if (meta.deserializer != null) {
    propMeta.deserializer = meta.deserializer;
  }
  if (meta.kind === "refId" && meta.refTarget != null) {
    propMeta.referenceTo =
      nameByKey.get(meta.refTarget) ?? pascalCase(meta.refTarget);
  }

  ModelRegistry.registerProperty(modelName, propMeta);
  defineObservableProperty(ctor.prototype, fieldName);
}

function registerLink(
  linkDef: AnyLinkDef,
  externalKeys: ReadonlySet<string>,
  ctorByKey: ReadonlyMap<string, typeof BaseModel>,
  nameByKey: ReadonlyMap<string, string>,
): void {
  const fromExternal = externalKeys.has(linkDef.from.entity);
  const toExternal = externalKeys.has(linkDef.to.entity);
  const fromName = nameByKey.get(linkDef.from.entity)!;
  const toName = nameByKey.get(linkDef.to.entity)!;
  const fromCtor = ctorByKey.get(linkDef.from.entity);
  const toCtor = ctorByKey.get(linkDef.to.entity);
  const fkField = linkDef.from.field;
  const asField = linkDef.from.as;
  const manyField = linkDef.to.many;

  // From-side updates only apply when the source entity is owned by this
  // schema; for external sources we leave the FK property untouched on the
  // foreign class to avoid clobbering decorator-defined metadata.
  if (!fromExternal && fromCtor != null) {
    const refUpdates: Partial<PropertyMeta> = { lazy: true };
    if (linkDef.onDelete != null) {
      refUpdates.onDelete = linkDef.onDelete;
    }
    ModelRegistry.updateProperty(fromName, fkField, refUpdates);

    ModelRegistry.registerProperty(fromName, {
      name: asField,
      type: PropertyType.ReferenceModel,
      referenceTo: toName,
      idField: fkField,
    });
    installReferenceAccessor(fromCtor.prototype, asField, fkField, toName);
  }

  // To-side reverse-collection only when the target entity is owned by this
  // schema. Schema → decorator links don't pollute the decorator's prototype.
  if (!toExternal && toCtor != null) {
    ModelRegistry.registerProperty(toName, {
      name: manyField,
      type: PropertyType.ReferenceCollection,
      referenceTo: fromName,
      lazy: linkDef.to.lazy ?? true,
      inverseOf: fkField,
    });
    installCollectionAccessor(toCtor.prototype, manyField);
  }
}

function hashEntityMeta(meta: ModelMeta): number {
  const props = [...meta.properties.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((p) =>
      [
        p.name,
        p.type,
        `referenceTo=${p.referenceTo ?? ""}`,
        `inverseOf=${p.inverseOf ?? ""}`,
        `idField=${p.idField ?? ""}`,
        `idsField=${p.idsField ?? ""}`,
        `onDelete=${p.onDelete ?? ""}`,
        `lazy=${p.lazy === true}`,
        `nullable=${p.nullable === true}`,
        `indexed=${p.indexed === true}`,
        `serializer=${p.serializer != null}`,
        `deserializer=${p.deserializer != null}`,
      ].join(";"),
    )
    .join(",");
  return hashString(
    [
      meta.name,
      `loadStrategy=${meta.loadStrategy}`,
      `usedForPartialIndexes=${meta.usedForPartialIndexes}`,
      `props=[${props}]`,
    ].join("|"),
  );
}
