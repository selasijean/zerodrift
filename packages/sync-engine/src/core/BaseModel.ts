/**
 * BaseModel — the base class for all sync engine models.
 *
 * Lifecycle:
 *   1. `new Issue()`            — raw construction, observability OFF
 *   2. `issue.hydrate(data)`    — populate flat values, recursive for embedded objects
 *   3. `issue.makeModelObservable()` — create MobX boxes + RefCollections
 *   4. `issue.title = "..."`    — setter fires, tracked in pendingChanges
 *   5. `issue.save()`           — builds transaction, auto-commits to server
 *
 * makeModelObservable() creates the runtime relationship objects:
 *   - RefCollection for @ReferenceCollection properties
 *   - BackRef for @BackReference properties
 * These are stored on __collections and __backRefs, read by the decorator getters.
 */

import { ModelRegistry } from "./ModelRegistry";
import {
  PropertyType,
  DEFAULT_TRANSIENT_INDEX_DEPTH,
  type PropertyChange,
  type IObjectPool,
  type IStoreManager,
} from "./types";
import { LazyCollectionBase, RefCollection, BackRef } from "./LazyCollection";
import { OwnedRefs } from "./LazyOwnedCollection";
import {
  action,
  computed,
  observable,
  reaction,
  runInAction,
  type IObservableValue,
} from "mobx";

// The four PropertyTypes that have MobX boxes and direct setters — the "flat scalar" fields.
// Used by makeModelObservable (to create boxes) and assign() (to filter writable keys).
const FLAT_PROPERTY_TYPES = new Set([
  PropertyType.Property,
  PropertyType.EphemeralProperty,
  PropertyType.Reference,
  PropertyType.ReferenceArray,
]);

export class BaseModel {
  id: string = BaseModel.storeManager?.mintId(this) ?? crypto.randomUUID();

  __mobx: { [key: string]: IObservableValue<unknown> | undefined } = {};
  __observabilityEnabled = false;
  store: IObjectPool | null = null;

  // Backed by globalThis so it survives HMR module reloads in dev mode.
  // Bundlers (webpack, Vite, etc.) re-execute modules on hot reload, which
  // resets static field initializers — but globalThis is outside the module
  // system and is never reset, keeping the live StoreManager reachable for
  // new model instances created after a reload.
  static get storeManager(): IStoreManager | null {
    return (
      (globalThis as { __syncEngineStore?: IStoreManager | null })
        .__syncEngineStore ?? null
    );
  }
  static set storeManager(sm: IStoreManager | null) {
    (
      globalThis as { __syncEngineStore?: IStoreManager | null }
    ).__syncEngineStore = sm ?? null;
  }

  /** Runtime lazy collections, keyed by property name. */
  __collections: Record<string, LazyCollectionBase> = {};

  /** Runtime BackRefs, keyed by property name. Read by @BackReference getters. */
  __backRefs: Record<string, BackRef> = {};

  private pendingChanges = new Map<string, unknown>();

  // ---------------------------------------------------------------------------
  // Change tracking
  // ---------------------------------------------------------------------------

  /**
   * Set a property value without triggering change tracking or pendingChanges.
   * Used by revert paths so that rolling back an optimistic update doesn't
   * leave the model in a dirty state.
   */
  setQuiet(propName: string, value: unknown) {
    const box = this.__mobx[propName];
    if (box != null) {
      box.set(value);
    }
    (this as Record<string, unknown>)[`__raw_${propName}`] = value;
    this.pendingChanges.delete(propName);
  }

  propertyChanged(propName: string, oldValue: unknown, newValue: unknown) {
    if (oldValue === newValue) {
      return;
    }
    const sm = BaseModel.storeManager;
    sm?.registerAtomicTouch(this);
    if (!this.pendingChanges.has(propName)) {
      const wasClean = this.pendingChanges.size === 0;
      const meta = ModelRegistry.getMetaForInstance(this);
      const propMeta = meta?.properties.get(propName);
      const serialized =
        propMeta?.serializer != null ? propMeta.serializer(oldValue) : oldValue;
      this.pendingChanges.set(propName, serialized);

      // Invalidate any OwnedCollections backed by this property so they
      // re-resolve against the updated IDs array on next access.
      if (meta != null) {
        for (const [collectionName, ownedPropMeta] of meta.properties) {
          if (
            ownedPropMeta.type === PropertyType.OwnedCollection &&
            ownedPropMeta.idsField === propName
          ) {
            this.__collections[collectionName]?.invalidate();
          }
        }
        this.maintainParentLinks(meta.name, propName, oldValue, newValue);
      }

      // Clean→dirty transition: fire after parent links are consistent so an
      // adopter materializing a draft scaffold sees correct inverse links.
      if (wasClean && sm != null && sm.hasModelTouchedHandler && meta != null) {
        sm.fireModelTouched(this, meta.name);
      }
    }
  }

  /** Forward an FK change to the pool so it can re-route inverse links. No-op
   * before the model has entered a pool. */
  private maintainParentLinks(
    modelName: string,
    propName: string,
    oldValue: unknown,
    newValue: unknown,
  ) {
    const pool = this.store;
    if (pool == null) {
      return;
    }
    const oldId = typeof oldValue === "string" ? oldValue : null;
    const newId = typeof newValue === "string" ? newValue : null;
    pool.notifyReferenceChange(this, modelName, propName, oldId, newId);
  }

  // ---------------------------------------------------------------------------
  // makeModelObservable — create MobX boxes + relationship runtime objects
  // ---------------------------------------------------------------------------

  makeModelObservable() {
    // Idempotent: re-running would replace the RefCollection /
    // BackRef / OwnedRefs runtime objects, dropping
    // their loaded items, and re-fire any non-lazy eager loads.
    if (this.__observabilityEnabled) {
      return;
    }
    this.__observabilityEnabled = true;
    const meta = ModelRegistry.getMetaForInstance(this);
    if (meta == null) {
      return;
    }

    for (const [name, prop] of meta.properties) {
      switch (prop.type) {
        // ── Flat observable properties: create MobX boxes ──
        case PropertyType.Property:
        case PropertyType.EphemeralProperty:
        case PropertyType.Reference:
        case PropertyType.ReferenceArray: {
          const rawValue = (this as Record<string, unknown>)[`__raw_${name}`];
          let currentValue: unknown = rawValue;

          // SWC (Next.js) compiles class fields using "define" semantics
          // (Object.defineProperty), creating own data properties that shadow
          // the prototype getter/setter installed by @Property. Delete them so
          // the prototype accessor is reachable for all future reads and writes.
          const ownDesc = Object.getOwnPropertyDescriptor(this, name);
          if (ownDesc != null && "value" in ownDesc) {
            if (currentValue === undefined) {
              // hydrate() hasn't run yet (new model) — preserve the class field value.
              currentValue = ownDesc.value;
            }

            delete (this as Record<string, unknown>)[name];
          }

          if (currentValue !== undefined) {
            if (this.__mobx[name] != null) {
              this.__mobx[name].set(currentValue);
            } else {
              // Create the box directly to avoid triggering propertyChanged.
              this.__mobx[name] = observable.box(currentValue, { deep: false });
              (this as Record<string, unknown>)[`__raw_${name}`] = currentValue;
            }
          }

          if (
            prop.type === PropertyType.Reference &&
            prop.lazy === false &&
            BaseModel.storeManager != null &&
            typeof currentValue === "string" &&
            currentValue !== ""
          ) {
            const sm = BaseModel.storeManager;
            const refTo = prop.referenceTo!;
            const id = currentValue;
            sm.getOrLoadById(refTo, id).catch((err) => {
              sm.emitError(err, {
                kind: "eagerReferenceLoad",
                modelName: refTo,
                id,
              });
            });
          }
          break;
        }

        // ── ReferenceCollection → create RefCollection ──
        // e.g. Team.issues → RefCollection("Issue", "teamId")
        // The collection's hydrate() stores the parent ID and computes
        // the partial index values for future IDB queries — manual
        // coveringIndexes plus auto-derived paths from the FK graph walk.
        case PropertyType.ReferenceCollection: {
          const depth =
            BaseModel.storeManager?.transientIndexDepth ??
            DEFAULT_TRANSIENT_INDEX_DEPTH;
          const derivedPaths =
            depth > 0
              ? ModelRegistry.getDerivedCoveringPaths(
                  meta.name,
                  prop.referenceTo!,
                  depth,
                )
              : [];
          const collection = new RefCollection(
            prop.referenceTo!,
            prop.inverseOf!,
            prop.coveringIndexes ?? [],
            derivedPaths,
          );
          collection.hydrate(this);

          // Wire loader from StoreManager (for async IDB/server loading)
          if (BaseModel.storeManager != null) {
            const sm = BaseModel.storeManager;
            collection.setLoader(async (modelName, queries) => {
              // Each axis is an independent IDB read; fire in parallel.
              const batches = await Promise.all(
                queries.map((q) =>
                  sm.getOrLoadCollection(modelName, q.key, q.value),
                ),
              );
              return batches.flat();
            });
            const parentModelName = meta.name;
            const parentId = this.id;
            const refTo = prop.referenceTo!;
            const isEager = prop.lazy === false;
            collection.setOnError((err) => {
              sm.emitError(err, {
                kind: isEager ? "eagerCollectionLoad" : "lazyCollectionLoad",
                modelName: refTo,
                parentModelName,
                parentId,
              });
            });
          }

          this.__collections[name] = collection;

          if (prop.lazy === false && BaseModel.storeManager != null) {
            void collection.load();
          }
          break;
        }

        // ── OwnedCollection → create OwnedRefs ──
        // e.g. Team.issues where Team has issueIds: string[]
        // The idsGetter is a live function — reads the current array each time,
        // so additions/removals to issueIds are always reflected.
        case PropertyType.OwnedCollection: {
          const idsField = prop.idsField!;
          const collection = new OwnedRefs(
            prop.referenceTo!,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            () => ((this as any)[idsField] as string[]) ?? [],
          );

          if (BaseModel.storeManager != null) {
            const sm = BaseModel.storeManager;
            collection.setLoader(async (modelName, ids) => {
              return sm.getOrLoadByIds(modelName, ids);
            });
            const refTo = prop.referenceTo!;
            collection.setOnError((err) => {
              sm.emitError(err, {
                kind: "lazyOwnedCollectionLoad",
                modelName: refTo,
              });
            });
          }

          this.__collections[name] = collection;

          if (prop.lazy === false && BaseModel.storeManager != null) {
            void collection.load();
          }
          break;
        }

        // ── BackReference → create BackRef ──
        // e.g. Issue.favorite → BackRef("Favorite", "issueId")
        case PropertyType.BackReference: {
          const backRef = new BackRef(prop.referenceTo!, prop.inverseOf!);
          backRef.hydrate(this.id);

          if (BaseModel.storeManager != null) {
            const sm = BaseModel.storeManager;
            backRef.setLoader(async (modelName, key, value) => {
              const items = await sm.getOrLoadCollection(modelName, key, value);
              return items[0] ?? null;
            });
            const refTo = prop.referenceTo!;
            const parentId = this.id;
            backRef.setOnError((err) => {
              sm.emitError(err, {
                kind: "lazyBackRefLoad",
                modelName: refTo,
                parentId,
              });
            });
          }

          this.__backRefs[name] = backRef;
          break;
        }
      }
    }

    // ── Wire @Action methods with MobX action() ──
    // Wraps the method so multiple property changes inside it are batched
    // into a single MobX transaction (one re-render, not N).
    for (const actionName of meta.actions) {
      const original = (this as Record<string, unknown>)[actionName];
      if (typeof original === "function") {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (this as any)[actionName] = action(original.bind(this));
      }
    }

    // ── Wire @Computed getters with MobX computed() ──
    // Memoizes the getter — re-evaluates only when its observed dependencies change.
    for (const compName of meta.computedProps) {
      const descriptor = Object.getOwnPropertyDescriptor(
        Object.getPrototypeOf(this),
        compName,
      );
      if (descriptor?.get != null) {
        const fn: () => unknown = descriptor.get.bind(this);
        const memo = computed(fn);
        Object.defineProperty(this, compName, {
          get: () => memo.get(),
          configurable: true,
        });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Save
  // ---------------------------------------------------------------------------

  save() {
    const meta = ModelRegistry.getMetaForInstance(this);

    if (this.store === null) {
      BaseModel.storeManager?.commitCreate(this);
      return {};
    }

    // Stamp updatedAt when there are actual changes, if the model declares it as a @Property.
    if (
      this.pendingChanges.size > 0 &&
      meta?.properties.has("updatedAt") === true
    ) {
      (this as Record<string, unknown>)["updatedAt"] = new Date();
    }

    const changes: Record<string, PropertyChange> = {};
    for (const [propName, oldSerialized] of this.pendingChanges) {
      const propMeta = meta?.properties.get(propName);
      const currentValue = (this as Record<string, unknown>)[propName];
      const newSerialized =
        propMeta?.serializer != null
          ? propMeta.serializer(currentValue)
          : currentValue;
      changes[propName] = { oldValue: oldSerialized, newValue: newSerialized };
    }
    this.pendingChanges.clear();

    if (BaseModel.storeManager != null && Object.keys(changes).length > 0) {
      BaseModel.storeManager.commitUpdate(
        this.id,
        meta?.name ?? "Unknown",
        changes,
      );
    }

    return changes;
  }

  get hasUnsavedChanges() {
    return this.pendingChanges.size > 0;
  }

  /**
   * Revert all unsaved property changes to their last-saved values.
   * Mirror of save() — where save() commits forward, this rolls back.
   */
  discardUnsavedChanges() {
    if (this.pendingChanges.size === 0) {
      return;
    }
    const meta = ModelRegistry.getMetaForInstance(this);
    const entries = Array.from(this.pendingChanges);
    runInAction(() => {
      for (const [propName, serializedOldValue] of entries) {
        const propMeta = meta?.properties.get(propName);
        const deserialized =
          propMeta?.deserializer != null
            ? propMeta.deserializer(serializedOldValue)
            : serializedOldValue;
        this.setQuiet(propName, deserialized);
      }
    });
    this.pendingChanges.clear();
  }

  /**
   * React to property changes on this model without importing MobX.
   * Use on models obtained from the pool — `objectPool.getById` / `objectPool.getAll`.
   *
   * @param selector - reads the property (or derived value) to observe
   * @param callback - fires whenever the selector result changes; receives new and previous value
   * @returns unwatch function — call it to stop observing
   */
  watch<T>(
    selector: (model: this) => T,
    callback: (newValue: T, oldValue: T) => void,
  ): () => void {
    return reaction(() => selector(this), callback);
  }

  // ---------------------------------------------------------------------------
  // Field assignment
  // ---------------------------------------------------------------------------

  /**
   * Stage a bulk field assignment without committing. Changes land in
   * `pendingChanges` and stay local until `save()` (or an enclosing
   * `StoreManager.atomic()` / `store.batch()`) flushes them, or
   * `discardUnsavedChanges()` rolls them back. This is the staging
   * primitive behind `store.<entity>.draft(...)`.
   *
   * Only `@Property`, `@EphemeralProperty`, `@Reference` (ID fields), and
   * `@ReferenceArray` fields are written — relationship objects and internals
   * are ignored.
   */
  assign(data: Record<string, unknown>) {
    const meta = ModelRegistry.getMetaForInstance(this);
    runInAction(() => {
      for (const [key, value] of Object.entries(data)) {
        if (key === "id") {
          continue;
        }
        const propMeta = meta?.properties.get(key);
        if (propMeta == null || !FLAT_PROPERTY_TYPES.has(propMeta.type)) {
          continue;
        }
        (this as Record<string, unknown>)[key] = value;
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Hydration — flat values + recursive for embedded objects
  // ---------------------------------------------------------------------------

  /** @internal */
  hydrate(data: Record<string, unknown>) {
    const meta = ModelRegistry.getMetaForInstance(this);

    // Wrap multi-field updates in a single MobX action so observers see one
    // coherent transition for SSE deltas that touch many fields at once.
    runInAction(() => {
      for (const [key, value] of Object.entries(data)) {
        if (key === "id") {
          this.id = value as string;
          continue;
        }
        const propMeta = meta?.properties.get(key);

        // Recursive hydration: if a ReferenceModel property has an embedded object,
        // create a model instance from it and put it in the pool.
        if (
          propMeta?.type === PropertyType.ReferenceModel &&
          value &&
          typeof value === "object" &&
          "id" in value
        ) {
          const nested = value as Record<string, unknown>;
          this.hydrateNestedModel(propMeta.referenceTo!, nested);
          const idKey = propMeta.idField ?? key + "Id";
          // Rebase: if the FK is being optimistically edited, keep the
          // optimistic value visible but update its stored baseline to the
          // server's value, so a later `discardUnsavedChanges()` lands on
          // the rebased server truth rather than the stale pre-edit value.
          if (this.pendingChanges.has(idKey)) {
            this.pendingChanges.set(idKey, nested.id);
          } else {
            (this as Record<string, unknown>)[`__raw_${idKey}`] = nested.id;
          }
          continue;
        }

        const deserialized =
          propMeta?.deserializer != null ? propMeta.deserializer(value) : value;

        // Rebase path mirrors UpdateTransaction.rebase: pendingChanges holds
        // the serialized baseline; an incoming server value that differs
        // from our optimistic newValue overwrites it. Echo of our own change
        // (server === optimistic) is a no-op.
        if (this.pendingChanges.has(key)) {
          const currentValue = (this as Record<string, unknown>)[key];
          const optimisticSerialized =
            propMeta?.serializer != null
              ? propMeta.serializer(currentValue)
              : currentValue;
          const serverSerialized =
            propMeta?.serializer != null
              ? propMeta.serializer(deserialized)
              : value;
          if (serverSerialized !== optimisticSerialized) {
            this.pendingChanges.set(key, serverSerialized);
          }
          continue;
        }

        const oldRawValue = (this as Record<string, unknown>)[`__raw_${key}`];
        (this as Record<string, unknown>)[`__raw_${key}`] = deserialized;
        const box = this.__mobx[key];
        if (box != null) {
          box.set(deserialized);
        }
        // box.set bypasses the prototype setter, so propertyChanged never fires
        // for delta-driven hydrates. Dispatch parent-link maintenance directly
        // so SSE-driven FK changes still wake the inverse RefCollection / BackRef.
        if (this.store != null && meta != null) {
          this.maintainParentLinks(meta.name, key, oldRawValue, deserialized);
        }
      }
    });
  }

  private hydrateNestedModel(modelName: string, data: Record<string, unknown>) {
    const pool = this.store ?? BaseModel.storeManager?.objectPool;
    if (pool == null) {
      return;
    }

    const existing = pool.getById(modelName, data.id as string);
    if (existing != null) {
      existing.hydrate(data);
      return;
    }

    const refMeta = ModelRegistry.getModelMeta(modelName);
    if (refMeta == null) {
      return;
    }

    const instance = new refMeta.ctor();
    instance.hydrate(data); // recursive
    instance.makeModelObservable();
    pool.put(modelName, instance);
  }

  // ---------------------------------------------------------------------------
  // Serialization
  // ---------------------------------------------------------------------------

  serialize(): Record<string, unknown> {
    const meta = ModelRegistry.getMetaForInstance(this);
    const out: Record<string, unknown> = {
      id: this.id,
    };
    if (meta == null) {
      return out;
    }

    for (const [name, prop] of meta.properties) {
      if (prop.type === PropertyType.EphemeralProperty) {
        continue;
      }
      if (prop.type === PropertyType.ReferenceModel) {
        continue;
      }
      if (prop.type === PropertyType.ReferenceCollection) {
        continue;
      }
      if (prop.type === PropertyType.BackReference) {
        continue;
      }
      if (prop.type === PropertyType.OwnedCollection) {
        continue;
      }

      const value = (this as Record<string, unknown>)[name];
      out[name] = prop.serializer != null ? prop.serializer(value) : value;
    }

    return out;
  }
}
