import type { IObjectPool } from "./types";
import type { LazyCollectionBase, BackRef } from "./LazyCollection";

export interface RefHolder {
  store: IObjectPool | null;
  [key: string]: unknown;
}

export interface CollectionHolder {
  __collections?: Record<string, LazyCollectionBase>;
}

export interface BackRefHolder {
  __backRefs?: Record<string, BackRef>;
}

/**
 * Install the prototype getter/setter pair that powers a singular relation.
 * The getter resolves the FK via the pool and tracks the entry so observers
 * re-run on identity swaps; the setter writes the FK from the model's id.
 *
 * Used by `@Reference` / `@LazyReference` decorators and by the schema-first
 * compiler so the runtime accessor shape is identical across both authoring
 * paths.
 */
export function installReferenceAccessor(
  prototype: object,
  key: string,
  idField: string,
  referenceTo: string,
): void {
  Object.defineProperty(prototype, key, {
    configurable: true,
    enumerable: false,
    get(this: RefHolder) {
      const id = this[idField];
      if (typeof id !== "string" || id === "") {
        return null;
      }
      this.store?.trackModel(referenceTo, id);
      return this.store?.getById(referenceTo, id) ?? null;
    },
    set(this: RefHolder, model: { id: string } | null) {
      this[idField] = model != null ? model.id : null;
    },
  });
}

/**
 * Install the prototype getter that exposes the runtime `LazyCollectionBase`
 * stored on `this.__collections[key]`. The collection itself is created
 * during `BaseModel.makeModelObservable()`.
 */
export function installCollectionAccessor(prototype: object, key: string): void {
  Object.defineProperty(prototype, key, {
    configurable: true,
    enumerable: false,
    get(this: CollectionHolder) {
      return this.__collections?.[key] ?? null;
    },
  });
}

/** Install the prototype getter for a `BackRef` runtime collection. */
export function installBackRefAccessor(prototype: object, key: string): void {
  Object.defineProperty(prototype, key, {
    configurable: true,
    enumerable: false,
    get(this: BackRefHolder) {
      return this.__backRefs?.[key] ?? null;
    },
  });
}

/**
 * Install a prototype getter that calls `fn(this)` whenever the property is
 * read. `BaseModel.makeModelObservable()` later replaces the per-instance
 * binding with a MobX `computed`, so reads are memoized once observability
 * is enabled. Used by the schema-first `extend(...)` pipeline.
 */
export function installComputedAccessor(
  prototype: object,
  key: string,
  fn: (record: object) => unknown,
): void {
  Object.defineProperty(prototype, key, {
    configurable: true,
    enumerable: false,
    get(this: object) {
      return fn(this);
    },
  });
}

/**
 * Install a prototype method that calls `fn(this, ...args)`.
 * `BaseModel.makeModelObservable()` later wraps the per-instance binding
 * with MobX `action` for write batching.
 */
export function installActionMethod(
  prototype: object,
  key: string,
  fn: (record: object, ...args: never[]) => unknown,
): void {
  Object.defineProperty(prototype, key, {
    configurable: true,
    enumerable: false,
    writable: true,
    value(this: object, ...args: never[]) {
      return fn(this, ...args);
    },
  });
}
