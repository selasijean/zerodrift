/**
 * ObjectPool — the in-memory cache of all hydrated model instances.
 *
 * Structure: Map<modelName, Map<uuid, modelInstance>>
 *
 * This is what @Reference getters resolve against when you access
 * `issue.assignee` — it looks up the User by ID in this pool.
 *
 * Subscription system:
 *   React hooks subscribe to specific model types. When a delta packet
 *   adds, updates, or removes an instance of that type, all subscribers
 *   are notified and their components re-render.
 */

import { createAtom, runInAction, type IAtom } from "mobx";
import type { BaseModel } from "./BaseModel";
import { ModelRegistry } from "./ModelRegistry";
import { PropertyType, type ModelMeta } from "./types";
import type {
  LazyCollectionBase,
  RefCollection,
  BackRef,
} from "./LazyCollection";

type Listener = () => void;
interface Subscription {
  predicate?: (model: BaseModel) => boolean;
  listener: Listener;
}

/** A parent-side declaration that points back at a given child model type. */
interface InverseDecl {
  parentModelName: string;
  parentPropName: string;
  /** The FK field on the child model whose value identifies the parent. */
  fkName: string;
  kind: PropertyType.ReferenceCollection | PropertyType.BackReference;
}

type InverseLinkTarget = LazyCollectionBase | BackRef;

/**
 * Read a dynamic property off a model instance. The single bridge between
 * the typed `BaseModel` shape and the index-string access we need for
 * runtime field reflection (covering paths, predicate filters, etc.).
 */
export function prop(model: BaseModel, key: string): unknown {
  return (model as unknown as Record<string, unknown>)[key];
}

/** Read a dynamic FK property off a model instance, or null if missing/empty. */
export function readFk(instance: BaseModel, key: string): string | null {
  const v = prop(instance, key);
  return typeof v === "string" && v !== "" ? v : null;
}

export class ObjectPool {
  private pool = new Map<string, Map<string, BaseModel>>();
  private snapshotCache = new Map<string, BaseModel[]>();

  /**
   * Subscribers per model type. When the pool changes for a given type,
   * all listeners for that type are called, triggering React re-renders.
   */
  private listeners = new Map<string, Set<Subscription>>();

  /**
   * Per-`(modelName, id)` MobX atoms. Each atom is bumped when the entry
   * is added, removed, or replaced — bridging pool identity changes into
   * the MobX dependency graph. The `@Reference` getter calls `trackModel`
   * to register a tracked read, so observers wake when the underlying
   * pool entry transitions even if the holder's foreign key didn't change.
   * Atoms are created lazily on first observation and dropped automatically
   * when no observer remains.
   */
  private modelAtoms = new Map<string, IAtom>();

  /**
   * Register a tracked MobX dependency on the pool entry for `(modelName, id)`.
   * Bumped from `put` (when the entry is new) and `remove`, so observers
   * reading the entry through `@Reference` re-run on identity changes — not
   * just on FK changes.
   */
  trackModel(modelName: string, id: string): void {
    const key = `${modelName}:${id}`;
    let atom = this.modelAtoms.get(key);
    const wasJustCreated = atom == null;
    if (atom == null) {
      atom = createAtom(
        key,
        undefined,
        () => this.modelAtoms.delete(key),
      );
      this.modelAtoms.set(key, atom);
    }
    // reportObserved returns true iff a derivation is currently tracking. If
    // we created the atom for a non-reactive read (event handler, JSON walk,
    // etc.) the onUnobserved callback won't fire later, so drop the entry now
    // to keep modelAtoms bounded.
    if (!atom.reportObserved() && wasJustCreated) {
      this.modelAtoms.delete(key);
    }
  }

  /** Bump the atom for `(modelName, id)` if any observer is currently tracking it. */
  private notifyModelChanged(modelName: string, id: string): void {
    this.modelAtoms.get(`${modelName}:${id}`)?.reportChanged();
  }

  /**
   * Subscribe to changes for a model type. The optional `predicate` runs
   * against the affected record on `put` / `remove` and the listener only
   * fires when it returns true; `clear` always fires every listener since
   * the affected record is gone by definition.
   *
   * Predicate filtering covers **set-membership changes** (a record was
   * added or removed). It does NOT see field-level reassignments — a child
   * moving between FK buckets via `child.teamId = "..."` goes through MobX
   * boxes, not `notify`. Pair with `record.watch` if you need to react to
   * field changes that cross a filter boundary.
   *
   * Returns an unsubscribe function.
   */
  subscribe(modelName: string, listener: Listener): () => void;
  subscribe(
    modelName: string,
    predicate: (model: BaseModel) => boolean,
    listener: Listener,
  ): () => void;
  subscribe(
    modelName: string,
    a: Listener | ((model: BaseModel) => boolean),
    b?: Listener,
  ): () => void {
    const sub: Subscription =
      b != null
        ? { predicate: a as (model: BaseModel) => boolean, listener: b }
        : { listener: a as Listener };
    if (!this.listeners.has(modelName)) {
      this.listeners.set(modelName, new Set());
    }
    this.listeners.get(modelName)!.add(sub);
    return () => {
      this.listeners.get(modelName)?.delete(sub);
    };
  }

  private notify(modelName: string, affected?: BaseModel) {
    const subs = this.listeners.get(modelName);
    if (subs == null) {
      return;
    }
    for (const sub of subs) {
      if (sub.predicate != null && affected != null && !sub.predicate(affected)) {
        continue;
      }
      sub.listener();
    }
  }

  // ── Core operations (notify on mutation) ──────────────────────────────────

  getById<T extends BaseModel = BaseModel>(
    modelName: string,
    id: string,
  ): T | undefined {
    return this.pool.get(modelName)?.get(id) as T | undefined;
  }

  /** Store a model instance. Notifies subscribers. */
  put(modelName: string, instance: BaseModel) {
    if (!this.pool.has(modelName)) {
      this.pool.set(modelName, new Map());
    }
    const bucket = this.pool.get(modelName)!;
    const wasNew = !bucket.has(instance.id);
    bucket.set(instance.id, instance);
    instance.store = this;
    this.snapshotCache.delete(modelName);

    // First-time entry: wire inverse links and bump the per-id atom. Re-puts
    // for an in-place hydrate skip this — the model's own MobX boxes already
    // report their property changes, so observers don't need a duplicate poke.
    if (wasNew) {
      runInAction(() => {
        this.attachInverseLinks(modelName, instance);
        this.populateOwnedCollectionsFromPool(modelName, instance);
        this.notifyModelChanged(modelName, instance.id);
      });
    }

    this.notify(modelName, instance);
  }

  /** Remove a model. Notifies subscribers. */
  remove(modelName: string, id: string) {
    const instance = this.pool.get(modelName)?.get(id);
    runInAction(() => {
      if (instance != null) {
        this.detachInverseLinks(modelName, instance);
      }
      this.pool.get(modelName)?.delete(id);
      this.snapshotCache.delete(modelName);
      this.notifyModelChanged(modelName, id);
    });
    this.notify(modelName, instance);
  }

  getAll<T extends BaseModel = BaseModel>(modelName: string): T[] {
    let snapshot = this.snapshotCache.get(modelName);
    if (snapshot === undefined) {
      const bucket = this.pool.get(modelName);
      snapshot = bucket != null ? [...bucket.values()] : [];
      this.snapshotCache.set(modelName, snapshot);
    }
    return snapshot as T[];
  }

  get size(): number {
    let total = 0;
    for (const bucket of this.pool.values()) {
      total += bucket.size;
    }
    return total;
  }

  counts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [name, bucket] of this.pool) {
      out[name] = bucket.size;
    }
    return out;
  }

  /**
   * Create an instance from raw data, hydrate it, make it observable,
   * and add it to the pool. Used everywhere a new model arrives from
   * the server or IDB.
   */
  hydrateAndPut(
    modelName: string,
    meta: ModelMeta,
    data: Record<string, unknown>,
  ): BaseModel {
    const id = data.id as string | undefined;
    if (id != null) {
      const existing = this.getById(modelName, id);
      if (existing != null) {
        existing.hydrate(data);
        return existing;
      }
    }
    const inst = new meta.ctor();
    inst.hydrate(data);
    inst.makeModelObservable();
    this.put(modelName, inst);
    return inst;
  }

  clear() {
    const names = [...this.pool.keys()];
    // Snapshot atoms before iterating: reportChanged can disturb the map via
    // onUnobserved as observers detach.
    const atoms = [...this.modelAtoms.values()];
    this.pool.clear();
    this.snapshotCache.clear();
    for (const atom of atoms) {
      atom.reportChanged();
    }
    names.forEach((n) => this.notify(n));
  }

  // ── Inverse link maintenance ──────────────────────────────────────────────
  //
  // Children push themselves into their parents' RefCollection / BackRef as
  // they enter and leave the pool — no manual invalidation, no re-query.
  // Walked from the parent side so plain @Property foreign keys work the
  // same as @Reference-typed ones. Mirrors how Linear's framework does
  // inverse attachment from the child's setter path.

  /**
   * Memoized parent-side declarations targeting a given child model. The
   * registry is decorator-load-time only, so the cache lives for the pool's
   * lifetime.
   */
  private inverseDeclCache = new Map<string, InverseDecl[]>();

  /** Set of FK property names that are an `inverseOf` on some parent's decl.
   * Lets `notifyReferenceChange` skip the work for plain property writes
   * (`title`, `done`, ...) without iterating decls. */
  private inverseFkCache = new Map<string, Set<string>>();

  private inverseDeclarations(childModelName: string): InverseDecl[] {
    let cached = this.inverseDeclCache.get(childModelName);
    if (cached != null) {
      return cached;
    }
    cached = [];
    for (const parentMeta of ModelRegistry.allModels()) {
      for (const [propName, propMeta] of parentMeta.properties) {
        if (propMeta.referenceTo !== childModelName) {
          continue;
        }
        if (propMeta.inverseOf == null) {
          continue;
        }
        if (
          propMeta.type !== PropertyType.ReferenceCollection &&
          propMeta.type !== PropertyType.BackReference
        ) {
          continue;
        }
        cached.push({
          parentModelName: parentMeta.name,
          parentPropName: propName,
          fkName: propMeta.inverseOf,
          kind: propMeta.type,
        });
      }
    }
    this.inverseDeclCache.set(childModelName, cached);
    return cached;
  }

  private inverseFkNames(childModelName: string): Set<string> {
    let cached = this.inverseFkCache.get(childModelName);
    if (cached != null) {
      return cached;
    }
    cached = new Set(
      this.inverseDeclarations(childModelName).map((d) => d.fkName),
    );
    this.inverseFkCache.set(childModelName, cached);
    return cached;
  }

  /** Resolve the parent's runtime collection / back-ref for an inverse decl. */
  private inverseTarget(
    decl: InverseDecl,
    parentId: string,
  ): InverseLinkTarget | undefined {
    const parent = this.getById(decl.parentModelName, parentId);
    if (parent == null) {
      return undefined;
    }
    if (decl.kind === PropertyType.ReferenceCollection) {
      return parent.__collections[decl.parentPropName];
    }
    return parent.__backRefs[decl.parentPropName];
  }

  private attachInverseLinks(modelName: string, instance: BaseModel) {
    for (const decl of this.inverseDeclarations(modelName)) {
      const fk = readFk(instance, decl.fkName);
      if (fk != null) {
        this.inverseTarget(decl, fk)?.attach(instance);
      }
    }
  }

  private detachInverseLinks(modelName: string, instance: BaseModel) {
    for (const decl of this.inverseDeclarations(modelName)) {
      const fk = readFk(instance, decl.fkName);
      if (fk != null) {
        this.inverseTarget(decl, fk)?.detach(instance.id);
      }
    }
  }

  /**
   * When a parent enters the pool after its children, seed each declared
   * collection / back-ref from children already in the pool. Counterpart
   * to `attachInverseLinks` on the parent side.
   */
  private populateOwnedCollectionsFromPool(
    modelName: string,
    instance: BaseModel,
  ) {
    const meta = ModelRegistry.getModelMeta(modelName);
    if (meta == null) {
      return;
    }

    for (const [propName, propMeta] of meta.properties) {
      if (propMeta.type === PropertyType.ReferenceCollection) {
        const collection = instance.__collections[propName] as
          | RefCollection
          | undefined;
        if (collection == null) {
          continue;
        }
        const matches = collection.resolveFromPool(this);
        if (matches.length > 0) {
          collection.setItems(matches);
        }
      } else if (propMeta.type === PropertyType.BackReference) {
        const backRef = instance.__backRefs[propName];
        if (backRef == null) {
          continue;
        }
        const match = backRef.resolveFromPool(this);
        if (match != null) {
          backRef.attach(match);
        }
      }
    }
  }

  /**
   * Called by BaseModel when a child's foreign-key property changes — either
   * via the prototype setter or via `box.set` in hydrate. Detaches from the
   * old parent and attaches to the new one in a single batched action.
   */
  notifyReferenceChange(
    child: BaseModel,
    childModelName: string,
    fkName: string,
    oldId: string | null,
    newId: string | null,
  ) {
    if (oldId === newId) {
      return;
    }
    // Hot-path gate: skip the runInAction frame and the loop entirely when the
    // changed property isn't an `inverseOf` for any parent. propertyChanged
    // calls this for every tracked write (title, done, updatedAt, ...) — most
    // of which aren't FKs.
    if (!this.inverseFkNames(childModelName).has(fkName)) {
      return;
    }
    runInAction(() => {
      for (const decl of this.inverseDeclarations(childModelName)) {
        if (decl.fkName !== fkName) {
          continue;
        }
        if (oldId != null) {
          this.inverseTarget(decl, oldId)?.detach(child.id);
        }
        if (newId != null) {
          this.inverseTarget(decl, newId)?.attach(child);
        }
      }
    });
  }
}
