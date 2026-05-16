/**
 * ModelRegistry is a singleton that holds metadata for every model class.
 *
 * When decorators like @ClientModel and @Property run at class definition time,
 * they register information here. The rest of the engine reads from this
 * registry to know how to serialize, hydrate, observe, and sync each model.
 *
 * Also computes a schemaHash — a fingerprint of all models and their properties.
 * If the hash changes between sessions, the local IndexedDB needs a migration.
 */

import type { BaseModel } from "./BaseModel";
import { hashString } from "./hash";
import {
  type ModelMeta,
  type PropertyMeta,
  type CoveringPath,
  LoadStrategy,
  PropertyType,
} from "./types";

class ModelRegistryImpl {
  private models = new Map<string, ModelMeta>();
  private cachedHash: string | null = null;

  /** Register a model class. Returns existing metadata if already registered. */
  registerModel(
    name: string,
    ctor: new (...args: unknown[]) => unknown,
  ): ModelMeta {
    if (!this.models.has(name)) {
      this.models.set(name, {
        name,
        loadStrategy: LoadStrategy.Eager,
        usedForPartialIndexes: false,
        properties: new Map(),
        actions: new Set(),
        computedProps: new Set(),
        ctor: ctor as new () => BaseModel,
        schemaVersion: 1,
      });
    }
    // Any registry change invalidates downstream caches.
    this.cachedHash = null;
    this.coveringPathsCache.clear();
    return this.models.get(name)!;
  }

  /** Register a property on a model. */
  registerProperty(modelName: string, prop: PropertyMeta) {
    const meta = this.models.get(modelName);
    if (meta == null) {
      throw new Error(`Model "${modelName}" not registered`);
    }
    meta.properties.set(prop.name, prop);
    this.cachedHash = null;
    this.coveringPathsCache.clear();
  }

  /**
   * Merge partial metadata into an already-registered property.
   * Used by @Reference to promote a user-declared @Property to PropertyType.Reference,
   * adding referenceTo / onDelete / nullable without losing indexed / serializer etc.
   */
  updateProperty(
    modelName: string,
    propertyName: string,
    updates: Partial<PropertyMeta>,
  ) {
    const meta = this.models.get(modelName);
    if (meta == null) {
      throw new Error(`Model "${modelName}" not registered`);
    }
    const existing = meta.properties.get(propertyName);
    if (existing == null) {
      throw new Error(
        `Property "${propertyName}" not found on model "${modelName}". ` +
          `Declare it with @Property() before applying @Reference.`,
      );
    }
    meta.properties.set(propertyName, { ...existing, ...updates });
    this.cachedHash = null;
    this.coveringPathsCache.clear();
  }

  registerAction(modelName: string, name: string) {
    this.models.get(modelName)?.actions.add(name);
  }

  registerComputed(modelName: string, name: string) {
    this.models.get(modelName)?.computedProps.add(name);
  }

  /** Look up metadata by model name. */
  getModelMeta(name: string): ModelMeta | undefined {
    return this.models.get(name);
  }

  /** Look up metadata from a model instance (reads the class name). */
  getMetaForInstance(instance: object): ModelMeta | undefined {
    const name = (instance.constructor as { _modelName?: string })._modelName;
    return name != null ? this.models.get(name) : undefined;
  }

  /** Get all registered model metadata. */
  allModels(): ModelMeta[] {
    return [...this.models.values()];
  }

  /** Names of every Eager-load-strategy model. Lazy / Partial /
   * LocalOnly / Ephemeral models are loaded on demand or
   * via SSE — never via a full-bootstrap payload. */
  eagerModelNames(): string[] {
    const out: string[] = [];
    for (const meta of this.models.values()) {
      if (meta.loadStrategy === LoadStrategy.Eager) {
        out.push(meta.name);
      }
    }
    return out;
  }

  /** Names of models that pre-subscribe to SSE deltas regardless of whether
   * any rows have been loaded locally — Eager (always fully loaded) and
   * Ephemeral (pool-only, fed by SSE). The catchup URL unions this with the
   * adapter's `loadedModels` so an Eager model the server happens to have
   * zero rows for in this workspace still receives future inserts. */
  alwaysSubscribedModelNames(): string[] {
    const out: string[] = [];
    for (const meta of this.models.values()) {
      if (
        meta.loadStrategy === LoadStrategy.Eager ||
        meta.loadStrategy === LoadStrategy.Ephemeral
      ) {
        out.push(meta.name);
      }
    }
    return out;
  }

  private coveringPathsCache = new Map<string, CoveringPath[]>();

  /**
   * Auto-derive covering axes for a `RefCollection<child>` declared on
   * `parentModel`. Walks `parentModel`'s outgoing FK chain up to `maxDepth`
   * hops; at each level checks whether the child has the same FK name as an
   * indexed property (denormalization). Each match becomes a `CoveringPath`
   * resolved later at hydrate time.
   *
   * Cycle-detected (a model in the chain isn't traversed twice). Cached per
   * `(parent, child, depth)` triple. Result is union'd with the manual
   * `coveringIndexes` decorator option at the call site.
   */
  getDerivedCoveringPaths(
    parentModelName: string,
    childModelName: string,
    maxDepth: number,
  ): CoveringPath[] {
    if (maxDepth < 1) {
      return [];
    }
    const key = `${parentModelName}|${childModelName}|${maxDepth}`;
    const cached = this.coveringPathsCache.get(key);
    if (cached != null) {
      return cached;
    }
    const childMeta = this.models.get(childModelName);
    if (childMeta == null) {
      this.coveringPathsCache.set(key, []);
      return [];
    }
    const childIndexed = new Set<string>();
    for (const prop of childMeta.properties.values()) {
      if (prop.indexed === true) {
        childIndexed.add(prop.name);
      }
    }
    if (childIndexed.size === 0) {
      this.coveringPathsCache.set(key, []);
      return [];
    }
    const out: CoveringPath[] = [];
    this.walkCoveringPaths(
      parentModelName,
      childIndexed,
      maxDepth,
      [],
      new Set([parentModelName]),
      out,
    );
    this.coveringPathsCache.set(key, out);
    return out;
  }

  private walkCoveringPaths(
    currentModel: string,
    childIndexed: ReadonlySet<string>,
    remainingDepth: number,
    soFar: { fk: string; throughModel: string }[],
    visited: Set<string>,
    out: CoveringPath[],
  ): void {
    if (remainingDepth <= 0) {
      return;
    }
    const meta = this.models.get(currentModel);
    if (meta == null) {
      return;
    }
    for (const prop of meta.properties.values()) {
      if (prop.type !== PropertyType.Reference || prop.referenceTo == null) {
        continue;
      }
      const hop = { fk: prop.name, throughModel: prop.referenceTo };
      const nextHops = [...soFar, hop];
      if (childIndexed.has(prop.name)) {
        out.push({ axis: prop.name, hops: nextHops });
      }
      if (remainingDepth > 1 && !visited.has(prop.referenceTo)) {
        visited.add(prop.referenceTo);
        this.walkCoveringPaths(
          prop.referenceTo,
          childIndexed,
          remainingDepth - 1,
          nextHops,
          visited,
          out,
        );
        visited.delete(prop.referenceTo);
      }
    }
  }

  /**
   * A hash of all model names, versions, load strategies, and property metadata.
   * Used to detect when IndexedDB needs a migration.
   */
  get schemaHash(): string {
    if (this.cachedHash != null) {
      return this.cachedHash;
    }

    const sorted = [...this.models.entries()].sort(([a], [b]) =>
      a.localeCompare(b),
    );
    const parts = sorted.map(([name, meta]) => {
      const props = [...meta.properties.values()]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((prop) =>
          [
            prop.name,
            prop.type,
            `lazy=${prop.lazy === true}`,
            `nullable=${prop.nullable === true}`,
            `indexed=${prop.indexed === true}`,
            `serializer=${prop.serializer != null}`,
            `deserializer=${prop.deserializer != null}`,
            `referenceTo=${prop.referenceTo ?? ""}`,
            `inverseOf=${prop.inverseOf ?? ""}`,
            `idField=${prop.idField ?? ""}`,
            `idsField=${prop.idsField ?? ""}`,
            `onDelete=${prop.onDelete ?? ""}`,
            `coveringIndexes=${(prop.coveringIndexes ?? []).join("|")}`,
          ].join(";"),
        )
        .join(",");

      return [
        name,
        `version=${meta.schemaVersion}`,
        `loadStrategy=${meta.loadStrategy}`,
        `usedForPartialIndexes=${meta.usedForPartialIndexes}`,
        `props=[${props}]`,
      ].join(":");
    });

    this.cachedHash = hashString(parts.join("|")).toString(36);
    return this.cachedHash;
  }
}

export const ModelRegistry = new ModelRegistryImpl();
