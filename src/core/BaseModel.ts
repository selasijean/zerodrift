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

import { ModelRegistry } from "./ModelRegistry.js";
import {
  PropertyType,
  DEFAULT_TRANSIENT_INDEX_DEPTH,
  type PropertyChange,
  type IObjectPool,
  type IStoreManager,
  type ModelMeta,
} from "./types.js";
import { LazyCollectionBase, RefCollection, BackRef } from "./LazyCollection.js";
import { OwnedRefs } from "./LazyOwnedCollection.js";
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

/**
 * One live write to a field by a `StoreManager.optimistic()` operation. A
 * field accumulates a stack of these; the settlement section on `BaseModel`
 * documents how the stack resolves. See also `StoreManager.optimistic`.
 */
interface OptimisticWrite {
  /** The owning operation. */
  token: object;
  /** In-memory value just before this write — the restore target when this
   * entry rolls back off the top (patched as lower entries splice out). */
  prev: unknown;
  /** Whether the field was already pending underneath: rollback clears the
   * baseline when false, leaves it dirty for a lower writer when true. */
  wasDirtyBelow: boolean;
  /** Serialized post-mutate value, for detecting an external overwrite. */
  written?: unknown;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return (
    typeof v === "object" &&
    v !== null &&
    (Object.getPrototypeOf(v) === Object.prototype ||
      Object.getPrototypeOf(v) === null)
  );
}

/** Structural equality on serialized field values — the notion of "same
 * value" the optimistic ownership checks use. Primitives compare by
 * identity; arrays and plain objects compare recursively, because
 * array/object-producing serializers return a fresh instance per call, so
 * identity alone would misreport an unchanged value as overwritten. The
 * hydrate/rebase paths intentionally keep bare identity: a false negative
 * there only causes a harmless extra baseline rebase. */
function serializedEquals(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return (
      a.length === b.length && a.every((v, i) => serializedEquals(v, b[i]))
    );
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const aKeys = Object.keys(a);
    if (aKeys.length !== Object.keys(b).length) {
      return false;
    }
    return aKeys.every(
      (k) =>
        Object.prototype.hasOwnProperty.call(b, k) &&
        serializedEquals(a[k], b[k]),
    );
  }
  return false;
}

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

  /** Per-field stacks of live `optimistic()` writes, oldest first. Lazily
   * allocated on the first optimistic write and left `null` for the common
   * case of a model no optimistic operation ever touches; each stack is
   * deleted once its last write settles. Keyed by property name. See
   * `OptimisticWrite` and `StoreManager.optimistic`. */
  private optimisticStacks: Map<string, OptimisticWrite[]> | null = null;

  // ---------------------------------------------------------------------------
  // Change tracking
  // ---------------------------------------------------------------------------

  /**
   * Set a property value without triggering change tracking or pendingChanges.
   * Used by revert paths so that rolling back an optimistic update doesn't
   * leave the model in a dirty state.
   */
  setQuiet(propName: string, value: unknown) {
    this.writeQuiet(propName, value);
    this.pendingChanges.delete(propName);
  }

  /** Write a property value without triggering change tracking, leaving
   * `pendingChanges` untouched. */
  private writeQuiet(propName: string, value: unknown) {
    const box = this.__mobx[propName];
    if (box != null) {
      box.set(value);
    }
    (this as Record<string, unknown>)[`__raw_${propName}`] = value;
  }

  propertyChanged(propName: string, oldValue: unknown, newValue: unknown) {
    if (oldValue === newValue) {
      return;
    }
    const sm = BaseModel.storeManager;
    const wasDirty = this.pendingChanges.has(propName);
    sm?.registerAtomicTouch(this, propName, oldValue, wasDirty);
    if (!wasDirty) {
      const wasClean = this.pendingChanges.size === 0;
      const meta = ModelRegistry.getMetaForInstance(this);
      const propMeta = meta?.properties.get(propName);
      const serialized =
        propMeta?.serializer != null ? propMeta.serializer(oldValue) : oldValue;
      this.pendingChanges.set(propName, serialized);

      if (meta != null) {
        this.syncReferenceStructures(meta, propName, oldValue, newValue);
      }

      // Clean→dirty transition: fire after parent links are consistent so an
      // adopter materializing a draft scaffold sees correct inverse links.
      if (wasClean && sm != null && sm.hasModelTouchedHandler && meta != null) {
        sm.fireModelTouched(this, meta.name);
      }
    }
  }

  /** Re-derive the structures that hang off a flat field's value: invalidate
   * OwnedCollections backed by it (they re-resolve against the new IDs array)
   * and re-route inverse RefCollection/BackRef membership for an FK change.
   * Called on the forward write (`propertyChanged`) and on every revert path
   * (`discardField`, `revertField`) so rolling an edit back doesn't strand
   * inverse links pointing at the optimistic parent. */
  private syncReferenceStructures(
    meta: ModelMeta,
    propName: string,
    oldValue: unknown,
    newValue: unknown,
  ) {
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
    if (this.store === null) {
      BaseModel.storeManager?.commitCreate(this);
      return {};
    }
    return this.commitPendingFields([...this.pendingChanges.keys()]);
  }

  /**
   * Stamp `updatedAt` (when declared) and commit the named pending fields
   * in one `commitUpdate`. Every name must currently be pending. The stamp
   * goes through the setter while those entries are still pending so the
   * clean→dirty `onModelTouched` hook can't fire from a commit path.
   * `serialized` supplies already-serialized new values for fields the
   * caller has in hand (the optimistic owner-commit path), avoiding a
   * second serialize; fields absent from it are serialized fresh.
   */
  private commitPendingFields(
    fieldNames: string[],
    meta = ModelRegistry.getMetaForInstance(this),
    serialized?: Map<string, unknown>,
  ): Record<string, PropertyChange> {
    if (fieldNames.length > 0 && meta?.properties.has("updatedAt") === true) {
      (this as Record<string, unknown>)["updatedAt"] = new Date();
      if (!fieldNames.includes("updatedAt")) {
        fieldNames = [...fieldNames, "updatedAt"];
      }
    }
    const changes: Record<string, PropertyChange> = {};
    for (const propName of fieldNames) {
      changes[propName] = {
        oldValue: this.pendingChanges.get(propName),
        newValue:
          serialized != null && serialized.has(propName)
            ? serialized.get(propName)
            : this.serializeField(
                propName,
                (this as Record<string, unknown>)[propName],
                meta,
              ),
      };
      this.pendingChanges.delete(propName);
    }
    this.enqueueChanges(changes, meta);
    return changes;
  }

  /** Enqueue an already-assembled change record as one `commitUpdate`, if
   * non-empty. Shared by `commitPendingFields` and `commitSupersededField`. */
  private enqueueChanges(
    changes: Record<string, PropertyChange>,
    meta: ReturnType<typeof ModelRegistry.getMetaForInstance>,
  ) {
    if (BaseModel.storeManager != null && Object.keys(changes).length > 0) {
      BaseModel.storeManager.commitUpdate(
        this.id,
        meta?.name ?? "Unknown",
        changes,
      );
    }
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
    const names = Array.from(this.pendingChanges.keys());
    runInAction(() => {
      for (const propName of names) {
        this.discardField(propName, meta);
      }
    });
  }

  /** Revert one pending field to its (possibly SSE-rebased) baseline, clear
   * its pending entry, and re-route any inverse links the value backed. */
  private discardField(
    propName: string,
    meta: ReturnType<typeof ModelRegistry.getMetaForInstance>,
  ) {
    const deserialized = this.deserializeField(
      propName,
      this.pendingChanges.get(propName),
      meta,
    );
    this.writeReverted(propName, deserialized, meta, true);
  }

  /** Write a reverted value onto a field without change-tracking and re-route
   * the inverse links it backed. `clearPending` also drops the field's
   * pending entry (revert-to-baseline); leaving it keeps the field dirty for
   * a lower optimistic writer that still owns the baseline. */
  private writeReverted(
    propName: string,
    value: unknown,
    meta: ReturnType<typeof ModelRegistry.getMetaForInstance>,
    clearPending: boolean,
  ) {
    const old = (this as Record<string, unknown>)[propName];
    if (clearPending) {
      this.setQuiet(propName, value);
    } else {
      this.writeQuiet(propName, value);
    }
    if (meta != null) {
      this.syncReferenceStructures(meta, propName, old, value);
    }
  }

  /** @internal Serialize a field's value with its declared serializer —
   * the encoding `pendingChanges` baselines and transaction payloads use. */
  serializeField(
    propName: string,
    value: unknown,
    meta = ModelRegistry.getMetaForInstance(this),
  ): unknown {
    const propMeta = meta?.properties.get(propName);
    return propMeta?.serializer != null ? propMeta.serializer(value) : value;
  }

  private deserializeField(
    propName: string,
    value: unknown,
    meta: ReturnType<typeof ModelRegistry.getMetaForInstance>,
  ): unknown {
    const propMeta = meta?.properties.get(propName);
    return propMeta?.deserializer != null ? propMeta.deserializer(value) : value;
  }

  /** @internal Drop all staged changes without reverting values — the model
   * is now the committed truth (its current values were just enqueued). */
  clearPendingChanges() {
    this.pendingChanges.clear();
  }

  /** @internal Run `fn` in one MobX action so a multi-model settlement
   * flushes observers once. Lets StoreManager group reactions without
   * importing mobx directly. */
  static runInAction<T>(fn: () => T): T {
    return runInAction(fn);
  }

  // ---------------------------------------------------------------------------
  // optimistic() settlement — field-scoped, overlap-safe
  //
  // Each field carries a stack of live optimistic writes (oldest first); the
  // top owns the visible value. Settling one write consults the stack so
  // out-of-order commits/rollbacks of overlapping writes on the same field
  // splice correctly instead of restoring a stale value. See
  // `StoreManager.optimistic` for the settlement contract.
  // ---------------------------------------------------------------------------

  /** @internal Record operation `token`'s first write to `propName`. */
  pushOptimisticWrite(
    token: object,
    propName: string,
    prev: unknown,
    wasDirtyBelow: boolean,
  ) {
    if (this.optimisticStacks == null) {
      this.optimisticStacks = new Map();
    }
    let stack = this.optimisticStacks.get(propName);
    if (stack == null) {
      stack = [];
      this.optimisticStacks.set(propName, stack);
    }
    stack.push({ token, prev, wasDirtyBelow });
  }

  /** @internal Snapshot the serialized post-mutate value of each field this
   * operation wrote, so settlement can tell an external overwrite from our
   * own value. Called the moment mutate finishes, before anything can
   * interleave. */
  snapshotOptimisticWrites(token: object, propNames: Iterable<string>) {
    const meta = ModelRegistry.getMetaForInstance(this);
    for (const propName of propNames) {
      const entry = this.optimisticStacks
        ?.get(propName)
        ?.find((w) => w.token === token);
      if (entry != null) {
        entry.written = this.serializeField(
          propName,
          (this as Record<string, unknown>)[propName],
          meta,
        );
      }
    }
  }

  /** @internal Commit the fields operation `token` still owns. */
  commitOptimistic(token: object, propNames: Iterable<string>) {
    const meta = ModelRegistry.getMetaForInstance(this);
    // Owner-commit fields deposit their already-serialized value here so the
    // flush below doesn't serialize them a second time.
    const owned = new Map<string, unknown>();
    for (const propName of propNames) {
      this.settleOptimisticField(token, propName, "commit", meta, owned);
    }
    if (owned.size > 0) {
      this.commitPendingFields([...owned.keys()], meta, owned);
    }
  }

  /** @internal Roll back the fields operation `token` still owns. */
  rollbackOptimistic(token: object, propNames: Iterable<string>) {
    const meta = ModelRegistry.getMetaForInstance(this);
    for (const propName of propNames) {
      this.settleOptimisticField(token, propName, "rollback", meta);
    }
  }

  /** @internal Drop `token`'s write stacks for the given fields without
   * settling — used when the whole record commits as a create. */
  clearOptimisticWrites(propNames: Iterable<string>) {
    for (const propName of propNames) {
      this.optimisticStacks?.delete(propName);
    }
  }

  /** Settle one field for `token` against its write stack, resolving every
   * case (ownership, supersession, external overwrite, rollback) in place. In
   * commit mode, an owned field deposits its serialized value into `ownedOut`
   * for the caller to flush via `commitPendingFields`. */
  private settleOptimisticField(
    token: object,
    propName: string,
    mode: "commit" | "rollback",
    meta: ReturnType<typeof ModelRegistry.getMetaForInstance>,
    ownedOut?: Map<string, unknown>,
  ): void {
    const stacks = this.optimisticStacks;
    const stack = stacks?.get(propName);
    if (stacks == null || stack == null) {
      return;
    }
    const idx = stack.findIndex((w) => w.token === token);
    if (idx === -1) {
      return;
    }
    const entry = stack[idx];
    const isTop = idx === stack.length - 1;
    const currentSerialized = this.serializeField(
      propName,
      (this as Record<string, unknown>)[propName],
      meta,
    );
    const ownsVisible =
      isTop && serializedEquals(currentSerialized, entry.written);

    if (mode === "commit") {
      if (ownsVisible) {
        // Owner: this value becomes the saved truth; the rest of the stack is
        // moot. Hand the serialized value to the caller to flush.
        ownedOut?.set(propName, currentSerialized);
        stacks.delete(propName);
      } else if (isTop) {
        // A non-optimistic write changed the value under us — it wins (LWW);
        // abandon the stack and commit nothing here.
        stacks.delete(propName);
      } else {
        // Superseded by a later optimistic write, but our value did reach the
        // server: record it (baseline rebases to it) so undo/IDB reflect it
        // and a rollback of the writer above lands on our value.
        this.commitSupersededField(propName, entry.written, meta);
        this.spliceOptimisticWrite(
          stack,
          idx,
          this.deserializeField(propName, entry.written, meta),
        );
      }
      return;
    }

    // rollback
    if (ownsVisible) {
      if (entry.wasDirtyBelow) {
        this.writeReverted(propName, entry.prev, meta, false);
        // Landing back on the saved baseline makes the pending entry a no-op
        // — clear it so the field reads clean.
        if (
          serializedEquals(
            this.serializeField(propName, entry.prev, meta),
            this.pendingChanges.get(propName),
          )
        ) {
          this.pendingChanges.delete(propName);
        }
      } else {
        this.discardField(propName, meta);
      }
      stack.pop();
      if (stack.length === 0) {
        stacks.delete(propName);
      }
    } else if (isTop) {
      // Externally overwritten — the external value wins; drop the stack.
      stacks.delete(propName);
    } else {
      // Superseded: our value is already gone; the writer above inherits our
      // restore target so it falls through to what was below us.
      this.spliceOptimisticWrite(stack, idx, entry.prev);
    }
  }

  /** Remove `stack[idx]`; the entry above it (if any) inherits `patchPrev` as
   * its restore target, keeping the chain of restore values consistent. */
  private spliceOptimisticWrite(
    stack: OptimisticWrite[],
    idx: number,
    patchPrev: unknown,
  ) {
    if (idx + 1 < stack.length) {
      stack[idx + 1].prev = patchPrev;
    }
    stack.splice(idx, 1);
  }

  /** Enqueue a superseded-but-server-accepted field write as its own committed
   * change and rebase the pending baseline to it. */
  private commitSupersededField(
    propName: string,
    written: unknown,
    meta: ReturnType<typeof ModelRegistry.getMetaForInstance>,
  ) {
    const changes: Record<string, PropertyChange> = {
      [propName]: {
        oldValue: this.pendingChanges.get(propName),
        newValue: written,
      },
    };
    this.pendingChanges.set(propName, written);
    this.enqueueChanges(changes, meta);
  }

  /**
   * React to property changes on this model without importing MobX.
   * Use on models obtained from the pool — `objectPool.getById` / `objectPool.getAll`.
   * In React components, use `useWatch` from `zerodrift/react` instead.
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
    // Hydration writes bypass the property setters (box.set below), so field
    // transforms must be applied here explicitly — otherwise bootstrap / SSE /
    // create-input data would skip the canonicalization the setter path
    // guarantees. Transforms are required to be idempotent (values round-trip
    // through IDB already-transformed).
    const sm = BaseModel.storeManager;
    const transformer = sm != null && sm.hasFieldTransforms ? sm : null;

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
          const nestedId =
            transformer != null
              ? transformer.applyTransform(this, idKey, nested.id)
              : nested.id;
          // Rebase: if the FK is being optimistically edited, keep the
          // optimistic value visible but update its stored baseline to the
          // server's value, so a later `discardUnsavedChanges()` lands on
          // the rebased server truth rather than the stale pre-edit value.
          if (this.pendingChanges.has(idKey)) {
            this.pendingChanges.set(idKey, nestedId);
          } else {
            (this as Record<string, unknown>)[`__raw_${idKey}`] = nestedId;
          }
          continue;
        }

        const decoded =
          propMeta?.deserializer != null ? propMeta.deserializer(value) : value;
        // The canonical in-memory form of the server/storage value.
        const incoming =
          transformer != null
            ? transformer.applyTransform(this, key, decoded)
            : decoded;

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
              ? propMeta.serializer(incoming)
              : incoming;
          if (serverSerialized !== optimisticSerialized) {
            this.pendingChanges.set(key, serverSerialized);
          }
          continue;
        }

        const oldRawValue = (this as Record<string, unknown>)[`__raw_${key}`];
        (this as Record<string, unknown>)[`__raw_${key}`] = incoming;
        const box = this.__mobx[key];
        if (box != null) {
          box.set(incoming);
        }
        // box.set bypasses the prototype setter, so propertyChanged never fires
        // for delta-driven hydrates. Dispatch parent-link maintenance directly
        // so SSE-driven FK changes still wake the inverse RefCollection / BackRef.
        if (this.store != null && meta != null) {
          this.maintainParentLinks(meta.name, key, oldRawValue, incoming);
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
