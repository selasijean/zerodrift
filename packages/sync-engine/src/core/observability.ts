/**
 * defineObservableProperty
 *
 * Replaces a class property with a getter/setter pair using Object.defineProperty.
 *
 * The setter does three things:
 *   1. Lazily creates a MobX observable box on `this.__mobx[propName]`
 *   2. Stores the value in the box (so MobX can track reads/writes)
 *   3. Calls `this.propertyChanged(name, oldValue, newValue)` to feed
 *      the change-tracking system that generates transactions
 *
 * Before any of that, if a wired `StoreManager` has registered field
 * transforms via `applyFieldTransforms`, the assigned value is routed
 * through `sm.applyTransform` so consumers can canonicalize input on the
 * way in. The `hasFieldTransforms` short-circuit keeps the no-config
 * setter path a single boolean read.
 *
 * The getter reads from the MobX box if it exists, otherwise returns
 * the raw stored value (for pre-bootstrap access before observability is on).
 */

import { observable } from "mobx";
import { BaseModel } from "./BaseModel";

export function defineObservableProperty(target: object, propName: string) {
  // Raw storage key — holds the value before the MobX box is created
  const rawKey = `__raw_${propName}`;

  Object.defineProperty(target, propName, {
    configurable: true,
    enumerable: true,

    // Legacy decorator target — no better type exists for prototype manipulation
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    get(this: any) {
      // If observability is active, read from the MobX box (tracked read)
      if (this.__mobx?.[propName]) {
        return this.__mobx[propName].get();
      }
      // Otherwise return the raw value (pre-bootstrap)
      return this[rawKey];
    },

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    set(this: any, newValue: any) {
      const sm = BaseModel.storeManager;
      if (sm != null && sm.hasFieldTransforms) {
        newValue = sm.applyTransform(this, propName, newValue);
      }

      const oldValue = this[propName]; // read via getter above

      // Create the __mobx container if it doesn't exist yet
      if (!this.__mobx) {
        this.__mobx = {};
      }

      // Create or update the MobX observable box
      if (!this.__mobx[propName]) {
        this.__mobx[propName] = observable.box(newValue, { deep: false });
      } else {
        this.__mobx[propName].set(newValue);
      }

      // Also store raw value for pre-observable access
      this[rawKey] = newValue;

      // Notify the change-tracking system (only after makeModelObservable())
      if (
        this.__observabilityEnabled &&
        typeof this.propertyChanged === "function"
      ) {
        this.propertyChanged(propName, oldValue, newValue);
      }
    },
  });
}
