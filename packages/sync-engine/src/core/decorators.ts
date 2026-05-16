/**
 * Decorators for defining models and their properties.
 *
 * Usage looks like:
 *
 *   @ClientModel({ loadStrategy: LoadStrategy.Eager })
 *   class Issue extends BaseModel {
 *     @Property() title = "";
 *     @Reference("User", { nullable: true }) assignee: any;
 *     @Action moveToTeam(id: string) { ... }
 *     @Computed get identifier() { ... }
 *   }
 *
 * Each decorator registers metadata in the ModelRegistry at class-definition
 * time. The engine reads that metadata later for serialization, hydration,
 * observability, indexing, and reference resolution.
 */

import { ModelRegistry } from "./ModelRegistry";
import { defineObservableProperty } from "./observability";
import {
  PropertyType,
  LoadStrategy,
  type PropertyMeta,
  type ModelMeta,
} from "./types";
import {
  installBackRefAccessor,
  installCollectionAccessor,
  installReferenceAccessor,
} from "./refAccessors";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ctor = new (...args: any[]) => any;

// Side-table for property/action/computed metadata declared via decorators.
// Property decorators run during class-body evaluation — BEFORE @ClientModel
// runs on the concrete subclass — so they can't write directly to the
// ModelRegistry without registering abstract base classes too. Instead they
// stash here, keyed by constructor reference, and @ClientModel drains the
// chain at register-time. Abstract bases never enter the registry.
interface PendingClassMeta {
  properties: Map<string, PropertyMeta>;
  actions: Set<string>;
  computedProps: Set<string>;
}
const pendingByClass = new WeakMap<Ctor, PendingClassMeta>();

function getOrCreatePending(ctor: Ctor): PendingClassMeta {
  let entry = pendingByClass.get(ctor);
  if (entry == null) {
    entry = {
      properties: new Map(),
      actions: new Set(),
      computedProps: new Set(),
    };
    pendingByClass.set(ctor, entry);
  }
  return entry;
}

function stashProperty(ctor: Ctor, prop: PropertyMeta): void {
  getOrCreatePending(ctor).properties.set(prop.name, prop);
}

function updateStashedProperty(
  ctor: Ctor,
  name: string,
  updates: Partial<PropertyMeta>,
): void {
  const pending = getOrCreatePending(ctor);
  const existing = pending.properties.get(name);
  if (existing == null) {
    throw new Error(
      `Property "${name}" not found on model "${ctor.name}". ` +
        `Declare it with @Property() before applying @Reference.`,
    );
  }
  pending.properties.set(name, { ...existing, ...updates });
}

function stashAction(ctor: Ctor, name: string): void {
  getOrCreatePending(ctor).actions.add(name);
}

function stashComputed(ctor: Ctor, name: string): void {
  getOrCreatePending(ctor).computedProps.add(name);
}

/** Walk the prototype chain from `ctor`, draining each class's pending
 * metadata into `meta`. Pending entries are NOT deleted on drain so multiple
 * subclasses sharing an abstract base each inherit independently, AND deeper
 * chains (`A extends B extends M`, where B is itself a live model) keep
 * working — when @ClientModel runs on A it re-walks pending(B) which still
 * holds B's declarations.
 *
 * Subclass-declared properties win over ancestor-declared ones with the same
 * name (`Map.set` is no-op-when-present via the `has` guard).
 */
function drainPendingChain(ctor: Ctor, meta: ModelMeta): void {
  // Walk the *constructor* chain (not the prototype chain): for
  // `class B extends A`, `Object.getPrototypeOf(B)` returns `A`, and the
  // chain terminates at `Function.prototype`. Stopping there is sufficient;
  // no model class extends `Object` directly.
  let current: unknown = ctor;
  while (current != null && current !== Function.prototype) {
    const pending = pendingByClass.get(current as Ctor);
    if (pending != null) {
      for (const [name, prop] of pending.properties) {
        if (!meta.properties.has(name)) {
          meta.properties.set(name, prop);
        }
      }
      for (const action of pending.actions) {
        meta.actions.add(action);
      }
      for (const computed of pending.computedProps) {
        meta.computedProps.add(computed);
      }
    }
    current = Object.getPrototypeOf(current);
  }
}

// ---------------------------------------------------------------------------
// @ClientModel — class decorator
//
// Registers the model name, constructor, and load strategy in the registry.
// ---------------------------------------------------------------------------

// Module-scoped (not global) ambient so the dom-only lib typechecks while
// keeping the literal `process.env.NODE_ENV` that bundlers statically
// replace — the warning compiles out of production browser builds.
declare const process:
  | { env?: { NODE_ENV?: string } }
  | undefined;

/** Models registered without an explicit `name`, for the one-shot dev warning. */
const ctorNameFallbacks = new Set<string>();

export function ClientModel(
  opts: {
    /**
     * The registry name — what `ModelMeta.name` becomes, what
     * cross-references resolve against, and the typed handle for
     * `useRecord(Model, …)`. Defaults to `ctor.name`, which minifiers
     * mangle in production: pass an explicit `name` (or configure your
     * bundler's `keep_classnames`) for any shipped build.
     */
    name?: string;
    loadStrategy?: LoadStrategy;
    usedForPartialIndexes?: boolean;
    schemaVersion?: number;
  } = {},
) {
  // Legacy decorator target — no better type exists for prototype manipulation
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return function <T extends new (...args: any[]) => any>(ctor: T) {
    const modelName = opts.name ?? ctor.name;
    if (
      opts.name == null &&
      typeof process !== "undefined" &&
      process.env?.NODE_ENV !== "production" &&
      !ctorNameFallbacks.has(modelName)
    ) {
      ctorNameFallbacks.add(modelName);
      console.warn(
        `[sync-engine] @ClientModel on "${modelName}" has no explicit ` +
          `{ name } and is keyed on ctor.name. Minified production builds ` +
          `mangle class names — pass @ClientModel({ name: "${modelName}" }) ` +
          `or set your bundler's keep_classnames.`,
      );
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (ctor as any)._modelName = modelName;
    const meta = ModelRegistry.registerModel(modelName, ctor);
    if (opts.loadStrategy != null) {
      meta.loadStrategy = opts.loadStrategy;
    }
    if (opts.usedForPartialIndexes != null) {
      meta.usedForPartialIndexes = opts.usedForPartialIndexes;
    }
    if (opts.schemaVersion != null) {
      meta.schemaVersion = opts.schemaVersion;
    }
    // Drain decorator-stashed metadata for this class and every ancestor up
    // the prototype chain. Abstract bases never registered themselves; their
    // pending entries are read-only from this point on (so siblings sharing
    // a base each inherit independently).
    drainPendingChain(ctor, meta);
    return ctor;
  };
}

// ---------------------------------------------------------------------------
// @Property — persisted, observable property
// ---------------------------------------------------------------------------

export function Property(
  opts: {
    indexed?: boolean;
    // Legacy decorator target — no better type exists for prototype manipulation
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    serializer?: (v: any) => any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    deserializer?: (v: any) => any;
  } = {},
) {
  // Legacy decorator target — no better type exists for prototype manipulation
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return function (target: any, key: string) {
    stashProperty(target.constructor, {
      name: key,
      type: PropertyType.Property,
      indexed: opts.indexed,
      serializer: opts.serializer,
      deserializer: opts.deserializer,
    });
    defineObservableProperty(target, key);
  };
}

// ---------------------------------------------------------------------------
// @EphemeralProperty — observable but NOT persisted to IndexedDB
// ---------------------------------------------------------------------------

export function EphemeralProperty() {
  // Legacy decorator target — no better type exists for prototype manipulation
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return function (target: any, key: string) {
    stashProperty(target.constructor, {
      name: key,
      type: PropertyType.EphemeralProperty,
    });
    defineObservableProperty(target, key);
  };
}

// ---------------------------------------------------------------------------
// @Reference / @LazyReference — links a user-declared ID field to a virtual
// model accessor.
//
// The user declares the ID field explicitly with @Property:
//
//   @Property({ indexed: true }) teamId = "";
//   @Reference("Team", { onDelete: "cascade" }) declare team: Team;
//
// The decorator:
//   1. Promotes `teamId` from PropertyType.Property → PropertyType.Reference.
//   2. Registers `team` as a virtual PropertyType.ReferenceModel (not persisted).
//   3. Defines a getter/setter that links `team` ↔ `teamId`.
//
// The ID field name defaults to `${key}Id` but can be overridden with idField:
//   @Reference("Team", { idField: "parentTeamId" }) declare team: Team;
//
// `@Reference`     — eager: makeModelObservable() pulls the referenced model
//                    into the pool via storeManager.getOrLoadById so the accessor
//                    doesn't return null on first read.
// `@LazyReference` — lazy: the getter returns whatever is in the pool right
//                    now (or null); no automatic load.
// ---------------------------------------------------------------------------

interface ReferenceOpts {
  nullable?: boolean;
  idField?: string;
  onDelete?: "cascade" | "nullify" | "restrict";
}

function defineReference(
  lazy: boolean,
  referenceTo: string,
  opts: ReferenceOpts,
) {
  // Legacy decorator target — no better type exists for prototype manipulation
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return function (target: any, key: string) {
    const idKey = opts.idField ?? key + "Id";

    updateStashedProperty(target.constructor, idKey, {
      type: PropertyType.Reference,
      referenceTo,
      nullable: opts.nullable,
      onDelete: opts.onDelete,
      lazy,
    });

    stashProperty(target.constructor, {
      name: key,
      type: PropertyType.ReferenceModel,
      referenceTo,
      idField: idKey,
    });

    installReferenceAccessor(target, key, idKey, referenceTo);
  };
}

export function Reference(referenceTo: string, opts: ReferenceOpts = {}) {
  return defineReference(false, referenceTo, opts);
}

export function LazyReference(referenceTo: string, opts: ReferenceOpts = {}) {
  return defineReference(true, referenceTo, opts);
}

// ---------------------------------------------------------------------------
// @ReferenceCollection / @LazyReferenceCollection — one-to-many from parent side.
//
// Registers metadata only. The runtime `RefCollection` object is created during
// BaseModel.makeModelObservable() and exposes `.items`, `.load()`, `.isLoaded`,
// `.isLoading`, `.resolveFromPool()`, etc.
//
//   const issues = team.issues;              // RefCollection
//   const items = issues.resolveFromPool(pool); // sync, from memory
//   await issues.load();                     // async, from IDB
//   issues.items;                            // the loaded models
//
// `@ReferenceCollection`     — eager: makeModelObservable() fires `.load()` so
//                              children land in the pool alongside the parent.
//                              Recursion is automatic.
// `@LazyReferenceCollection` — lazy: collection stays Idle until something
//                              calls `.load()` or the React hook subscribes.
// ---------------------------------------------------------------------------

interface ReferenceCollectionOpts {
  inverseOf?: string;
  /**
   * Names of additional FK fields on the parent model that should each become
   * an extra query when the collection loads. The loader unions the results.
   * Use for multi-axis lazy queries (e.g. "all comments for this issue PLUS
   * everything in the sync groups the user belongs to").
   */
  coveringIndexes?: string[];
}

function defineReferenceCollection(
  lazy: boolean,
  referenceTo: string,
  opts: ReferenceCollectionOpts,
) {
  // Legacy decorator target — no better type exists for prototype manipulation
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return function (target: any, key: string) {
    const modelName = target.constructor.name;

    // Derive the foreign key on the child model. Convention: parentModelName
    // (lowercased first char) + "Id". Override with inverseOf when needed.
    const inverseKey =
      opts.inverseOf ??
      modelName.charAt(0).toLowerCase() + modelName.slice(1) + "Id";

    stashProperty(target.constructor, {
      name: key,
      type: PropertyType.ReferenceCollection,
      referenceTo,
      lazy,
      inverseOf: inverseKey,
      coveringIndexes: opts.coveringIndexes,
    });

    installCollectionAccessor(target, key);
  };
}

export function ReferenceCollection(
  referenceTo: string,
  opts: ReferenceCollectionOpts = {},
) {
  return defineReferenceCollection(false, referenceTo, opts);
}

export function LazyReferenceCollection(
  referenceTo: string,
  opts: ReferenceCollectionOpts = {},
) {
  return defineReferenceCollection(true, referenceTo, opts);
}

// ---------------------------------------------------------------------------
// @BackReference — inverse of a Reference
//
// Metadata-only registration. The runtime BackRef is created in
// BaseModel.makeModelObservable().
//
// Key behavior: a BackReference is "owned" by the referenced model.
// When the owning model is deleted, the back-referenced model is also removed.
// This cascade is handled in SyncConnection during delta packet processing.
// ---------------------------------------------------------------------------

export function BackReference(referenceTo: string, inverseOf: string) {
  // Legacy decorator target — no better type exists for prototype manipulation
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return function (target: any, key: string) {
    stashProperty(target.constructor, {
      name: key,
      type: PropertyType.BackReference,
      referenceTo,
      inverseOf,
    });

    installBackRefAccessor(target, key);
  };
}

// ---------------------------------------------------------------------------
// @ReferenceArray — many-to-many stored as array of IDs
// ---------------------------------------------------------------------------

export function ReferenceArray(referenceTo: string) {
  // Legacy decorator target — no better type exists for prototype manipulation
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return function (target: any, key: string) {
    stashProperty(target.constructor, {
      name: key,
      type: PropertyType.ReferenceArray,
      referenceTo,
    });
    defineObservableProperty(target, key);
  };
}

// ---------------------------------------------------------------------------
// @OwnedCollection / @LazyOwnedCollection — many-to-many where the parent
// owns an array of IDs.
//
// The parent stores the IDs as a @Property; the decorator wraps that array
// with a runtime `OwnedRefs` collection.
//
//   @Property()
//   public issueIds: string[] = [];
//
//   @OwnedCollection("Issue", { idsField: "issueIds" })
//   public issues: OwnedRefs<Issue>;
//
// `@OwnedCollection`     — eager: makeModelObservable() fires `.load()`.
// `@LazyOwnedCollection` — lazy: collection stays Idle until `.load()` is called.
// ---------------------------------------------------------------------------

interface OwnedCollectionOpts {
  idsField: string;
}

function defineOwnedCollection(
  lazy: boolean,
  referenceTo: string,
  opts: OwnedCollectionOpts,
) {
  // Legacy decorator target — no better type exists for prototype manipulation
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return function (target: any, key: string) {
    stashProperty(target.constructor, {
      name: key,
      type: PropertyType.OwnedCollection,
      referenceTo,
      idsField: opts.idsField,
      lazy,
    });

    installCollectionAccessor(target, key);
  };
}

export function OwnedCollection(
  referenceTo: string,
  opts: OwnedCollectionOpts,
) {
  return defineOwnedCollection(false, referenceTo, opts);
}

export function LazyOwnedCollection(
  referenceTo: string,
  opts: OwnedCollectionOpts,
) {
  return defineOwnedCollection(true, referenceTo, opts);
}

// ---------------------------------------------------------------------------
// @Action and @Computed — register method names for MobX wiring
// ---------------------------------------------------------------------------

// Legacy decorator target — no better type exists for prototype manipulation
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function Action(target: any, key: string, _d: PropertyDescriptor) {
  stashAction(target.constructor, key);
}

// Legacy decorator target — no better type exists for prototype manipulation
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function Computed(target: any, key: string, _d: PropertyDescriptor) {
  stashComputed(target.constructor, key);
}
